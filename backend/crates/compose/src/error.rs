//! Errores del crate. Ningún mensaje incluye el contenido de `.env` ni secretos.

use thiserror::Error;

use crate::types::ValidationIssue;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ComposeError {
    /// No hay `docker compose` (ni plugin ni independiente) utilizable.
    #[error("Docker Compose no está disponible: {0}")]
    Missing(String),
    #[error("entrada inválida: {0}")]
    InvalidInput(String),
    /// Ruta o acción rechazada por seguridad (symlink, fuera de la raíz, demasiado grande...).
    #[error("acción denegada: {0}")]
    Denied(String),
    #[error("no encontrado: {0}")]
    NotFound(String),
    #[error("conflicto: {0}")]
    Conflict(String),
    /// La revisión esperada no coincide con la del disco.
    #[error("el archivo cambió: {0}")]
    StateChanged(String),
    #[error("error de E/S: {0}")]
    Io(String),
    /// Compose terminó con error (mensaje ya truncado y sin secretos conocidos).
    #[error("Compose falló: {message}")]
    Failed { message: String },
    /// El compose no es válido; trae la lista de problemas con línea/columna cuando existen.
    #[error("compose inválido")]
    Invalid(Vec<ValidationIssue>),
    #[error("tiempo agotado")]
    Timeout,
    #[error("salida demasiado grande")]
    OutputTooLarge,
    #[error("error interno: {0}")]
    Internal(String),
}

impl ComposeError {
    pub(crate) fn io(context: &str, e: &std::io::Error) -> Self {
        // Solo el `kind`, no rutas ni contenido: los `io::Error` del SO pueden incluir rutas.
        Self::Io(format!("{context}: {:?}", e.kind()))
    }
}

impl From<&ComposeError> for engine_core::ApiError {
    fn from(e: &ComposeError) -> Self {
        use engine_core::ApiErrorCode as C;
        let code = match e {
            ComposeError::Missing(_) => C::ComposeMissing,
            ComposeError::InvalidInput(_) => C::InvalidInput,
            ComposeError::Denied(_) => C::PolicyDenied,
            ComposeError::NotFound(_) => C::NotFound,
            ComposeError::Conflict(_) => C::Conflict,
            ComposeError::StateChanged(_) => C::StateChanged,
            ComposeError::Io(_) | ComposeError::Internal(_) => C::Internal,
            ComposeError::Failed { .. } | ComposeError::OutputTooLarge => C::ComposeFailed,
            ComposeError::Invalid(_) => C::InvalidCompose,
            ComposeError::Timeout => C::Timeout,
        };
        let message = match e {
            ComposeError::Invalid(issues) => issues
                .first()
                .map(|i| match (i.line, i.column) {
                    (Some(l), Some(c)) => format!("L{l}.C{c}: {}", i.message),
                    (Some(l), None) => format!("L{l}: {}", i.message),
                    _ => i.message.clone(),
                })
                .unwrap_or_else(|| "compose inválido".into()),
            ComposeError::Failed { message } => message.clone(),
            ComposeError::Missing(m)
            | ComposeError::InvalidInput(m)
            | ComposeError::Denied(m)
            | ComposeError::NotFound(m)
            | ComposeError::Conflict(m)
            | ComposeError::StateChanged(m) => m.clone(),
            other => other.to_string(),
        };
        engine_core::ApiError::new(code, message)
    }
}

impl From<ComposeError> for engine_core::ApiError {
    fn from(e: ComposeError) -> Self {
        Self::from(&e)
    }
}

impl From<ComposeError> for engine_core::EngineError {
    fn from(e: ComposeError) -> Self {
        let api = engine_core::ApiError::from(&e);
        match e {
            ComposeError::NotFound(m) => Self::NotFound(m),
            ComposeError::Conflict(m) => Self::Conflict(m),
            ComposeError::InvalidInput(m) => Self::InvalidInput(m),
            ComposeError::Timeout => Self::Timeout,
            _ => Self::coded(api.code, api.message),
        }
    }
}
