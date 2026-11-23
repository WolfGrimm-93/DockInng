//! Extractor del usuario autenticado y los endpoints `/api/auth/*`.

use std::net::{IpAddr, SocketAddr};
use std::sync::LazyLock;
use std::time::Instant;

use axum::extract::{ConnectInfo, FromRequestParts, State};
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
use crate::login_limit::{MAX_PASSWORD_BYTES, MAX_USERNAME_BYTES};
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

/// IP del cliente según la conexión TCP (no se confía en cabeceras `X-Forwarded-For`).
/// `None` si el servidor no se sirve con `ConnectInfo` (tests en memoria).
pub struct ClientAddr(pub Option<IpAddr>);

impl FromRequestParts<AppState> for ClientAddr {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(Self(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|c| c.0.ip()),
        ))
    }
}

/// Hash de una contraseña que nadie tiene: se verifica contra él cuando el usuario no existe,
/// para que la respuesta tarde lo mismo que con una contraseña incorrecta (no delata si el
/// nombre de usuario existe por el tiempo de respuesta).
static DUMMY_HASH: LazyLock<String> =
    LazyLock::new(|| store::password::hash_password("una-contraseña-que-nadie-usa").expect("hash señuelo"));

/// Calcula el hash señuelo al arrancar: si no, el primer login de un usuario inexistente paga
/// ese cálculo y delata por tiempo que no existe.
pub fn warm_up() {
    LazyLock::force(&DUMMY_HASH);
}

pub async fn login(
    State(state): State<AppState>,
    ClientAddr(ip): ClientAddr,
    Json(req): Json<LoginRequest>,
) -> Result<Response, HttpError> {
    let Some(store) = state.store.clone() else {
        return Err(HttpError::new(
            ApiErrorCode::NotImplemented,
            "modo single: no hay login, todo pedido ya es admin",
        ));
    };
    // Acota el trabajo por pedido ANTES de tocar nada caro.
    if req.username.len() > MAX_USERNAME_BYTES || req.password.len() > MAX_PASSWORD_BYTES {
        return Err(HttpError::new(
            ApiErrorCode::InvalidInput,
            "usuario o contraseña demasiado largos",
        ));
    }
    let guard = state.login_guard.clone();
    // Bloqueado: se responde sin ejecutar Argon2 (un bloqueo no puede costar CPU al servidor).
    if let Err(secs) = guard.check(ip, &req.username, Instant::now()) {
        return Err(HttpError::too_many_requests(
            "demasiados intentos fallidos: espera antes de reintentar",
            secs,
        ));
    }
    // Argon2 son ≈19 MiB y decenas de ms: se limita cuántos corren a la vez y se rechaza (no se
    // encola) lo que sobra.
    let Some(permit) = guard.try_hash_slot() else {
        return Err(HttpError::too_many_requests(
            "el servidor está ocupado verificando credenciales: reintenta en un momento",
            1,
        ));
    };
    let username = req.username.clone();
    let password = req.password;
    // Consulta + verificación en un hilo de bloqueo: ni SQLite ni Argon2 bloquean el runtime.
    let found = tokio::task::spawn_blocking(move || {
        // El hueco vive mientras corre el hash, aunque el cliente cancele el pedido.
        let _permit = permit;
        let user = store.user_by_username(&username)?;
        let verified = match &user {
            Some(u) => store::password::verify_password(&u.password_hash, &password),
            None => {
                let _ = store::password::verify_password(&DUMMY_HASH, &password);
                false
            }
        };
        Ok::<_, store::StoreError>(user.filter(|_| verified))
    })
    .await
    .map_err(|_| HttpError::new(ApiErrorCode::Internal, "la verificación falló"))??;
    let Some(user) = found else {
        guard.record_failure(ip, &req.username, Instant::now());
        return Err(HttpError::unauthenticated("usuario o contraseña inválidos"));
    };
    guard.record_success(&req.username);
    let token = state
        .sessions
        .create(user.id.clone(), user.username.clone(), user.role);
    let max_age = state.sessions.policy().absolute_ttl.as_secs();
    let mut res = Json(AuthResponse {
        username: user.username,
        role: user.role,
    })
    .into_response();
    res.headers_mut().insert(
        SET_COOKIE,
        set_cookie_header(token.as_str(), state.insecure_cookies, max_age)
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
