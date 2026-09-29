//! Secretos de registros en el llavero del sistema (Secret Service: KWallet/GNOME Keyring).
//!
//! Servicio `dockinng`, usuario `registry:<uuid v7>`, valor = JSON `{"username","password"}`.
//! El secreto nunca vuelve a la UI ni a los logs; aquí solo se entrega a quien lo va a usar
//! (pull) o al llavero.

use std::collections::HashMap;
use std::sync::Mutex;

use engine_core::registry::validate_secret;
use engine_core::{RegistryAuth, Secret};
use zeroize::Zeroize;

use crate::Store;
use crate::error::StoreError;

/// Servicio bajo el que se guardan las entradas del llavero.
pub const KEYRING_SERVICE: &str = "dockinng";

/// Contrato del almacén de secretos (el llavero real o uno en memoria para tests).
pub trait SecretStore: Send + Sync {
    fn save(&self, id: &str, username: &str, secret: &Secret) -> Result<(), StoreError>;
    fn load(&self, id: &str) -> Result<Option<(String, Secret)>, StoreError>;
    fn delete(&self, id: &str) -> Result<(), StoreError>;
}

/// Serializa las credenciales al formato del llavero SIN copias intermedias del secreto (no
/// pasa por un `Value`): el `String` devuelto lo pone a cero quien lo recibe.
fn encode(username: &str, secret: &Secret) -> String {
    #[derive(serde::Serialize)]
    struct Out<'a> {
        username: &'a str,
        password: &'a str,
    }
    serde_json::to_string(&Out {
        username,
        password: secret.expose(),
    })
    .unwrap_or_default()
}

/// Interpreta el valor del llavero; el `Secret` resultante se pone a cero al soltarse.
fn decode(raw: &str) -> Result<(String, Secret), StoreError> {
    #[derive(serde::Deserialize)]
    struct In {
        username: String,
        password: Secret,
    }
    let parsed: In = serde_json::from_str(raw)
        .map_err(|_| StoreError::Keyring("entrada con formato inválido".into()))?;
    Ok((parsed.username, parsed.password))
}

fn entry_user(id: &str) -> Result<String, StoreError> {
    if !engine_core::connections::is_uuid_v7(id) {
        return Err(StoreError::InvalidInput("id de registro inválido".into()));
    }
    Ok(format!("registry:{id}"))
}

/// Llavero real del sistema.
pub struct KeyringSecrets {
    service: String,
}

impl Default for KeyringSecrets {
    fn default() -> Self {
        Self::new(KEYRING_SERVICE)
    }
}

impl KeyringSecrets {
    /// `service` distinto solo en tests (`dockinng-test`).
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_string(),
        }
    }

    fn entry(&self, id: &str) -> Result<keyring::Entry, StoreError> {
        keyring::Entry::new(&self.service, &entry_user(id)?).map_err(map_keyring)
    }
}

/// Mensaje seguro (sin contenido del secreto) para un error del llavero.
fn map_keyring(e: keyring::Error) -> StoreError {
    StoreError::Keyring(e.to_string())
}

impl SecretStore for KeyringSecrets {
    fn save(&self, id: &str, username: &str, secret: &Secret) -> Result<(), StoreError> {
        validate_secret(secret)?;
        let mut json = encode(username, secret);
        let r = self.entry(id)?.set_password(&json);
        json.zeroize();
        r.map_err(map_keyring)
    }

    fn load(&self, id: &str) -> Result<Option<(String, Secret)>, StoreError> {
        match self.entry(id)?.get_password() {
            Ok(mut raw) => {
                let r = decode(&raw).map(Some);
                raw.zeroize();
                r
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map_keyring(e)),
        }
    }

    fn delete(&self, id: &str) -> Result<(), StoreError> {
        match self.entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map_keyring(e)),
        }
    }
}

/// Almacén en memoria (tests y entornos sin llavero).
#[derive(Default)]
pub struct MemorySecrets {
    map: Mutex<HashMap<String, zeroize::Zeroizing<String>>>,
}

