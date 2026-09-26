//! Comandos IPC de herramientas (Ola 2): builds, limpieza guiada y detección de Podman.
//!
//!   build_plan{spec} / subscribe_build{spec,ticket,onEvent} / cleanup_report{minAgeDays}
//!   podman_detect
//!
//! La limpieza NO ejecuta nada aquí: `cleanup_report` es de solo lectura; borrar pasa por el
//! flujo `plan_action` / `execute_action` con `ActionRequest::Cleanup`.

use std::sync::Arc;

use engine_core::{
    ApiError, ApiErrorCode, BuildFeed, BuildPlan, BuildSpec, CleanupReport,
    cleanup_report as report,
};
use engine_docker::{PodmanCandidate, detect_podman_host};
use tauri::ipc::Channel;
use tauri::{Runtime, State, Window};

use crate::build_feed::{start_build, target_of};
use crate::state::AppState;
use crate::streams::Sink;

type ApiResult<T> = Result<T, ApiError>;

/// Antigüedad máxima aceptada (10 años): evita desbordes al multiplicar por segundos.
const MAX_AGE_DAYS: u32 = 3650;

#[tauri::command]
pub async fn build_plan(state: State<'_, AppState>, spec: BuildSpec) -> ApiResult<BuildPlan> {
    let builds = state.builds.clone();
    let target = target_of(&state);
    // Canonizar rutas toca el disco: fuera del hilo del runtime.
    tokio::task::spawn_blocking(move || builds.service.plan(&spec, &target))
        .await
        .map_err(|_| ApiError::new(ApiErrorCode::Internal, "tarea interrumpida"))?
}

#[tauri::command]
pub async fn subscribe_build<R: Runtime>(
    state: State<'_, AppState>,
    window: Window<R>,
    spec: BuildSpec,
    ticket: Option<String>,
    on_event: Channel<BuildFeed>,
) -> ApiResult<String> {
    let sink: Arc<dyn Sink<BuildFeed>> = Arc::new(on_event);
    start_build(&state, window.label(), spec, ticket, sink)
}

#[tauri::command]
pub async fn cleanup_report(
    state: State<'_, AppState>,
    min_age_days: Option<u32>,
) -> ApiResult<CleanupReport> {
    let days = min_age_days.unwrap_or(0).min(MAX_AGE_DAYS);
    Ok(report(state.engine.as_ref(), days).await?)
}

#[tauri::command]
pub async fn podman_detect() -> ApiResult<Vec<PodmanCandidate>> {
    tokio::task::spawn_blocking(detect_podman_host)
        .await
        .map_err(|_| ApiError::new(ApiErrorCode::Internal, "tarea interrumpida"))
}
