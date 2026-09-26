//! Comandos IPC de terminal (exec), descarga de imágenes y creación de recursos.
//!
//! Firmas (argumentos camelCase en JS):
//!   subscribe_exec(id, cols, rows, on_event: Channel<ExecFeed>) -> SubscriptionId
//!   exec_write(subscription_id, data: String) -> ()
//!   exec_resize(subscription_id, cols, rows) -> ()
//!   exec_close(subscription_id) -> ()
//!   subscribe_pull(reference, on_event: Channel<PullFeed>) -> SubscriptionId
//!   plan_create_container(spec: CreateContainerSpec) -> CreatePlan
//!   create_container(spec, start: bool, ticket: Option<String>) -> CreateResult
//!   create_volume(spec: CreateVolumeSpec) -> Volume
//!   create_network(spec: CreateNetworkSpec) -> Network

use std::sync::Arc;

use engine_core::{
    ApiError, ApiErrorCode, CreateContainerSpec, CreateNetworkSpec, CreatePlan, CreateResult,
    CreateVolumeSpec, ExecRequest, Network, Volume,
};
use tauri::ipc::Channel;
use tauri::{Runtime, State, Window};

use crate::exec_sessions::{ExecFeed, close_session, resize_terminal, start_session, write_input};
use crate::pull_feed::{PullFeed, PullOutcome, run_pull};
use crate::state::AppState;
use crate::streams::{Sink, StreamKind};

type ApiResult<T> = Result<T, ApiError>;

#[tauri::command]
pub async fn subscribe_exec<R: Runtime>(
    state: State<'_, AppState>,
    window: Window<R>,
    id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<ExecFeed>,
) -> ApiResult<String> {
    let sink: Arc<dyn Sink<ExecFeed>> = Arc::new(on_event);
    start_session(
        &state.streams,
        &state.exec_sessions,
        state.exec.clone(),
        state.engine.clone(),
        window.label(),
        ExecRequest {
            container: id,
            cols,
            rows,
        },
        sink,
    )
}

#[tauri::command]
pub async fn exec_write<R: Runtime>(
    state: State<'_, AppState>,
    window: Window<R>,
    subscription_id: String,
    data: String,
) -> ApiResult<()> {
    write_input(
        &state.exec_sessions,
        &subscription_id,
        window.label(),
        &data,
    )
}

#[tauri::command]
pub async fn exec_resize<R: Runtime>(
    state: State<'_, AppState>,
    window: Window<R>,
    subscription_id: String,
    cols: u16,
    rows: u16,
) -> ApiResult<()> {
    resize_terminal(
        &state.exec_sessions,
        &subscription_id,
        window.label(),
        cols,
        rows,
    )
}

#[tauri::command]
pub async fn exec_close<R: Runtime>(
    state: State<'_, AppState>,
    window: Window<R>,
    subscription_id: String,
) -> ApiResult<()> {
    close_session(&state.exec_sessions, &subscription_id, window.label()).await
}

#[tauri::command]
pub async fn subscribe_pull<R: Runtime>(
    state: State<'_, AppState>,
    window: Window<R>,
    reference: String,
    on_event: Channel<PullFeed>,
) -> ApiResult<String> {
    let sink: Arc<dyn Sink<PullFeed>> = Arc::new(on_event);
    start_pull(&state, window.label(), reference, sink)
}

/// Lanza una descarga: valida la referencia, reserva la exclusión por referencia y el cupo
/// de la ventana (2) y devuelve el id de suscripción (cancelar = `unsubscribe`).
pub fn start_pull(
    state: &AppState,
    window: &str,
    reference: String,
    sink: Arc<dyn Sink<PullFeed>>,
) -> ApiResult<String> {
    engine_core::pull::validate_reference(&reference)?;
    let permit = state.pulls.acquire(window, &reference)?;
    let stream = state.pull.pull_image(&reference);
    let panic_sink = sink.clone();
    state.streams.spawn(
        window,
        StreamKind::Pull,
        run_pull(reference, stream, sink, permit),
        move || {
            panic_sink.send(PullFeed::Ended {
                outcome: PullOutcome::Error,
                up_to_date: false,
                digest: None,
                error: Some(ApiError::new(
                    ApiErrorCode::Internal,
                    "error interno en la descarga",
                )),
            });
        },
    )
}

#[tauri::command]
pub async fn plan_create_container(
    state: State<'_, AppState>,
    spec: CreateContainerSpec,
) -> ApiResult<CreatePlan> {
    state.create.plan(spec).await
}

#[tauri::command]
pub async fn create_container(
    state: State<'_, AppState>,
    spec: CreateContainerSpec,
    start: bool,
    ticket: Option<String>,
) -> ApiResult<CreateResult> {
    state.create.create(spec, start, ticket.as_deref()).await
}

#[tauri::command]
pub async fn create_volume(
    state: State<'_, AppState>,
    spec: CreateVolumeSpec,
) -> ApiResult<Volume> {
    state.create.create_volume(spec).await
}

#[tauri::command]
pub async fn create_network(
    state: State<'_, AppState>,
    spec: CreateNetworkSpec,
) -> ApiResult<Network> {
    state.create.create_network(spec).await
}