impl SecretStore for MemorySecrets {
    fn save(&self, id: &str, username: &str, secret: &Secret) -> Result<(), StoreError> {
        validate_secret(secret)?;
        let key = entry_user(id)?;
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, zeroize::Zeroizing::new(encode(username, secret)));
        Ok(())
    }

    fn load(&self, id: &str) -> Result<Option<(String, Secret)>, StoreError> {
        let key = entry_user(id)?;
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.get(&key).map(|raw| decode(raw)).transpose()
    }

    fn delete(&self, id: &str) -> Result<(), StoreError> {
        let key = entry_user(id)?;
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&key);
        Ok(())
    }
}

/// ¿El generador de credenciales por defecto de `keyring` es el MOCK? Sin feature de
/// plataforma `keyring` cae al mock en silencio y los secretos NO se guardarían.
pub fn default_builder_is_mock() -> bool {
    keyring::default::default_credential_builder()
        .as_any()
        .is::<keyring::mock::MockCredentialBuilder>()
}

impl Store {
    /// Guarda (o actualiza) el registro: metadatos en SQLite y secreto en el llavero. Si el
    /// llavero falla, la fila nueva se revierte para no dejar un registro sin secreto.
    pub fn registry_save(
        &self,
        secrets: &dyn SecretStore,
        server: &str,
        username: &str,
        secret: &Secret,
    ) -> Result<engine_core::RegistrySummary, StoreError> {
        validate_secret(secret)?;
        let previous =
            self.registry_by_server(&engine_core::registry::normalize_server(server)?)?;
        let row = self.registry_upsert(server, username)?;
        if let Err(e) = secrets.save(&row.id, username, secret) {
            if previous.is_none() {
                let _ = self.registry_delete(&row.id);
            }
            return Err(e);
        }
        Ok(row)
    }

    /// Borra los metadatos y el secreto del llavero.
    pub fn registry_remove(&self, secrets: &dyn SecretStore, id: &str) -> Result<(), StoreError> {
        // Primero el secreto: si el llavero falla, se conserva la fila para reintentar.
        secrets.delete(id)?;
        self.registry_delete(id)
    }

