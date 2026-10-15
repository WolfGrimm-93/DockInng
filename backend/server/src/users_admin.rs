//! Gestión de usuarios (`/api/users/*`): solo rol `admin`, solo en modo multiusuario (si el
//! servidor corre en modo `single` estas rutas ni se registran — ver `main.rs`).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use engine_core::{ApiErrorCode, Role};
use serde::{Deserialize, Serialize};

use crate::auth::CurrentUser;
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

/// Igual que el mínimo de Argon2 para una contraseña con algo de margen: evita cuentas
/// triviales de adivinar sin forzar una política de complejidad que no viene al caso acá.
const MIN_PASSWORD_LEN: usize = 8;

pub async fn create_user(
    user: CurrentUser,
    State(state): State<AppState>,
    Json(req): Json<CreateUserRequest>,
) -> Result<Json<UserOut>, HttpError> {
    user.require_admin()?;
    if req.username.trim().is_empty() {
        return Err(HttpError::new(
            ApiErrorCode::InvalidInput,
            "el nombre de usuario no puede estar vacío",
        ));
    }
    if req.password.len() < MIN_PASSWORD_LEN {
        return Err(HttpError::new(
            ApiErrorCode::InvalidInput,
            format!("la contraseña debe tener al menos {MIN_PASSWORD_LEN} caracteres"),
        ));
    }
    let hash = store::password::hash_password(&req.password)?;
    let created = store_of(&state)?.user_create(&req.username, &hash, req.role)?;
    Ok(Json(UserOut::from(created)))
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
    let store = store_of(&state)?;
    guard_last_admin(store, &id, req.role)?;
    store.user_set_role(&id, req.role)?;
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
    let store = store_of(&state)?;
    // "Borrar" es degradar a un rol inexistente a todos los efectos de "último admin": se
    // reusa el mismo chequeo pidiendo cualquier rol que no sea admin.
    guard_last_admin(store, &id, Role::Viewer)?;
    store.user_delete(&id)?;
    state.sessions.remove_all_for_user(&id);
    Ok(StatusCode::NO_CONTENT)
}

/// Si `id` es admin y pasar a `new_role` (o borrarlo) dejaría el sistema sin ningún admin,
/// rechaza. Evita el bloqueo clásico de "nadie puede volver a entrar".
fn guard_last_admin(store: &store::Store, id: &str, new_role: Role) -> Result<(), HttpError> {
    if new_role == Role::Admin {
        return Ok(());
    }
    let target = store
        .user_by_id(id)?
        .ok_or_else(|| HttpError::new(ApiErrorCode::NotFound, format!("usuario «{id}»")))?;
    if target.role == Role::Admin && store.user_admin_count()? <= 1 {
        return Err(HttpError::new(
            ApiErrorCode::Conflict,
            "no se puede dejar el sistema sin ningún administrador",
        ));
    }
    Ok(())
}
