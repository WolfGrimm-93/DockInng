//! Error serializable que cruza la frontera IPC (GUI). Vive en el núcleo para que
//! los resultados por elemento de una acción usen la misma forma que los comandos.

use serde::{Deserialize, Serialize};

use crate::connection::ConnectionCause;
use crate::error::EngineError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiErrorCode {
    Connection,
    NotFound,
    Conflict,
    InvalidInput,
    Engine,
    Timeout,
    PolicyDenied,
    TicketInvalid,
    TicketExpired,
    TypedMismatch,
    StateChanged,
    NotImplemented,
    Internal,
    /// No hay `docker compose` instalado.
    ComposeMissing,
    /// Compose terminó con error.
    ComposeFailed,
    /// El archivo compose no es válido.
    InvalidCompose,
    /// La imagen no existe (ni local ni en el registro).
    ImageMissing,
    /// El registro exige credenciales.
    AuthRequired,
    /// No se pudo alcanzar el registro.
    RegistryUnreachable,
    /// El contenedor no tiene shell utilizable.
    NoShell,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiError {
    pub code: ApiErrorCode,
    pub message: String,
    pub cause: Option<ConnectionCause>,
}

impl ApiError {
    pub fn new(code: ApiErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            cause: None,
        }
    }
}

impl From<&EngineError> for ApiError {
    fn from(e: &EngineError) -> Self {
        use EngineError::*;
        let (code, cause) = match e {
            Connection { cause, .. } => (ApiErrorCode::Connection, Some(*cause)),
            NotFound(_) => (ApiErrorCode::NotFound, None),
            Conflict(_) => (ApiErrorCode::Conflict, None),
            InvalidInput(_) => (ApiErrorCode::InvalidInput, None),
            Engine { .. } => (ApiErrorCode::Engine, None),
            Protocol(_) | Internal(_) => (ApiErrorCode::Internal, None),
            Timeout => (ApiErrorCode::Timeout, None),
            Coded { code, .. } => (*code, None),
        };
        // Para errores del daemon se conserva su mensaje tal cual.
        let message = match e {
            NotFound(m) | Conflict(m) | InvalidInput(m) => m.clone(),
            Engine { message, .. } => message.clone(),
            Connection { message, .. } => message.clone(),
            Coded { message, .. } => message.clone(),
            other => other.to_string(),
        };
        Self {
            code,
            message,
            cause,
        }
    }
}

impl From<EngineError> for ApiError {
    fn from(e: EngineError) -> Self {
        Self::from(&e)
    }
}
