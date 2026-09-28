//! Preferencias clave/valor con lista blanca de claves (validada aquí, no en la UI).

use engine_core::LOCAL_CONNECTION_ID;
use engine_core::connections::{BOOL_PREF_KEYS, NOTIFY_EVENT_KEYS, PREF_KEYS, is_uuid_v7};
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use crate::error::StoreError;
use crate::{Store, now_secs};

/// Tope del JSON serializado de un valor.
const MAX_VALUE_BYTES: usize = 4096;

fn check_key(key: &str) -> Result<(), StoreError> {
    if PREF_KEYS.contains(&key) {
        Ok(())
    } else {
        Err(StoreError::InvalidInput(format!(
            "preferencia desconocida: {key}"
        )))
    }
}

/// Forma estricta de las preferencias de la ventana y las notificaciones.
fn validate_shape(key: &str, value: &Value) -> Result<(), StoreError> {
    if BOOL_PREF_KEYS.contains(&key) {
        return match value {
            Value::Null | Value::Bool(_) => Ok(()),
            _ => Err(StoreError::InvalidInput(format!(
                "{key} debe ser un booleano o null"
            ))),
        };
    }
    if key == "notify_events" {
        return match value {
            Value::Null => Ok(()),
            Value::Object(map)
                if map
                    .iter()
                    .all(|(k, v)| NOTIFY_EVENT_KEYS.contains(&k.as_str()) && v.is_boolean()) =>
            {
                Ok(())
            }
            _ => Err(StoreError::InvalidInput(
                "notify_events debe ser un objeto {die, oom, unhealthy, op_done: booleano} o null"
                    .into(),
            )),
        };
    }
    Ok(())
}

impl Store {
    /// Lee una preferencia (`None` si nunca se guardó).
    pub fn prefs_get(&self, key: &str) -> Result<Option<Value>, StoreError> {
        check_key(key)?;
        let conn = self.lock();
        let raw: Option<String> = conn
            .query_row(
                "SELECT value_json FROM preferences WHERE key = ?1",
                [key],
                |r| r.get(0),
            )
            .optional()?;
        Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
    }

    /// Guarda una preferencia validando clave, tamaño y forma.
    pub fn prefs_set(&self, key: &str, value: &Value) -> Result<(), StoreError> {
        check_key(key)?;
        if key == "last_connection_id" {
            let ok = match value {
                Value::Null => true,
                Value::String(s) => s == LOCAL_CONNECTION_ID || is_uuid_v7(s),
                _ => false,
            };
            if !ok {
                return Err(StoreError::InvalidInput(
                    "last_connection_id debe ser 'local', un UUID v7 o null".into(),
                ));
            }
        }
        validate_shape(key, value)?;
        let json =
            serde_json::to_string(value).map_err(|e| StoreError::InvalidInput(e.to_string()))?;
        if json.len() > MAX_VALUE_BYTES {
            return Err(StoreError::InvalidInput("valor demasiado grande".into()));
        }
        let conn = self.lock();
        conn.execute(
            "INSERT INTO preferences (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![key, json, now_secs()],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::Store;
    use crate::testutil::TempDir;
    use serde_json::json;

    #[test]
    fn lista_blanca_y_ida_y_vuelta() {
        let t = TempDir::new("prefs");
        let s = Store::open(&t.0.join("d")).unwrap();
        assert_eq!(s.prefs_get("polling").unwrap(), None);
        s.prefs_set("polling", &json!({"ms": 5000})).unwrap();
        assert_eq!(s.prefs_get("polling").unwrap(), Some(json!({"ms": 5000})));
        assert!(s.prefs_set("otra", &json!(1)).is_err());
        assert!(s.prefs_get("legacy_groups_imported").is_err());
        assert!(s.prefs_set("last_connection_id", &json!("local")).is_ok());
        assert!(s.prefs_set("last_connection_id", &json!("../x")).is_err());
        assert!(s.prefs_set("last_connection_id", &json!(5)).is_err());
        let big = json!("x".repeat(5000));
        assert!(s.prefs_set("polling", &big).is_err());
    }

    #[test]
    fn preferencias_de_ventana_y_notificaciones_validan_la_forma() {
        let t = TempDir::new("prefs-ola3");
        let s = Store::open(&t.0.join("d")).unwrap();
        for key in [
            "notify_enabled",
            "tray_enabled",
            "close_to_tray",
            "window_decorations",
            "start_minimized",
        ] {
            assert_eq!(s.prefs_get(key).unwrap(), None);
            s.prefs_set(key, &json!(true)).unwrap();
            assert_eq!(s.prefs_get(key).unwrap(), Some(json!(true)));
            s.prefs_set(key, &json!(null)).unwrap();
            for bad in [json!("true"), json!(1), json!({}), json!([true])] {
                assert!(s.prefs_set(key, &bad).is_err(), "{key} {bad}");
            }
        }
        s.prefs_set("notify_events", &json!({"die": true, "oom": false}))
            .unwrap();
        assert!(s.prefs_set("notify_events", &json!({})).is_ok());
        for bad in [
            json!({"die": "yes"}),
            json!({"otro": true}),
            json!(true),
            json!([1]),
            json!({"die": null}),
        ] {
            assert!(s.prefs_set("notify_events", &bad).is_err(), "{bad}");
        }
    }
}
