//! Usuarios del servidor web (modo multiusuario). La app de escritorio y la CLI no usan esta
//! tabla: corren con la confianza del usuario del sistema operativo local.

use engine_core::Role;
use rusqlite::{OptionalExtension, Row, params};

use crate::error::StoreError;
use crate::{Store, new_id, now_secs};

const COLUMNS: &str = "id, username, password_hash, role, created_at";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserRecord {
    pub id: String,
    pub username: String,
    pub password_hash: String,
    pub role: Role,
    pub created_at: i64,
}

/// Reconstruye el usuario desde una fila; `None` si el rol guardado ya no es válido (no
/// debería pasar: la columna tiene un `CHECK`, pero se cubre por si una base vieja lo pierde).
fn user_from_row(r: &Row<'_>) -> rusqlite::Result<Option<UserRecord>> {
    let id: String = r.get(0)?;
    let username: String = r.get(1)?;
    let password_hash: String = r.get(2)?;
    let role: String = r.get(3)?;
    let created_at: i64 = r.get(4)?;
    let Some(role) = Role::parse(&role) else {
        return Ok(None);
    };
    Ok(Some(UserRecord {
        id,
        username,
        password_hash,
        role,
        created_at,
    }))
}

/// Por qué una sentencia condicional no cambió nada: el usuario no existe o es el último admin.
fn no_change_reason(conn: &rusqlite::Connection, id: &str) -> StoreError {
    let exists = conn
        .query_row("SELECT 1 FROM users WHERE id = ?1", params![id], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some();
    if exists {
        StoreError::Conflict("no se puede dejar el sistema sin ningún administrador".into())
    } else {
        StoreError::NotFound(format!("usuario «{id}»"))
    }
}

impl Store {
    /// Crea un usuario nuevo. `password_hash` ya viene calculado (ver `password::hash_password`):
    /// este módulo no sabe de Argon2, solo de persistencia.
    pub fn user_create(
        &self,
        username: &str,
        password_hash: &str,
        role: Role,
    ) -> Result<UserRecord, StoreError> {
        let conn = self.lock();
        let id = new_id();
        let created_at = now_secs();
        conn.execute(
            "INSERT INTO users (id, username, password_hash, role, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, username, password_hash, role.as_str(), created_at],
        )?;
        Ok(UserRecord {
            id,
            username: username.to_string(),
            password_hash: password_hash.to_string(),
            role,
            created_at,
        })
    }

    pub fn user_by_username(&self, username: &str) -> Result<Option<UserRecord>, StoreError> {
        let conn = self.lock();
        Ok(conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM users WHERE username = ?1 COLLATE NOCASE"),
                params![username],
                user_from_row,
            )
            .optional()?
            .flatten())
    }

    pub fn user_by_id(&self, id: &str) -> Result<Option<UserRecord>, StoreError> {
        let conn = self.lock();
        Ok(conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM users WHERE id = ?1"),
                params![id],
                user_from_row,
            )
            .optional()?
            .flatten())
    }

    /// Todos los usuarios, por nombre. Nunca filtra el `password_hash` (eso es cosa de quien
    /// lo sirva por HTTP, no de este módulo).
    pub fn user_list(&self) -> Result<Vec<UserRecord>, StoreError> {
        let conn = self.lock();
        let mut st =
            conn.prepare(&format!("SELECT {COLUMNS} FROM users ORDER BY username COLLATE NOCASE"))?;
        let rows = st.query_map([], user_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            if let Some(u) = row? {
                out.push(u);
            }
        }
        Ok(out)
    }

    /// Cuántos usuarios hay (para decidir si hace falta el administrador inicial).
    pub fn user_count(&self) -> Result<i64, StoreError> {
        let conn = self.lock();
        Ok(conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?)
    }

    /// Cuántos administradores hay (para no dejar el sistema sin ninguno).
    pub fn user_admin_count(&self) -> Result<i64, StoreError> {
        let conn = self.lock();
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM users WHERE role = 'admin'",
            [],
            |r| r.get(0),
        )?)
    }

    pub fn user_set_role(&self, id: &str, role: Role) -> Result<(), StoreError> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE users SET role = ?1 WHERE id = ?2",
            params![role.as_str(), id],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound(format!("usuario «{id}»")));
        }
        Ok(())
    }

    /// Cambia el rol sin poder dejar el sistema sin administradores: la comprobación y el cambio
    /// son UNA sola sentencia (atómica), así que dos peticiones simultáneas no pueden degradar a
    /// los dos últimos admins. `Conflict` si dejaría cero; `NotFound` si no existe.
    pub fn user_set_role_keeping_admin(&self, id: &str, role: Role) -> Result<(), StoreError> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE users SET role = ?1 WHERE id = ?2 AND (role <> 'admin' OR ?1 = 'admin' \
             OR (SELECT COUNT(*) FROM users WHERE role = 'admin') > 1)",
            params![role.as_str(), id],
        )?;
        if n == 0 {
            return Err(no_change_reason(&conn, id));
        }
        Ok(())
    }

    /// Borra sin poder dejar el sistema sin administradores (misma garantía atómica que
    /// `user_set_role_keeping_admin`).
    pub fn user_delete_keeping_admin(&self, id: &str) -> Result<(), StoreError> {
        let conn = self.lock();
        let n = conn.execute(
            "DELETE FROM users WHERE id = ?1 AND (role <> 'admin' \
             OR (SELECT COUNT(*) FROM users WHERE role = 'admin') > 1)",
            params![id],
        )?;
        if n == 0 {
            return Err(no_change_reason(&conn, id));
        }
        Ok(())
    }

    pub fn user_set_password(&self, id: &str, password_hash: &str) -> Result<(), StoreError> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE users SET password_hash = ?1 WHERE id = ?2",
            params![password_hash, id],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound(format!("usuario «{id}»")));
        }
        Ok(())
    }

    pub fn user_delete(&self, id: &str) -> Result<(), StoreError> {
        let conn = self.lock();
        let n = conn.execute("DELETE FROM users WHERE id = ?1", params![id])?;
        if n == 0 {
            return Err(StoreError::NotFound(format!("usuario «{id}»")));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn store() -> (TempDir, Store) {
        let t = TempDir::new("users");
        let s = Store::open(&t.0).unwrap();
        (t, s)
    }

    #[test]
    fn crea_busca_y_lista_usuarios() {
        let (_t, s) = store();
        let u = s.user_create("ana", "hash-ana", Role::Admin).unwrap();
        assert_eq!(u.username, "ana");
        assert_eq!(u.role, Role::Admin);

        let found = s.user_by_username("ana").unwrap().unwrap();
        assert_eq!(found.id, u.id);
        // Búsqueda insensible a mayúsculas.
        assert!(s.user_by_username("ANA").unwrap().is_some());
        assert!(s.user_by_username("nadie").unwrap().is_none());

        let by_id = s.user_by_id(&u.id).unwrap().unwrap();
        assert_eq!(by_id.username, "ana");
        assert!(s.user_by_id("no-existe").unwrap().is_none());

        s.user_create("beto", "hash-beto", Role::Viewer).unwrap();
        let listado = s.user_list().unwrap();
        assert_eq!(
            listado.iter().map(|u| u.username.as_str()).collect::<Vec<_>>(),
            vec!["ana", "beto"]
        );
    }

    #[test]
    fn nombre_de_usuario_duplicado_es_conflicto() {
        let (_t, s) = store();
        s.user_create("ana", "h1", Role::Admin).unwrap();
        let err = s.user_create("ANA", "h2", Role::Viewer).unwrap_err();
        assert!(matches!(err, StoreError::Conflict(_)), "{err:?}");
    }

    #[test]
    fn cuenta_usuarios_y_administradores() {
        let (_t, s) = store();
        assert_eq!(s.user_count().unwrap(), 0);
        assert_eq!(s.user_admin_count().unwrap(), 0);
        let a = s.user_create("ana", "h1", Role::Admin).unwrap();
        s.user_create("beto", "h2", Role::Operator).unwrap();
        assert_eq!(s.user_count().unwrap(), 2);
        assert_eq!(s.user_admin_count().unwrap(), 1);
        s.user_set_role(&a.id, Role::Viewer).unwrap();
        assert_eq!(s.user_admin_count().unwrap(), 0);
    }

    #[test]
    fn cambia_rol_y_contrasena() {
        let (_t, s) = store();
        let u = s.user_create("ana", "h1", Role::Viewer).unwrap();
        s.user_set_role(&u.id, Role::Operator).unwrap();
        assert_eq!(
            s.user_by_id(&u.id).unwrap().unwrap().role,
            Role::Operator
        );
        s.user_set_password(&u.id, "h2").unwrap();
        assert_eq!(s.user_by_id(&u.id).unwrap().unwrap().password_hash, "h2");
    }

    #[test]
    fn operar_sobre_usuario_inexistente_es_not_found() {
        let (_t, s) = store();
        assert!(matches!(
            s.user_set_role("nope", Role::Admin).unwrap_err(),
            StoreError::NotFound(_)
        ));
        assert!(matches!(
            s.user_set_password("nope", "h").unwrap_err(),
            StoreError::NotFound(_)
        ));
        assert!(matches!(
            s.user_delete("nope").unwrap_err(),
            StoreError::NotFound(_)
        ));
    }

    #[test]
    fn borra_usuario() {
        let (_t, s) = store();
        let u = s.user_create("ana", "h1", Role::Admin).unwrap();
        s.user_delete(&u.id).unwrap();
        assert!(s.user_by_id(&u.id).unwrap().is_none());
        assert_eq!(s.user_count().unwrap(), 0);
    }

    #[test]
    fn no_se_puede_degradar_ni_borrar_al_ultimo_admin() {
        let (_t, s) = store();
        let a = s.user_create("ana", "h", Role::Admin).unwrap();
        let v = s.user_create("beto", "h", Role::Viewer).unwrap();
        assert!(matches!(
            s.user_set_role_keeping_admin(&a.id, Role::Viewer),
            Err(StoreError::Conflict(_))
        ));
        assert!(matches!(
            s.user_delete_keeping_admin(&a.id),
            Err(StoreError::Conflict(_))
        ));
        assert_eq!(s.user_admin_count().unwrap(), 1);
        // Con un segundo admin sí se puede, y un no-admin siempre.
        s.user_set_role_keeping_admin(&v.id, Role::Admin).unwrap();
        s.user_set_role_keeping_admin(&a.id, Role::Viewer).unwrap();
        s.user_delete_keeping_admin(&a.id).unwrap();
        assert_eq!(s.user_admin_count().unwrap(), 1);
        assert!(matches!(
            s.user_delete_keeping_admin("no-existe"),
            Err(StoreError::NotFound(_))
        ));
        assert!(matches!(
            s.user_set_role_keeping_admin("no-existe", Role::Viewer),
            Err(StoreError::NotFound(_))
        ));
    }

    #[test]
    fn dos_admins_degradandose_a_la_vez_nunca_dejan_cero() {
        for ronda in 0..20 {
            let (_t, s) = store();
            let s = std::sync::Arc::new(s);
            let a = s.user_create("ana", "h", Role::Admin).unwrap();
            let b = s.user_create("beto", "h", Role::Admin).unwrap();
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let hilos: Vec<_> = [a.id.clone(), b.id.clone()]
                .into_iter()
                .map(|id| {
                    let (s, barrier) = (s.clone(), barrier.clone());
                    std::thread::spawn(move || {
                        barrier.wait();
                        s.user_set_role_keeping_admin(&id, Role::Viewer).is_ok()
                    })
                })
                .collect();
            let exitos = hilos.into_iter().map(|h| h.join().unwrap()).filter(|ok| *ok).count();
            assert_eq!(exitos, 1, "ronda {ronda}");
            assert_eq!(s.user_admin_count().unwrap(), 1, "ronda {ronda}");
        }
    }
}
