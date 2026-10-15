//! Extractor del usuario autenticado y los endpoints `/api/auth/*`.

use std::sync::LazyLock;

use axum::extract::{FromRequestParts, State};
use axum::http::StatusCode;
use axum::http::header::SET_COOKIE;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use axum::Json;
use engine_core::{ApiErrorCode, Role};
use serde::{Deserialize, Serialize};

use crate::cookie::{clear_cookie_header, read_session_cookie, set_cookie_header};
use crate::config::AuthMode;
use crate::error::HttpError;
use crate::session::SessionToken;
use crate::state::AppState;

/// Quién hace el pedido. En modo `single` es siempre un administrador sintético: no hace
/// falta loguearse, igual que hoy la app de escritorio confía en el usuario del sistema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentUser {
    pub id: String,
    pub username: String,
    pub role: Role,
}

impl CurrentUser {
    pub fn require_admin(&self) -> Result<(), HttpError> {
        if self.role.can_manage_users() {
            Ok(())
        } else {
            Err(HttpError::forbidden("se requiere el rol admin"))
        }
    }
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = HttpError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, HttpError> {
        match state.auth_mode {
            AuthMode::Single => Ok(CurrentUser {
                id: "local".into(),
                username: "local".into(),
                role: Role::Admin,
            }),
            AuthMode::Multi => {
                let token = read_session_cookie(&parts.headers)
                    .and_then(|v| SessionToken::parse(&v))
                    .ok_or_else(|| HttpError::unauthenticated("falta sesión"))?;
                let data = state
                    .sessions
                    .get(&token)
                    .ok_or_else(|| HttpError::unauthenticated("sesión inválida o vencida"))?;
                Ok(CurrentUser {
                    id: data.user_id,
                    username: data.username,
                    role: data.role,
                })
            }
        }
    }
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub username: String,
    pub role: Role,
}

/// Hash de una contraseña que nadie tiene: se verifica contra él cuando el usuario no existe,
/// para que la respuesta tarde lo mismo que con una contraseña incorrecta (no delata si el
/// nombre de usuario existe por el tiempo de respuesta).
static DUMMY_HASH: LazyLock<String> =
    LazyLock::new(|| store::password::hash_password("una-contraseña-que-nadie-usa").expect("hash señuelo"));

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Response, HttpError> {
    let Some(store) = &state.store else {
        return Err(HttpError::new(
            ApiErrorCode::NotImplemented,
            "modo single: no hay login, todo pedido ya es admin",
        ));
    };
    let user = store.user_by_username(&req.username)?;
    let verified = match &user {
        Some(u) => store::password::verify_password(&u.password_hash, &req.password),
        None => {
            let _ = store::password::verify_password(&DUMMY_HASH, &req.password);
            false
        }
    };
    let Some(user) = user.filter(|_| verified) else {
        return Err(HttpError::unauthenticated("usuario o contraseña inválidos"));
    };
    let token = state
        .sessions
        .create(user.id.clone(), user.username.clone(), user.role);
    let mut res = Json(AuthResponse {
        username: user.username,
        role: user.role,
    })
    .into_response();
    res.headers_mut().insert(
        SET_COOKIE,
        set_cookie_header(token.as_str(), state.insecure_cookies)
            .parse()
            .expect("cabecera de cookie siempre válida"),
    );
    Ok(res)
}

pub async fn logout(
    State(state): State<AppState>,
    parts: axum::http::HeaderMap,
) -> Response {
    if let Some(token) = read_session_cookie(&parts).and_then(|v| SessionToken::parse(&v)) {
        state.sessions.remove(&token);
    }
    let mut res = StatusCode::NO_CONTENT.into_response();
    res.headers_mut().insert(
        SET_COOKIE,
        clear_cookie_header(state.insecure_cookies)
            .parse()
            .expect("cabecera de cookie siempre válida"),
    );
    res
}

pub async fn me(user: CurrentUser) -> Json<AuthResponse> {
    Json(AuthResponse {
        username: user.username,
        role: user.role,
    })
}
