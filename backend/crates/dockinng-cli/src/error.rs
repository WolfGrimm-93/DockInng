//! Error de la CLI. Sustituye al `String` que viajaba por todos los comandos: cada fallo dice
//! qué clase de problema es (uso incorrecto, rechazo de la persona, fallo del motor o del
//! almacén). `main` lo imprime igual que antes (`error: <mensaje>`).

use engine_core::{ApiError, ApiErrorCode};

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum CliError {
    /// Uso incorrecto: argumento no válido, contexto inexistente, petición imposible.
    #[error("{0}")]
    Usage(String),
    /// La acción fue rechazada por la política o la persona no confirmó.
    #[error("{0}")]
    Declined(String),
    /// Fallo del motor, del almacén o de E/S durante la operación.
    #[error("{0}")]
    Failed(String),
}

impl From<ApiError> for CliError {
    fn from(e: ApiError) -> Self {
        match e.code {
            ApiErrorCode::InvalidInput => Self::Usage(e.message),
            ApiErrorCode::PolicyDenied => Self::Declined(e.message),
            _ => Self::Failed(e.message),
        }
    }
}

impl From<store::StoreError> for CliError {
    fn from(e: store::StoreError) -> Self {
        Self::Failed(e.to_string())
    }
}

impl From<std::io::Error> for CliError {
    fn from(e: std::io::Error) -> Self {
        Self::Failed(e.to_string())
    }
}

/// Mensajes sueltos de la capa de comandos: se tratan como fallo genérico. Los casos de uso
/// incorrecto y de rechazo se construyen explícitamente con `Usage` / `Declined`.
impl From<String> for CliError {
    fn from(s: String) -> Self {
        Self::Failed(s)
    }
}

impl From<&str> for CliError {
    fn from(s: &str) -> Self {
        Self::Failed(s.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_error_conserva_la_clase_del_fallo() {
        let uso: CliError = ApiError::new(ApiErrorCode::InvalidInput, "mal").into();
        assert!(matches!(uso, CliError::Usage(ref m) if m == "mal"));
        let rech: CliError = ApiError::new(ApiErrorCode::PolicyDenied, "no").into();
        assert!(matches!(rech, CliError::Declined(_)));
        let fallo: CliError = ApiError::new(ApiErrorCode::Conflict, "x").into();
        assert!(matches!(fallo, CliError::Failed(_)));
    }

    #[test]
    fn el_mensaje_visible_no_cambia() {
        let e = CliError::Usage("no existe la conexión x".into());
        assert_eq!(e.to_string(), "no existe la conexión x");
    }
}
