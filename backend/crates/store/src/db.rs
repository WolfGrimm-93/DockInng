//! Apertura, permisos y migraciones (`PRAGMA user_version`) de la base SQLite.

use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::Path;

use rusqlite::functions::FunctionFlags;
use rusqlite::{Connection, OptionalExtension};

use crate::error::StoreError;
use engine_core::LOCAL_CONNECTION_ID;

/// Versión de esquema que entiende este binario.
pub const SCHEMA_VERSION: u32 = 2;

/// Función SQL con la misma minúscula que la comparación de nombres de grupo en Rust
/// (`to_lowercase`). `lower()` de SQLite solo cubre ASCII: sobre ella no se puede hacer un
/// índice único que respete "Ñandú" = "ñandú". Se registra en cada conexión.
const FN_NOMBRE_CLAVE: &str = "dockinng_lower";

/// Esquema v1. Los ids son UUID v7 (texto); `local` es el único id reservado.
const SCHEMA_V1: &str = "
CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind TEXT NOT NULL CHECK (kind IN ('local','ssh','tls')),
    host TEXT, port INTEGER, user TEXT,
    ssh_mode TEXT CHECK (ssh_mode IS NULL OR ssh_mode IN ('explicit','alias')),
    identity_kind TEXT CHECK (identity_kind IS NULL OR identity_kind IN ('agent','file')),
    identity_path TEXT,
    tls_ca TEXT, tls_cert TEXT, tls_key TEXT,
    host_key_fp TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
);
CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hue INTEGER NOT NULL CHECK (hue BETWEEN 0 AND 359),
    sort INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE group_assignments (
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    container_name TEXT NOT NULL,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (connection_id, container_name)
);
CREATE TABLE stack_hues (
    project TEXT PRIMARY KEY,
    hue INTEGER NOT NULL CHECK (hue BETWEEN 0 AND 359)
);
CREATE TABLE preferences (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE registries (
    id TEXT PRIMARY KEY,
    server TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
";

/// Crea el directorio con permisos 0700 y verifica que es propio y no es un symlink.
pub fn ensure_private_dir(dir: &Path) -> Result<(), StoreError> {
    if fs::symlink_metadata(dir).is_err() {
        DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    }
    let meta = fs::symlink_metadata(dir)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(StoreError::Io(
            "el directorio de datos no es un directorio normal".into(),
        ));
    }
    if meta.uid() != unsafe { libc::geteuid() } {
        return Err(StoreError::Io(
            "el directorio de datos no pertenece al usuario actual".into(),
        ));
    }
    // Se endurece si estaba más abierto (p. ej. creado por otra herramienta).
    if meta.mode() & 0o077 != 0 {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub fn user_version(conn: &Connection) -> Result<u32, StoreError> {
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    Ok(u32::try_from(v).unwrap_or(0))
}

/// Abre la base con pragmas seguros y aplica las migraciones pendientes.
pub fn open_and_migrate(path: &Path) -> Result<Connection, StoreError> {
    let existed = path.exists();
    let mut conn = Connection::open(path)?;
    // Archivo 0600 (y sus auxiliares WAL/SHM heredan el modo del principal al crearse).
    if !existed {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    conn.busy_timeout(std::time::Duration::from_millis(5000))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    registrar_funciones(&conn)?;

    let found = user_version(&conn)?;
    if found > SCHEMA_VERSION {
        // Base de una versión futura: no se abre ni se toca.
        return Err(StoreError::FutureSchema {
            found,
            supported: SCHEMA_VERSION,
        });
    }
    // WAL solo tras comprobar la versión (cambiar el journal ya escribe en el archivo).
    let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
    if found < SCHEMA_VERSION {
        // Copia previa antes de migrar una base con datos (versión > 0).
        if found > 0 {
            // Con WAL, parte de los datos vive aún en `-wal`: se vuelca antes de copiar.
            let _: (i64, i64, i64) =
                conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?;
            backup(path, found)?;
        }
        migrate(&mut conn, found)?;
    }
    Ok(conn)
}

/// `store.db.bak-vN`, con permisos 0600.
fn backup(path: &Path, version: u32) -> Result<(), StoreError> {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".bak-v{version}"));
    let dst = Path::new(&name);
    fs::copy(path, dst)?;
    fs::set_permissions(dst, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

/// Aplica cada migración en su propia transacción.
fn migrate(conn: &mut Connection, from: u32) -> Result<(), StoreError> {
    if from < 1 {
        let tx = conn.transaction()?;
        tx.execute_batch(SCHEMA_V1)?;
        // Fila reservada del motor local: permite asociar grupos a `local` con FK.
        tx.execute(
            "INSERT INTO connections (id, name, kind, created_at) VALUES (?1, 'Local', 'local', ?2)",
            rusqlite::params![LOCAL_CONNECTION_ID, crate::now_secs()],
        )?;
        tx.pragma_update(None, "user_version", 1)?;
        tx.commit()?;
    }
    if from < 2 {
        let tx = conn.transaction()?;
        // Índice único de nombres de grupo (sin distinguir mayúsculas, Unicode incluido).
        // Se comprueba antes si ya hay duplicados: la migración se aborta sin tocar nada
        // (la copia `.bak-vN` ya está hecha) en vez de borrar o renombrar datos del usuario.
        let duplicado: Option<String> = tx
            .query_row(
                &format!(
                    "SELECT name FROM groups GROUP BY {FN_NOMBRE_CLAVE}(name) HAVING COUNT(*) > 1 LIMIT 1"
                ),
                [],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(nombre) = duplicado {
            return Err(StoreError::Conflict(format!(
                "no se puede migrar la base: hay grupos con el mismo nombre («{nombre}»); \
                 renómbralos y vuelve a abrir DockInng. La copia de seguridad está en .bak-v{from}"
            )));
        }
        tx.execute_batch(&format!(
            "CREATE UNIQUE INDEX groups_name_key ON groups ({FN_NOMBRE_CLAVE}(name));"
        ))?;
        tx.pragma_update(None, "user_version", 2)?;
        tx.commit()?;
    }
    Ok(())
}

/// Registra `dockinng_lower` (determinista) en la conexión.
fn registrar_funciones(conn: &Connection) -> Result<(), StoreError> {
    conn.create_scalar_function(
        FN_NOMBRE_CLAVE,
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let s: String = ctx.get(0)?;
            Ok(s.to_lowercase())
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn migra_v0_a_v2_con_permisos() {
        let t = TempDir::new("mig");
        let dir = t.0.join("d");
        ensure_private_dir(&dir).unwrap();
        let path = dir.join("store.db");
        let c = open_and_migrate(&path).unwrap();
        assert_eq!(user_version(&c).unwrap(), SCHEMA_VERSION);
        let fk: i64 = c
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1);
        drop(c);
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    }

    #[test]
    fn rechaza_base_de_version_futura_sin_tocarla() {
        let t = TempDir::new("fut");
        let path = t.0.join("store.db");
        {
            let c = Connection::open(&path).unwrap();
            c.pragma_update(None, "user_version", 99).unwrap();
        }
        let before = fs::read(&path).unwrap();
        let err = open_and_migrate(&path).unwrap_err();
        assert!(matches!(err, StoreError::FutureSchema { found: 99, .. }));
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn dir_con_permisos_abiertos_se_endurece_y_symlink_se_rechaza() {
        let t = TempDir::new("perm");
        let dir = t.0.join("abierto");
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        ensure_private_dir(&dir).unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        let link = t.0.join("enlace");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert!(ensure_private_dir(&link).is_err());
    }

    #[test]
    fn la_copia_incluye_lo_que_estaba_solo_en_el_wal() {
        let t = TempDir::new("bakwal");
        let path = t.0.join("store.db");
        let conn = open_and_migrate(&path).unwrap();
        conn.execute(
            "INSERT INTO preferences (key, value_json, updated_at) VALUES ('polling', '7', 0)",
            [],
        )
        .unwrap();
        // Lo mismo que hace la migración antes de copiar.
        let _: (i64, i64, i64) = conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        backup(&path, 1).unwrap();
        // La copia sola (sin -wal) contiene el dato.
        let copy = Connection::open(t.0.join("store.db.bak-v1")).unwrap();
        let v: String = copy
            .query_row(
                "SELECT value_json FROM preferences WHERE key='polling'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, "7");
    }

    #[test]
    fn copia_de_seguridad_con_permisos_0600() {
        let t = TempDir::new("bak");
        let path = t.0.join("store.db");
        drop(open_and_migrate(&path).unwrap());
        backup(&path, 1).unwrap();
        let bak = t.0.join("store.db.bak-v1");
        assert_eq!(fs::metadata(&bak).unwrap().mode() & 0o777, 0o600);
        assert_eq!(fs::read(&bak).unwrap(), fs::read(&path).unwrap());
    }

    #[test]
    fn reabrir_no_repite_migracion() {
        let t = TempDir::new("reopen");
        let path = t.0.join("store.db");
        drop(open_and_migrate(&path).unwrap());
        let c = open_and_migrate(&path).unwrap();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM connections", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn indice_unico_de_nombres_de_grupo_respeta_unicode() {
        // B-5: ya no depende solo de la comprobación en Rust; la base rechaza "ñandú" si
        // existe "Ñandú" (lower() de SQLite no lo vería).
        let t = TempDir::new("uniq");
        let path = t.0.join("store.db");
        let c = open_and_migrate(&path).unwrap();
        let ins = |id: &str, name: &str| {
            c.execute(
                "INSERT INTO groups (id, name, hue, sort, created_at) VALUES (?1, ?2, 1, 0, 0)",
                rusqlite::params![id, name],
            )
        };
        ins("a", "Ñandú").unwrap();
        assert!(ins("b", "ñandú").is_err());
        assert!(ins("c", "ÑANDÚ").is_err());
        ins("d", "Otro").unwrap();
    }

    #[test]
    fn migracion_con_nombres_duplicados_aborta_sin_tocar_la_base() {
        let t = TempDir::new("dupmig");
        let path = t.0.join("store.db");
        {
            // Base v1 con dos grupos que el índice nuevo no admitiría.
            let c = Connection::open(&path).unwrap();
            c.execute_batch(SCHEMA_V1).unwrap();
            for (id, name) in [("a", "Ñandú"), ("b", "ñandú")] {
                c.execute(
                    "INSERT INTO groups (id, name, hue, sort, created_at) VALUES (?1, ?2, 1, 0, 0)",
                    rusqlite::params![id, name],
                )
                .unwrap();
            }
            c.pragma_update(None, "user_version", 1).unwrap();
        }
        let err = open_and_migrate(&path).unwrap_err();
        assert!(matches!(err, StoreError::Conflict(_)), "{err:?}");
        let c = Connection::open(&path).unwrap();
        assert_eq!(user_version(&c).unwrap(), 1, "la versión no sube");
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM groups", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2, "no se borra ni renombra nada");
        assert!(
            t.0.join("store.db.bak-v1").exists(),
            "la copia previa se conserva"
        );
    }
}
