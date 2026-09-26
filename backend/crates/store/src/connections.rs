//! Perfiles de conexión (SSH/TLS): solo metadatos y RUTAS, nunca contenido de llaves.

use engine_core::connections::validate_spec;
use engine_core::{ConnSpec, ConnectionProfile, LOCAL_CONNECTION_ID, SshIdentity, SshMode};
use rusqlite::{OptionalExtension, Row, params};

use crate::error::StoreError;
use crate::{Store, new_id, now_secs};

const COLUMNS: &str = "id, kind, name, host, port, user, ssh_mode, identity_kind, identity_path, \
                       tls_ca, tls_cert, tls_key, host_key_fp";

/// Reconstruye el perfil desde una fila; `None` si la fila es inconsistente.
fn profile_from_row(r: &Row<'_>) -> rusqlite::Result<Option<ConnectionProfile>> {
    let id: String = r.get(0)?;
    let kind: String = r.get(1)?;
    let name: String = r.get(2)?;
    let host: Option<String> = r.get(3)?;
    let port: Option<i64> = r.get(4)?;
    let user: Option<String> = r.get(5)?;
    let ssh_mode: Option<String> = r.get(6)?;
    let identity_kind: Option<String> = r.get(7)?;
    let identity_path: Option<String> = r.get(8)?;
    let (ca, cert, key): (Option<String>, Option<String>, Option<String>) =
        (r.get(9)?, r.get(10)?, r.get(11)?);
    let host_key_fp: Option<String> = r.get(12)?;
    let (Some(host), Some(port)) = (host, port) else {
        return Ok(None);
    };
    let port = u32::try_from(port).unwrap_or(0);
    let spec = match kind.as_str() {
        "ssh" => ConnSpec::Ssh {
            name,
            host,
            port,
            user: user.unwrap_or_default(),
            mode: if ssh_mode.as_deref() == Some("alias") {
                SshMode::Alias
            } else {
                SshMode::Explicit
            },
            identity: match (identity_kind.as_deref(), identity_path) {
                (Some("file"), Some(path)) => SshIdentity::File { path },
                _ => SshIdentity::Agent,
            },
        },
        "tls" => {
            let (Some(ca_path), Some(cert_path), Some(key_path)) = (ca, cert, key) else {
                return Ok(None);
            };
            ConnSpec::Tls {
                name,
                host,
                port,
                ca_path,
                cert_path,
                key_path,
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(ConnectionProfile {
        id,
        spec,
        remote: true,
        host_key_fp,
        simulated: false,
    }))
}

/// Fila previa de un perfil: id, host, puerto y huella de confianza.
type ExistingRow = (String, Option<String>, Option<i64>, Option<String>);

impl Store {
    /// Perfiles guardados (sin el motor local integrado), por nombre.
    pub fn connection_list(&self) -> Result<Vec<ConnectionProfile>, StoreError> {
        let conn = self.lock();
        let mut st = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM connections WHERE kind <> 'local' ORDER BY name COLLATE NOCASE"
        ))?;
        let rows = st.query_map([], profile_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            if let Some(p) = row? {
                out.push(p);
            }
        }
        Ok(out)
    }

    pub fn connection_get(&self, id: &str) -> Result<ConnectionProfile, StoreError> {
        let conn = self.lock();
        let found = conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM connections WHERE id = ?1 AND kind <> 'local'"),
                [id],
                profile_from_row,
            )
            .optional()?
            .flatten();
        found.ok_or_else(|| StoreError::NotFound("conexión".into()))
    }

    /// Crea un perfil (`id = None`) o edita el existente `id`. Un nombre ya usado por OTRA
    /// conexión es `Conflict` (nunca se pisa en silencio: para editar hay que pasar el id).
    /// Si cambia el destino (host o puerto) la huella de confianza se descarta.
    pub fn connection_save(
        &self,
        spec: &ConnSpec,
        id: Option<&str>,
    ) -> Result<ConnectionProfile, StoreError> {
        validate_spec(spec)?;
        // Los perfiles guardados solo existen para destinos remotos; el nombre del motor
        // local integrado queda reservado.
        if spec.name().trim().eq_ignore_ascii_case("local") {
            return Err(StoreError::Conflict(
                "el nombre «Local» está reservado para el motor local".into(),
            ));
        }
        let name = spec.name().trim().to_string();
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let row = |r: &Row<'_>| -> rusqlite::Result<ExistingRow> {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        };
        let by_name: Option<ExistingRow> = tx
            .query_row(
                "SELECT id, host, port, host_key_fp FROM connections WHERE name = ?1 COLLATE NOCASE",
                [&name],
                row,
            )
            .optional()?;
        let previous: Option<ExistingRow> = match id {
            Some(i) => Some(
                tx.query_row(
                    "SELECT id, host, port, host_key_fp FROM connections WHERE id = ?1 AND kind <> 'local'",
                    [i],
                    row,
                )
                .optional()?
                .ok_or_else(|| StoreError::NotFound("conexión".into()))?,
            ),
            None => None,
        };
        if let Some(n) = &by_name
            && previous.as_ref().is_none_or(|p| p.0 != n.0)
        {
            return Err(StoreError::Conflict(
                "ya existe otra conexión con ese nombre (para editarla usa su id)".into(),
            ));
        }
        let id = previous
            .as_ref()
            .map(|e| e.0.clone())
            .unwrap_or_else(new_id);
        let keep_fp = previous.as_ref().and_then(|(_, h, p, fp)| {
            (h.as_deref() == Some(spec.host()) && *p == Some(i64::from(spec.port())))
                .then(|| fp.clone())
                .flatten()
        });
        let (kind, user, mode, ikind, ipath, ca, cert, key) = match spec {
            ConnSpec::Ssh {
                user,
                mode,
                identity,
                ..
            } => {
                let (ik, ip) = match identity {
                    SshIdentity::Agent => ("agent", None),
                    SshIdentity::File { path } => ("file", Some(path.clone())),
                };
                (
                    "ssh",
                    Some(user.clone()),
                    Some(if *mode == SshMode::Alias {
                        "alias"
                    } else {
                        "explicit"
                    }),
                    Some(ik),
                    ip,
                    None,
                    None,
                    None,
                )
            }
            ConnSpec::Tls {
                ca_path,
                cert_path,
                key_path,
                ..
            } => (
                "tls",
                None,
                None,
                None,
                None,
                Some(ca_path.clone()),
                Some(cert_path.clone()),
                Some(key_path.clone()),
            ),
        };
        tx.execute(
            "INSERT INTO connections
               (id, name, kind, host, port, user, ssh_mode, identity_kind, identity_path,
                tls_ca, tls_cert, tls_key, host_key_fp, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, kind=excluded.kind, host=excluded.host, port=excluded.port, user=excluded.user,
                ssh_mode=excluded.ssh_mode, identity_kind=excluded.identity_kind,
                identity_path=excluded.identity_path, tls_ca=excluded.tls_ca,
                tls_cert=excluded.tls_cert, tls_key=excluded.tls_key,
                host_key_fp=excluded.host_key_fp",
            params![
                id,
                name,
                kind,
                spec.host(),
                i64::from(spec.port()),
                user,
                mode,
                ikind,
                ipath,
                ca,
                cert,
                key,
                keep_fp,
                now_secs()
            ],
        )?;
        tx.commit()?;
        drop(conn);
        self.connection_get(&id)
    }

    /// Guarda la huella de la clave de servidor en la que se confió.
    pub fn connection_set_host_key_fp(&self, id: &str, fp: &str) -> Result<(), StoreError> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE connections SET host_key_fp = ?1 WHERE id = ?2 AND kind = 'ssh'",
            params![fp, id],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound("conexión".into()));
        }
        Ok(())
    }

    /// Marca la conexión como usada ahora.
    pub fn connection_touch(&self, id: &str) -> Result<(), StoreError> {
        self.lock().execute(
            "UPDATE connections SET last_used_at = ?1 WHERE id = ?2",
            params![now_secs(), id],
        )?;
        Ok(())
    }

    /// Borra el perfil (y sus asignaciones de grupo por cascada). El local no se borra.
    pub fn connection_delete(&self, id: &str) -> Result<(), StoreError> {
        if id == LOCAL_CONNECTION_ID {
            return Err(StoreError::InvalidInput(
                "el motor local no se puede borrar".into(),
            ));
        }
        let conn = self.lock();
        let n = conn.execute("DELETE FROM connections WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(StoreError::NotFound("conexión".into()));
        }
        // Si era la última usada, se olvida (el arranque es siempre local).
        conn.execute(
            "DELETE FROM preferences WHERE key = 'last_connection_id' AND value_json = ?1",
            [serde_json::Value::String(id.to_string()).to_string()],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::Store;
    use crate::StoreError;
    use crate::testutil::TempDir;
    use engine_core::connections::is_uuid_v7;
    use engine_core::{ConnSpec, GroupOp, SshIdentity, SshMode};

    fn ssh(name: &str, host: &str) -> ConnSpec {
        ConnSpec::Ssh {
            name: name.into(),
            host: host.into(),
            port: 22,
            user: "deploy".into(),
            mode: SshMode::Explicit,
            identity: SshIdentity::File {
                path: "/k/id".into(),
            },
        }
    }

    fn store() -> (TempDir, Store) {
        let t = TempDir::new("conn");
        let s = Store::open(&t.0.join("d")).unwrap();
        (t, s)
    }

    #[test]
    fn guardar_listar_y_recuperar() {
        let (_t, s) = store();
        assert!(s.connection_list().unwrap().is_empty());
        let p = s.connection_save(&ssh("prod", "a.example"), None).unwrap();
        assert!(is_uuid_v7(&p.id));
        assert!(p.remote && !p.simulated);
        assert_eq!(s.connection_list().unwrap(), vec![p.clone()]);
        assert_eq!(s.connection_get(&p.id).unwrap(), p);
        let tls = ConnSpec::Tls {
            name: "tls1".into(),
            host: "h.example".into(),
            port: 2376,
            ca_path: "/c/ca.pem".into(),
            cert_path: "/c/cert.pem".into(),
            key_path: "/c/key.pem".into(),
        };
        let t = s.connection_save(&tls, None).unwrap();
        assert_eq!(t.spec, tls);
        assert_eq!(s.connection_list().unwrap().len(), 2);
    }

    #[test]
    fn editar_por_nombre_conserva_id_y_huella_solo_si_mismo_destino() {
        let (_t, s) = store();
        let p = s.connection_save(&ssh("prod", "a.example"), None).unwrap();
        s.connection_set_host_key_fp(&p.id, "SHA256:abc").unwrap();
        let same = s
            .connection_save(&ssh("PROD", "a.example"), Some(&p.id))
            .unwrap();
        assert_eq!(same.id, p.id);
        assert_eq!(same.host_key_fp.as_deref(), Some("SHA256:abc"));
        let moved = s
            .connection_save(&ssh("prod", "b.example"), Some(&p.id))
            .unwrap();
        assert_eq!(moved.id, p.id);
        assert_eq!(moved.host_key_fp, None);
    }

    #[test]
    fn nombre_duplicado_es_conflicto_y_no_pisa_en_silencio() {
        let (_t, s) = store();
        let a = s.connection_save(&ssh("prod", "a.example"), None).unwrap();
        // La columna es NOCASE: «Web» y «web» no pueden coexistir.
        s.connection_save(&ssh("Web", "w.example"), None).unwrap();
        assert!(matches!(
            s.connection_save(&ssh("wEB", "x.example"), None),
            Err(StoreError::Conflict(_))
        ));
        // Crear con un nombre ya usado (sin importar mayúsculas): conflicto, y el original intacto.
        assert!(matches!(
            s.connection_save(&ssh("PROD", "otro.example"), None),
            Err(StoreError::Conflict(_))
        ));
        assert_eq!(s.connection_get(&a.id).unwrap().spec.host(), "a.example");
        // Editar otra conexión con el nombre de la primera: conflicto.
        let b = s.connection_save(&ssh("dev", "b.example"), None).unwrap();
        assert!(matches!(
            s.connection_save(&ssh("prod", "b.example"), Some(&b.id)),
            Err(StoreError::Conflict(_))
        ));
        // Editar con id inexistente: no encontrado. Renombrar con su id: permitido.
        assert!(matches!(
            s.connection_save(&ssh("x", "b.example"), Some("no-existe")),
            Err(StoreError::NotFound(_))
        ));
        let renamed = s
            .connection_save(&ssh("staging", "b.example"), Some(&b.id))
            .unwrap();
        assert_eq!(
            (renamed.id.as_str(), renamed.spec.name()),
            (b.id.as_str(), "staging")
        );
    }

    #[test]
    fn nombre_local_reservado_y_validacion() {
        let (_t, s) = store();
        assert!(s.connection_save(&ssh("local", "a.example"), None).is_err());
        assert!(
            s.connection_save(&ssh("ok", "-oProxyCommand=x"), None)
                .is_err()
        );
        assert!(s.connection_delete("local").is_err());
    }

    #[test]
    fn borrar_conexion_borra_sus_asignaciones() {
        let (_t, s) = store();
        let p = s.connection_save(&ssh("prod", "a.example"), None).unwrap();
        let g = s
            .groups_mutate(GroupOp::CreateGroup {
                name: "G".into(),
                hue: None,
            })
            .unwrap()
            .groups[0]
            .id
            .clone();
        for conn in [p.id.as_str(), "local"] {
            s.groups_mutate(GroupOp::Assign {
                connection_id: conn.into(),
                names: vec!["web".into()],
                group_id: Some(g.clone()),
            })
            .unwrap();
        }
        assert_eq!(s.groups_load().unwrap().assignments.len(), 2);
        s.connection_delete(&p.id).unwrap();
        let snap = s.groups_load().unwrap();
        assert_eq!(snap.assignments.len(), 1);
        assert_eq!(snap.assignments[0].connection_id, "local");
        assert!(s.connection_delete(&p.id).is_err());
    }
}
