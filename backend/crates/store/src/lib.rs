//! Persistencia local de DockInng: SQLite (grupos, perfiles de conexión, preferencias y
//! metadatos de registros) y el llavero del sistema (secretos de registros).
//!
//! El acceso es síncrono sobre un `Mutex<Connection>`; la app lo invoca desde
//! `spawn_blocking`. Todos los ids generados son UUID v7 (excepción documentada:
//! `LOCAL_CONNECTION_ID`, el motor local integrado). Nunca se guarda el contenido de una
//! llave privada: solo rutas.

mod connections;
mod db;
mod error;
mod groups;
mod prefs;
mod registries;
pub mod secrets;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

pub use error::StoreError;
pub use secrets::{KeyringSecrets, MemorySecrets, SecretStore, default_builder_is_mock};

/// Nombre del archivo de la base de datos dentro del directorio de datos.
pub const DB_FILE: &str = "store.db";

/// Almacén local. Se comparte como `Arc<Store>`.
pub struct Store {
    conn: Mutex<Connection>,
    data_dir: PathBuf,
}

/// Directorio de datos: `DOCKINNG_DATA_DIR` (tests), `$XDG_DATA_HOME/dockinng` o
/// `~/.local/share/dockinng`. Debe ser una ruta absoluta.
pub fn default_data_dir() -> Result<PathBuf, StoreError> {
    let env_abs = |name: &str| {
        std::env::var_os(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
    };
    if let Some(dir) = env_abs("DOCKINNG_DATA_DIR") {
        return Ok(dir);
    }
    if let Some(x) = env_abs("XDG_DATA_HOME") {
        return Ok(x.join("dockinng"));
    }
    let home = env_abs("HOME").ok_or_else(|| StoreError::Io("HOME no está definido".into()))?;
    Ok(home.join(".local/share/dockinng"))
}

impl Store {
    /// Abre (y migra) el almacén en el directorio de datos por defecto.
    pub fn open_default() -> Result<Self, StoreError> {
        Self::open(&default_data_dir()?)
    }

    /// Abre (y migra) el almacén en `data_dir`, creándolo con permisos 0700.
    pub fn open(data_dir: &Path) -> Result<Self, StoreError> {
        db::ensure_private_dir(data_dir)?;
        let path = data_dir.join(DB_FILE);
        let conn = db::open_and_migrate(&path)?;
        Ok(Self {
            conn: Mutex::new(conn),
            data_dir: data_dir.to_path_buf(),
        })
    }

    /// Directorio de datos (allí vive también el `known_hosts` propio).
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Ruta del `known_hosts` propio de DockInng (nunca se usa `~/.ssh/known_hosts`).
    pub fn known_hosts_path(&self) -> PathBuf {
        self.data_dir.join("known_hosts")
    }

    /// Versión del esquema aplicada (`PRAGMA user_version`).
    pub fn schema_version(&self) -> Result<u32, StoreError> {
        let conn = self.lock();
        db::user_version(&conn)
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        // Un pánico previo no deja la base inconsistente (cada operación es transaccional).
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Segundos desde la época Unix: la misma función que el resto de la base (`engine_core`).
pub(crate) use engine_core::now_unix_secs as now_secs;

/// Id nuevo (UUID v7).
pub(crate) fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::PathBuf;

    /// Directorio temporal único, borrado al soltarse.
    pub struct TempDir(pub PathBuf);

    impl TempDir {
        pub fn new(tag: &str) -> Self {
            let p =
                std::env::temp_dir().join(format!("dockinng-test-store-{tag}-{}", super::new_id()));
            std::fs::create_dir_all(&p).expect("crear tempdir");
            Self(p)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