    /// Credenciales para un servidor (ya normalizado), si hay un registro guardado.
    pub fn registry_auth_for(
        &self,
        secrets: &dyn SecretStore,
        server: &str,
    ) -> Result<Option<RegistryAuth>, StoreError> {
        let Some(row) = self.registry_by_server(server)? else {
            return Ok(None);
        };
        Ok(secrets
            .load(&row.id)?
            .map(|(username, secret)| RegistryAuth {
                server: row.server.clone(),
                username,
                secret,
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn el_llavero_por_defecto_no_es_el_mock() {
        assert!(
            !default_builder_is_mock(),
            "keyring cayó al almacén MOCK: faltan las features de plataforma"
        );
    }

    #[test]
    fn ida_y_vuelta_en_memoria_con_metadatos() {
        let t = TempDir::new("sec");
        let s = Store::open(&t.0.join("d")).unwrap();
        let mem = MemorySecrets::default();
        let row = s
            .registry_save(&mem, "ghcr.io", "bob", &Secret::new("pw1"))
            .unwrap();
        let auth = s.registry_auth_for(&mem, "ghcr.io").unwrap().unwrap();
        assert_eq!(
            (auth.username.as_str(), auth.secret.expose()),
            ("bob", "pw1")
        );
        // La fila de SQLite no contiene el secreto.
        let dump = format!("{:?}", s.registry_list().unwrap());
        assert!(!dump.contains("pw1"));
        // Actualizar cambia usuario y secreto sin duplicar.
        s.registry_save(&mem, "ghcr.io", "alice", &Secret::new("pw2"))
            .unwrap();
        assert_eq!(s.registry_list().unwrap().len(), 1);
        let auth = s.registry_auth_for(&mem, "ghcr.io").unwrap().unwrap();
        assert_eq!(
            (auth.username.as_str(), auth.secret.expose()),
            ("alice", "pw2")
        );
        assert!(s.registry_auth_for(&mem, "otro.io").unwrap().is_none());
        s.registry_remove(&mem, &row.id).unwrap();
        assert!(s.registry_list().unwrap().is_empty());
        assert!(mem.load(&row.id).unwrap().is_none());
    }

    struct Failing;
    impl SecretStore for Failing {
        fn save(&self, _: &str, _: &str, _: &Secret) -> Result<(), StoreError> {
            Err(StoreError::Keyring("sin llavero".into()))
        }
        fn load(&self, _: &str) -> Result<Option<(String, Secret)>, StoreError> {
            Err(StoreError::Keyring("sin llavero".into()))
        }
        fn delete(&self, _: &str) -> Result<(), StoreError> {
            Err(StoreError::Keyring("sin llavero".into()))
        }
    }

    #[test]
    fn si_el_llavero_falla_no_queda_fila_huerfana() {
        let t = TempDir::new("secfail");
        let s = Store::open(&t.0.join("d")).unwrap();
        let err = s
            .registry_save(&Failing, "ghcr.io", "bob", &Secret::new("pw"))
            .unwrap_err();
        assert!(!err.to_string().contains("pw"));
        assert!(s.registry_list().unwrap().is_empty());
    }

    #[test]
    fn secreto_invalido_se_rechaza_sin_eco() {
        let t = TempDir::new("secinv");
        let s = Store::open(&t.0.join("d")).unwrap();
        let mem = MemorySecrets::default();
        let err = s
            .registry_save(&mem, "ghcr.io", "bob", &Secret::new("mal\nsecreto"))
            .unwrap_err();
        assert!(!err.to_string().contains("mal"));
        assert!(s.registry_list().unwrap().is_empty());
    }

    #[test]
    fn formato_del_llavero_roundtrip() {
        let raw = encode("u", &Secret::new("p\"w\\"));
        let (u, p) = decode(&raw).unwrap();
        assert_eq!((u.as_str(), p.expose()), ("u", "p\"w\\"));
        assert!(decode("no json").is_err());
        assert!(decode("{\"username\":\"a\"}").is_err());
    }

    /// Prueba viva contra el Secret Service real (puede pedir desbloqueo del llavero).
    /// Opt-in: `DOCKINNG_LIVE_KEYRING=1`. Usa el servicio `dockinng-test` y limpia al final.
    #[test]
    #[ignore = "requiere DOCKINNG_LIVE_KEYRING=1 (puede pedir desbloqueo del llavero)"]
    fn live_llavero_real() {
        if std::env::var("DOCKINNG_LIVE_KEYRING").as_deref() != Ok("1") {
            eprintln!("SKIP live_llavero_real: define DOCKINNG_LIVE_KEYRING=1");
            return;
        }
        if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
            eprintln!(
                "SKIP live_llavero_real: DBUS_SESSION_BUS_ADDRESS is unavailable (no Secret Service session)"
            );
            return;
        }
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            tokio::task::spawn_blocking(|| {
                let ks = KeyringSecrets::new("dockinng-test");
                let id = crate::new_id();
                // El valor es único por ejecución y nunca aparece en mensajes de error/log.
                let username = format!("live-{}", &id[24..]);
                let password = format!("disposable-{}", &id[24..]);
                struct Cleanup<'a> {
                    store: &'a KeyringSecrets,
                    id: String,
                }
                impl Drop for Cleanup<'_> {
                    fn drop(&mut self) {
                        let _ = self.store.delete(&self.id);
                    }
                }
                let _cleanup = Cleanup {
                    store: &ks,
                    id: id.clone(),
                };
                ks.save(&id, &username, &Secret::new(password.clone()))
                    .expect("guardar secreto live");
                let (u, p) = ks
                    .load(&id)
                    .expect("leer secreto live")
                    .expect("entrada live");
                assert_eq!(
                    (u.as_str(), p.expose()),
                    (username.as_str(), password.as_str())
                );
                ks.delete(&id).expect("borrar secreto live");
                assert!(ks.load(&id).expect("comprobar borrado").is_none());
            })
            .await
            .unwrap();
        });
    }
}
