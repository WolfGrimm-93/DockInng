//! Gestión de usuarios (`/api/users/*`): solo rol `admin`, solo en modo multiusuario (si el
//! servidor corre en modo `single` estas rutas ni se registran — ver `main.rs`).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use engine_core::{ApiErrorCode, Role};
use serde::{Deserialize, Serialize};

use crate::auth::CurrentUser;
use crate::credentials::{validate_password, validate_username};
use crate::error::HttpError;
use crate::state::AppState;

#[derive(Serialize)]
pub struct UserOut {
    pub id: String,
    pub username: String,
    pub role: Role,
    pub created_at: i64,
}

impl From<store::UserRecord> for UserOut {
    fn from(u: store::UserRecord) -> Self {
        Self {
            id: u.id,
            username: u.username,
            role: u.role,
            created_at: u.created_at,
        }
    }
}

fn store_of(state: &AppState) -> Result<&store::Store, HttpError> {
    state.store.as_deref().ok_or_else(|| {
        HttpError::new(
            ApiErrorCode::NotImplemented,
            "modo single: no hay usuarios que gestionar",
        )
    })
}

pub async fn list_users(
    user: CurrentUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<UserOut>>, HttpError> {
    user.require_admin()?;
    let list = store_of(&state)?.user_list()?;
    Ok(Json(list.into_iter().map(UserOut::from).collect()))
}

#[derive(Deserialize)]
pub struct CreateUserRequest {
    pub username: String,
    pub password: String,
    pub role: Role,
}

pub async fn create_user(
    user: CurrentUser,
    State(state): State<AppState>,
    Json(req): Json<CreateUserRequest>,
) -> Result<Json<UserOut>, HttpError> {
    user.require_admin()?;
    validate_username(&req.username)
        .and_then(|()| validate_password(&req.password))
        .map_err(|m| HttpError::new(ApiErrorCode::InvalidInput, m))?;
    let store = state.store.clone().ok_or_else(no_store)?;
    // Argon2 es caro: fuera del runtime asíncrono y bajo el mismo tope que el login.
    let hash = hash_off_runtime(&state, req.password).await?;
    let (username, role) = (req.username, req.role);
    let created = tokio::task::spawn_blocking(move || store.user_create(&username, &hash, role))
        .await
        .map_err(|_| HttpError::new(ApiErrorCode::Internal, "la tarea falló"))??;
    Ok(Json(UserOut::from(created)))
}

#[derive(Deserialize)]
pub struct SetPasswordRequest {
    pub password: String,
}

/// Reseteo de contraseña por un admin. Cierra TODAS las sesiones del usuario: si la cuenta
/// estaba comprometida, el atacante no sigue dentro con el token anterior.
pub async fn set_password(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<SetPasswordRequest>,
) -> Result<StatusCode, HttpError> {
    user.require_admin()?;
    validate_password(&req.password).map_err(|m| HttpError::new(ApiErrorCode::InvalidInput, m))?;
    let store = state.store.clone().ok_or_else(no_store)?;
    let hash = hash_off_runtime(&state, req.password).await?;
    let id2 = id.clone();
    tokio::task::spawn_blocking(move || store.user_set_password(&id2, &hash))
        .await
        .map_err(|_| HttpError::new(ApiErrorCode::Internal, "la tarea falló"))??;
    state.sessions.remove_all_for_user(&id);
    Ok(StatusCode::NO_CONTENT)
}

fn no_store() -> HttpError {
    HttpError::new(
        ApiErrorCode::NotImplemented,
        "modo single: no hay usuarios que gestionar",
    )
}

/// Argon2 en un hilo de bloqueo y con el tope de hashes simultáneos del login.
async fn hash_off_runtime(state: &AppState, password: String) -> Result<String, HttpError> {
    let Some(permit) = state.login_guard.try_hash_slot() else {
        return Err(HttpError::too_many_requests(
            "el servidor está ocupado calculando hashes: reintenta en un momento",
            1,
        ));
    };
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        store::password::hash_password(&password)
    })
    .await
    .map_err(|_| HttpError::new(ApiErrorCode::Internal, "la tarea falló"))?
    .map_err(HttpError::from)
}

#[derive(Deserialize)]
pub struct SetRoleRequest {
    pub role: Role,
}

pub async fn set_role(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<SetRoleRequest>,
) -> Result<StatusCode, HttpError> {
    user.require_admin()?;
    // Atómico: la comprobación de «último admin» y el cambio son una sola sentencia SQL.
    store_of(&state)?.user_set_role_keeping_admin(&id, req.role)?;
    // El rol cambió: ninguna sesión vieja debe seguir con los permisos anteriores.
    state.sessions.remove_all_for_user(&id);
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_user(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, HttpError> {
    user.require_admin()?;
    if id == user.id {
        return Err(HttpError::new(
            ApiErrorCode::Conflict,
            "no podés borrar tu propio usuario",
        ));
    }
    store_of(&state)?.user_delete_keeping_admin(&id)?;
    state.sessions.remove_all_for_user(&id);
    Ok(StatusCode::NO_CONTENT)
}
