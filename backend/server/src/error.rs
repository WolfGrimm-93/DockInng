//! Error HTTP del servidor: envuelve `engine_core::ApiError`, el mismo tipo que ya cruza la
//! frontera IPC hacia la app de escritorio. Así los tres adaptadores (CLI, app, servidor)
//! responden con la misma forma ante el mismo problema del núcleo.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use engine_core::{ApiError, ApiErrorCode, EngineError};

pub struct HttpError(pub ApiError);

impl HttpError {
    pub fn new(code: ApiErrorCode, message: impl Into<String>) -> Self {
        Self(ApiError::new(code, message))
    }

    pub fn unauthenticated(message: impl Into<String>) -> Self {
        Self::new(ApiErrorCode::Unauthenticated, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(ApiErrorCode::Forbidden, message)
    }
}

impl From<ApiError> for HttpError {
    fn from(e: ApiError) -> Self {
        Self(e)
    }
}

impl From<EngineError> for HttpError {
    fn from(e: EngineError) -> Self {
        Self(ApiError::from(e))
    }
}

impl From<store::StoreError> for HttpError {
    fn from(e: store::StoreError) -> Self {
        Self(ApiError::from(EngineError::from(e)))
    }
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        (status_for(self.0.code), Json(self.0)).into_response()
    }
}

fn status_for(code: ApiErrorCode) -> StatusCode {
    use ApiErrorCode::*;
    match code {
        NotFound | ImageMissing => StatusCode::NOT_FOUND,
        Conflict | StateChanged => StatusCode::CONFLICT,
        InvalidInput | InvalidCompose | TypedMismatch | ComposeFailed => StatusCode::BAD_REQUEST,
        Unauthenticated | AuthRequired => StatusCode::UNAUTHORIZED,
        Forbidden | PolicyDenied => StatusCode::FORBIDDEN,
        Timeout => StatusCode::GATEWAY_TIMEOUT,
        NotImplemented => StatusCode::NOT_IMPLEMENTED,
        TicketInvalid | TicketExpired => StatusCode::BAD_REQUEST,
        Connection | Engine | ComposeMissing | RegistryUnreachable | NoShell | Internal => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(code: ApiErrorCode) -> StatusCode {
        HttpError::new(code, "x").into_response().status()
    }

    #[test]
    fn mapea_los_codigos_de_autenticacion_y_permiso() {
        assert_eq!(status(ApiErrorCode::Unauthenticated), StatusCode::UNAUTHORIZED);
        assert_eq!(status(ApiErrorCode::Forbidden), StatusCode::FORBIDDEN);
    }

    #[test]
    fn mapea_los_codigos_mas_comunes() {
        assert_eq!(status(ApiErrorCode::NotFound), StatusCode::NOT_FOUND);
        assert_eq!(status(ApiErrorCode::Conflict), StatusCode::CONFLICT);
        assert_eq!(status(ApiErrorCode::InvalidInput), StatusCode::BAD_REQUEST);
        assert_eq!(status(ApiErrorCode::Internal), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn store_error_se_convierte_sin_entrar_en_panico() {
        let e: HttpError = store::StoreError::NotFound("x".into()).into();
        assert_eq!(e.0.code, ApiErrorCode::NotFound);
    }
}
