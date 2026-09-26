//! Comandos IPC de stacks / Compose. Todos devuelven `Result<T, ApiError>`; los argumentos
//! llegan en camelCase desde JS (`expectedRevision`, `onEvent`, `subscriptionId`).
//!
//! Firmas:
//!   compose_info(recheck?: bool) -> ComposeInfo
//!   list_stacks() -> StackSummary[]          (managed + linked + discovered por labels)
//!   stack_read(name) -> StackFiles
//!   stack_save(name, yaml, env, expectedRevision?) -> StackFiles
//!   stack_validate(name?, yaml, env) -> StackValidation
//!   stack_create(name, yaml, env) -> StackSummary
//!   stack_link(path) -> StackSummary          (`~/` se expande; el nombre sale de `name:`)
//!   stack_unlink(name) -> ()
//!   run_stack_op(name, op, onEvent: Channel<StackOpFeed>) -> subscriptionId
//!   cancel_stack_op(subscriptionId) -> ()
//!
//! `op` = `{type: up|restart|stop|start|pull, services?: string[]}`; `down` y el borrado de un
//! stack NO son operaciones: van por `plan_action`/`execute_action` (StackDown/StackDelete).
//!
//! Errores (`ApiError.code`):
//!   invalid_input     nombre de stack/servicio o contenido inválido (NUL, tamaño)
//!   not_found         stack inexistente, o `cancel_stack_op` de otra ventana/id desconocido
//!   conflict          ya existe (create/link), nombre de proyecto en uso por otros archivos,
//!                     stack ocupado con otra operación, o demasiadas operaciones (máx. 3 por ventana)
//!   state_changed     `expectedRevision` no coincide con el archivo en disco
//!   policy_denied     stack solo descubierto: `save`/`up`/`pull` denegados (vincúlalo con
//!                     `stack_link`); rutas inseguras (symlinks, fuera del proyecto, /proc...)
//!   invalid_compose   YAML inválido (con línea/columna en `Ended.issues`)
//!   compose_missing   Docker Compose ausente o v1
//!   compose_failed    Compose terminó con error
//!   internal          p. ej. no se pudo determinar el directorio de datos de los stacks propios

use std::sync::Arc;

use engine_core::{
    ApiError, ComposeInfo, StackFiles, StackOp, StackOpFeed, StackSummary, StackValidation,
};
use tauri::ipc::Channel;
use tauri::{Runtime, State, Window};

use crate::stack_ops::start_stack_op;
use crate::state::AppState;
use crate::streams::Sink;

type ApiResult<T> = Result<T, ApiError>;

#[tauri::command]
pub async fn compose_info(
    state: State<'_, AppState>,
    recheck: Option<bool>,
) -> ApiResult<ComposeInfo> {
    Ok(state
        .stacks
        .control
        .compose_info(recheck.unwrap_or(false))
        .await)
}

#[tauri::command]
pub async fn list_stacks(state: State<'_, AppState>) -> ApiResult<Vec<StackSummary>> {
    state.stacks.list_stacks().await
}

#[tauri::command]
pub async fn stack_read(state: State<'_, AppState>, name: String) -> ApiResult<StackFiles> {
    state.stacks.read(&name).await
}

#[tauri::command]
pub async fn stack_save(
    state: State<'_, AppState>,
    name: String,
    yaml: String,
    env: String,
    expected_revision: Option<String>,
) -> ApiResult<StackFiles> {
    Ok(state
        .stacks
        .control
        .stack_save(&name, &yaml, &env, expected_revision.as_deref())
        .await?)
}

#[tauri::command]
pub async fn stack_validate(
    state: State<'_, AppState>,
    name: Option<String>,
    yaml: String,
    env: String,
) -> ApiResult<StackValidation> {
    Ok(state
        .stacks
        .control
        .stack_validate(name.as_deref(), &yaml, &env)
        .await?)
}

#[tauri::command]
pub async fn stack_create(
    state: State<'_, AppState>,
    name: String,
    yaml: String,
    env: String,
) -> ApiResult<StackSummary> {
    state
        .stacks
        .control
        .stack_create(&name, &yaml, &env)
        .await?;
    state.stacks.summary_of(&name).await
}

#[tauri::command]
pub async fn stack_link(state: State<'_, AppState>, path: String) -> ApiResult<StackSummary> {
    let name = state.stacks.link(&path).await?;
    state.stacks.summary_of(&name).await
}

#[tauri::command]
pub async fn stack_unlink(state: State<'_, AppState>, name: String) -> ApiResult<()> {
    Ok(state.stacks.control.stack_unlink(&name).await?)
}

#[tauri::command]
pub async fn run_stack_op<R: Runtime>(
    state: State<'_, AppState>,
    window: Window<R>,
    name: String,
    op: StackOp,
    on_event: Channel<StackOpFeed>,
) -> ApiResult<String> {
    let sink: Arc<dyn Sink<StackOpFeed>> = Arc::new(on_event);
    start_stack_op(
        &state.streams,
        &state.stacks,
        window.label(),
        &name,
        op,
        sink,
    )
    .await
}

#[tauri::command]
pub async fn cancel_stack_op<R: Runtime>(
    state: State<'_, AppState>,
    window: Window<R>,
    subscription_id: String,
) -> ApiResult<()> {
    state.stacks.cancel(window.label(), &subscription_id)
}
