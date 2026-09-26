//! Comandos IPC de persistencia (grupos, preferencias) y registros de imágenes.
//! Todos devuelven `Result<T, ApiError>`; los argumentos llegan en camelCase desde JS.
//!
//! Firmas:
//!   groups_load() -> GroupsSnapshot
//!   groups_mutate(op: GroupOp) -> GroupsSnapshot            (atómico; devuelve el estado final)
//!   groups_import_legacy(payload: LegacyGroups) -> LegacyImportReport   (una sola vez, idempotente)
//!   prefs_get(key) -> Option<json>                           (lista blanca: polling, last_connection_id)
//!   prefs_set(key, value) -> ()
//!   registry_list() -> RegistrySummary[]                     (nunca incluye el secreto)
//!   registry_save(server, username, secret) -> RegistrySummary   (único canal que lleva un secreto)
//!   registry_delete(id, confirmed) -> ()                     (exige `confirmed`: Action::RemoveRegistry)
//!   registry_test(id) -> ()                                  (ok = credenciales válidas; error = ApiError
//!                                                             `auth_required` / `registry_unreachable` / ...)
//!
//! Errores (`ApiError.code`): `invalid_input` (validación), `not_found`, `conflict` (nombre
//! duplicado), `policy_denied` (borrado sin confirmar), `internal` (almacén o llavero no
//! disponible; el mensaje nunca contiene el secreto).

use std::sync::Arc;

use engine_core::{
    Action, ApiError, ApiErrorCode, Decision, EngineError, GroupOp, GroupsSnapshot, Interactivity,
    LegacyGroups, LegacyImportReport, RegistrySummary, Secret, decide,
};
use serde_json::Value;
use store::{SecretStore, Store, StoreError};
use tauri::State;

use crate::state::AppState;

type ApiResult<T> = Result<T, ApiError>;

/// Convierte un error del almacén en el error de la API.
pub fn store_error(e: StoreError) -> ApiError {
    ApiError::from(&EngineError::from(e))
}

/// Almacén disponible, o el error con la causa real de por qué no se pudo abrir.
pub fn store_of(state: &AppState) -> ApiResult<Arc<Store>> {
    state.store.clone().ok_or_else(|| {
        let why = state
            .store_error
            .as_deref()
            .unwrap_or("directorio de datos sin acceso");
        ApiError::new(
            ApiErrorCode::Internal,
            format!("el almacén local no está disponible: {why}"),
        )
    })
}

/// Ejecuta `f` sobre el almacén en un hilo bloqueante (SQLite y llavero son síncronos).
pub async fn with_store<T, F>(state: &AppState, f: F) -> ApiResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Store) -> Result<T, StoreError> + Send + 'static,
{
    let store = store_of(state)?;
    tokio::task::spawn_blocking(move || f(&store))
        .await
        .map_err(|_| ApiError::new(ApiErrorCode::Internal, "tarea de almacén interrumpida"))?
        .map_err(store_error)
}

/// Igual que `with_store` pero también entrega el llavero.
pub async fn with_store_and_secrets<T, F>(state: &AppState, f: F) -> ApiResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Store, &dyn SecretStore) -> Result<T, StoreError> + Send + 'static,
{
    let secrets = state.secrets.clone();
    with_store(state, move |s| f(s, secrets.as_ref())).await
}

/// El GUI confirma con un diálogo y manda `confirmed = true`; sin él, la política decide.
pub fn require_confirmed(action: &Action, confirmed: bool) -> ApiResult<()> {
    match decide(action, Interactivity::Interactive, false) {
        Decision::Allow => Ok(()),
        Decision::Confirm if confirmed => Ok(()),
        _ => Err(ApiError::new(
            ApiErrorCode::PolicyDenied,
            "la acción exige confirmación explícita",
        )),
    }
}

#[tauri::command]
pub async fn groups_load(state: State<'_, AppState>) -> ApiResult<GroupsSnapshot> {
    with_store(&state, |s| s.groups_load()).await
}

#[tauri::command]
pub async fn groups_mutate(state: State<'_, AppState>, op: GroupOp) -> ApiResult<GroupsSnapshot> {
    with_store(&state, move |s| s.groups_mutate(op)).await
}

#[tauri::command]
pub async fn groups_import_legacy(
    state: State<'_, AppState>,
    payload: LegacyGroups,
) -> ApiResult<LegacyImportReport> {
    with_store(&state, move |s| s.groups_import_legacy(payload)).await
}

#[tauri::command]
pub async fn prefs_get(state: State<'_, AppState>, key: String) -> ApiResult<Option<Value>> {
    with_store(&state, move |s| s.prefs_get(&key)).await
}

#[tauri::command]
pub async fn prefs_set(state: State<'_, AppState>, key: String, value: Value) -> ApiResult<()> {
    with_store(&state, move |s| s.prefs_set(&key, &value)).await
}

#[tauri::command]
pub async fn registry_list(state: State<'_, AppState>) -> ApiResult<Vec<RegistrySummary>> {
    with_store(&state, |s| s.registry_list()).await
}

#[tauri::command]
pub async fn registry_save(
    state: State<'_, AppState>,
    server: String,
    username: String,
    secret: Secret,
) -> ApiResult<RegistrySummary> {
    with_store_and_secrets(&state, move |s, k| {
        s.registry_save(k, &server, &username, &secret)
    })
    .await
}

#[tauri::command]
pub async fn registry_delete(
    state: State<'_, AppState>,
    id: String,
    confirmed: bool,
) -> ApiResult<()> {
    require_confirmed(&Action::RemoveRegistry, confirmed)?;
    with_store_and_secrets(&state, move |s, k| s.registry_remove(k, &id)).await
}

#[tauri::command]
pub async fn registry_test(state: State<'_, AppState>, id: String) -> ApiResult<()> {
    let auth = with_store_and_secrets(&state, move |s, k| {
        let row = s.registry_get(&id)?;
        s.registry_auth_for(k, &row.server)?
            .ok_or_else(|| StoreError::NotFound("credenciales en el llavero".into()))
    })
    .await?;
    state
        .pull
        .check_registry_auth(&auth)
        .await
        .map_err(|e| ApiError::from(&e))
}
