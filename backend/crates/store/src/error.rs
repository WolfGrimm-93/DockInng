//! Errores del almacén y su conversión al error del dominio.

use engine_core::EngineError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("no encontrado: {0}")]
    NotFound(String),
    #[error("ya existe: {0}")]
    Conflict(String),
    /// La base tiene un esquema más nuevo que esta versión de DockInng: no se toca.
    #[error(
        "la base de datos es de una versión más nueva de DockInng (esquema {found}, esta versión entiende hasta {supported})"
    )]
    FutureSchema { found: u32, supported: u32 },
    #[error("error de E/S: {0}")]
    Io(String),
    #[error("error de base de datos: {0}")]
    Db(String),
    /// El llavero del sistema no está disponible o falló.
    #[error("llavero del sistema: {0}")]
    Keyring(String),
}

/// Códigos extendidos de SQLite: UNIQUE (2067) y PRIMARY KEY (1555).
const SQLITE_CONSTRAINT_UNIQUE: i32 = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY: i32 = 1555;

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        if let rusqlite::Error::SqliteFailure(f, _) = &e
            && f.code == rusqlite::ErrorCode::ConstraintViolation
        {
            // Solo la unicidad significa «ya existe»; FK, CHECK o NOT NULL son otra cosa.
            return if matches!(
                f.extended_code,
                SQLITE_CONSTRAINT_UNIQUE | SQLITE_CONSTRAINT_PRIMARYKEY
            ) {
                StoreError::Conflict("ya existe un elemento con ese nombre".into())
            } else {
                StoreError::Db(format!("restricción de integridad violada: {e}"))
            };
        }
        StoreError::Db(e.to_string())
    }
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e.to_string())
    }
}

impl From<EngineError> for StoreError {
    fn from(e: EngineError) -> Self {
        match e {
            EngineError::InvalidInput(m) => StoreError::InvalidInput(m),
            other => StoreError::InvalidInput(other.to_string()),
        }
    }
}

impl From<StoreError> for EngineError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::InvalidInput(m) => EngineError::InvalidInput(m),
            StoreError::NotFound(m) => EngineError::NotFound(m),
            StoreError::Conflict(m) => EngineError::Conflict(m),
            other => EngineError::Internal(other.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solo_unique_es_ya_existe() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE p (id INTEGER PRIMARY KEY, n TEXT UNIQUE, h INTEGER CHECK (h < 10) NOT NULL);
             CREATE TABLE c (pid INTEGER REFERENCES p(id));
             INSERT INTO p VALUES (1, 'a', 1);",
        )
        .unwrap();
        let err = |sql: &str| StoreError::from(c.execute(sql, []).unwrap_err());
        assert!(matches!(
            err("INSERT INTO p VALUES (2, 'a', 1)"),
            StoreError::Conflict(_)
        ));
        assert!(matches!(
            err("INSERT INTO p VALUES (1, 'b', 1)"),
            StoreError::Conflict(_)
        ));
        for sql in [
            "INSERT INTO p VALUES (3, 'c', 99)",
            "INSERT INTO p VALUES (4, 'd', NULL)",
            "INSERT INTO c VALUES (777)",
        ] {
            assert!(
                matches!(err(sql), StoreError::Db(m) if m.contains("integridad")),
                "{sql}"
            );
        }
    }
}
