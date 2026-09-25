use thiserror::Error;

use crate::connection::ConnectionCause;

/// Errores del motor, independientes del cliente concreto.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EngineError {
    /// No se pudo conectar con el daemon (socket ausente, sin permisos, daemon apagado).
    #[error("no se pudo conectar con el motor: {message}")]
    Connection {
        cause: ConnectionCause,
        message: String,
    },
    /// HTTP 404.
    #[error("no encontrado: {0}")]
    NotFound(String),
    /// HTTP 409 (recurso en uso, contenedor corriendo sin force, etc.).
    #[error("conflicto: {0}")]
    Conflict(String),
    /// HTTP 400 o validación propia (ids con caracteres raros, límites).
    #[error("entrada inválida: {0}")]
    InvalidInput(String),
    /// Otro error HTTP del daemon.
    #[error("error del motor ({status}): {message}")]
    Engine { status: u16, message: String },
    /// Respuesta que no se pudo interpretar.
    #[error("respuesta inesperada del motor: {0}")]
    Protocol(String),
    #[error("el motor no respondió a tiempo")]
    Timeout,
    #[error("error interno: {0}")]
    Internal(String),
}
