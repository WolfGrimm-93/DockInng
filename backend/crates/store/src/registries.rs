//! Metadatos de registros de imágenes (servidor y usuario). El secreto vive en el llavero.

use engine_core::RegistrySummary;
use engine_core::registry::{normalize_server, validate_username};
use rusqlite::{OptionalExtension, params};

use crate::error::StoreError;
use crate::{Store, new_id, now_secs};

/// Tope de registros guardados.
pub const MAX_REGISTRIES: usize = 100;

impl Store {
    pub fn registry_list(&self) -> Result<Vec<RegistrySummary>, StoreError> {
        let conn = self.lock();
        let mut st = conn.prepare("SELECT id, server, username FROM registries ORDER BY server")?;
        let rows = st.query_map([], |r| {
            Ok(RegistrySummary {
                id: r.get(0)?,
                server: r.get(1)?,
                username: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn registry_get(&self, id: &str) -> Result<RegistrySummary, StoreError> {
        let conn = self.lock();
        conn.query_row(
            "SELECT id, server, username FROM registries WHERE id = ?1",
            [id],
            |r| {
                Ok(RegistrySummary {
                    id: r.get(0)?,
                    server: r.get(1)?,
                    username: r.get(2)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound("registro".into()))
    }

    /// Busca el registro de un servidor (ya normalizado).
    pub fn registry_by_server(&self, server: &str) -> Result<Option<RegistrySummary>, StoreError> {
        let conn = self.lock();
        Ok(conn
            .query_row(
                "SELECT id, server, username FROM registries WHERE server = ?1",
                [server],
                |r| {
                    Ok(RegistrySummary {
                        id: r.get(0)?,
                        server: r.get(1)?,
                        username: r.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    /// Crea o actualiza (por servidor) los metadatos y devuelve la fila.
    pub fn registry_upsert(
        &self,
        server: &str,
        username: &str,
    ) -> Result<RegistrySummary, StoreError> {
        let server = normalize_server(server)?;
        validate_username(username)?;
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM registries WHERE server = ?1",
                [&server],
                |r| r.get(0),
            )
            .optional()?;
        let id = match existing {
            Some(id) => {
                tx.execute(
                    "UPDATE registries SET username = ?1 WHERE id = ?2",
                    params![username, id],
                )?;
                id
            }
            None => {
                let n: i64 = tx.query_row("SELECT COUNT(*) FROM registries", [], |r| r.get(0))?;
                if n as usize >= MAX_REGISTRIES {
                    return Err(StoreError::InvalidInput("demasiados registros".into()));
                }
                let id = new_id();
                tx.execute(
                    "INSERT INTO registries (id, server, username, created_at) VALUES (?1,?2,?3,?4)",
                    params![id, server, username, now_secs()],
                )?;
                id
            }
        };
        tx.commit()?;
        drop(conn);
        self.registry_get(&id)
    }

    pub fn registry_delete(&self, id: &str) -> Result<(), StoreError> {
        let n = self
            .lock()
            .execute("DELETE FROM registries WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(StoreError::NotFound("registro".into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::Store;
    use crate::testutil::TempDir;
    use engine_core::connections::is_uuid_v7;

    #[test]
    fn upsert_normaliza_y_no_duplica() {
        let t = TempDir::new("reg");
        let s = Store::open(&t.0.join("d")).unwrap();
        let a = s.registry_upsert("GHCR.io", "bob").unwrap();
        assert!(is_uuid_v7(&a.id));
        assert_eq!(a.server, "ghcr.io");
        let b = s.registry_upsert("https://ghcr.io/", "alice").unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(b.username, "alice");
        assert_eq!(s.registry_list().unwrap().len(), 1);
        assert_eq!(s.registry_by_server("ghcr.io").unwrap().unwrap().id, a.id);
        assert!(s.registry_upsert("a/b", "x").is_err());
        s.registry_delete(&a.id).unwrap();
        assert!(s.registry_delete(&a.id).is_err());
    }
}
