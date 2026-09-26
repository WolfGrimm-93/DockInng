//! RIESGO RESIDUAL ACEPTADO (ALTO): `plan_action` + `execute_action(ticket, typed)` no son una
//! frontera de seguridad. Un webview comprometido (XSS, contenido remoto inyectado) puede
//! pedir el plan y ejecutarlo con el texto de confirmación correcto ("ELIMINAR" o el nombre)
//! SIN ningún gesto humano, porque la confirmación la aporta el mismo proceso que la pide.
//! El ticket solo garantiza el contrato para los caminos legítimos de la app (preview
//! calculado en el backend, escritura exigida, un solo uso, objetivos resueltos por el
//! backend, re-verificación por elemento). La barrera real es la CSP estricta y la ausencia de
//! contenido remoto en la ventana. En esta ronda NO hay diálogo nativo de confirmación;
//! añadirlo es el siguiente paso si se quiere cerrar este riesgo.
//!
//! Comandos IPC. Cada comando devuelve `Result<T, ApiError>` (serializable) y delega en
//! funciones `*_inner` que reciben el motor como trait para poder probarse con `MockEngine`.
//!
//! Firmas (nombre snake_case = nombre de `invoke`; argumentos camelCase en JS):
//!   connection_status() -> ConnectionStatus            (nunca falla)
//!   reconnect() -> ConnectionStatus
//!   list_containers(all: bool) -> Vec<Container>
//!   inspect_container(id) -> ContainerDetail
//!   container_stats_snapshot(ids: Vec<String>) -> Vec<StatsSnapshotItem>
//!       StatsSnapshotItem { id: String, stats: Option<ContainerStats>, error: Option<ApiError> }
//!       Máx. 64 ids; 8 en paralelo; tope total de 5 s; un elemento por id, en el mismo orden.
//!       Usa `stream=false` (el daemon rellena `precpu_stats`, así que el CPU% es correcto en la
//!       primera y única muestra); latencia ~1 s por contenedor. NO consume los cupos de
//!       suscripción. Contenedor detenido: `stats` con ceros o `error`, según el daemon.
//!   list_images() -> Vec<Image> | list_volumes() -> Vec<Volume> | list_networks() -> Vec<Network>
//!   start_container(id) | stop_container(id) | restart_container(id) -> ()
//!   plan_action(request: ActionRequest) -> ActionPlan
//!   execute_action(ticket, typed: Option<String>) -> ActionOutcome
//!   cancel_action(ticket) -> ()
//!   subscribe_engine_events(on_event: Channel<EngineFeed>) -> SubscriptionId
//!   subscribe_logs(id, tail: Option<u32>, follow, on_event: Channel<LogFeed>) -> SubscriptionId
//!   subscribe_stats(id, on_event: Channel<StatsFeed>) -> SubscriptionId
//!   unsubscribe(subscription_id) -> ()
//!   reset_subscriptions() -> ()

use std::sync::Arc;

use engine_core::{
    Action, ActionOutcome, ActionPlan, ActionRequest, ApiError, ApiErrorCode, ConnectionStatus,
    Container, ContainerDetail, ContainerStats, EngineClient, GpuInfo, Image, Interactivity,
    LogsRequest, Network, SystemUsage, Volume, decide,
};
use tauri::ipc::Channel;
use tauri::{Runtime, State, Window};

use crate::state::AppState;
use crate::streams::{
    EndReason, EngineFeed, LogFeed, Sink, StatsFeed, StreamKind, run_events, run_logs, run_stats,
};

type ApiResult<T> = Result<T, ApiError>;

/// Máximo de ids por petición de snapshot.
pub const SNAPSHOT_MAX_IDS: usize = 64;
/// Concurrencia del snapshot (cada muestra tarda ~1 s en el daemon).
pub const SNAPSHOT_CONCURRENCY: usize = 8;
/// Tope total del comando.
pub const SNAPSHOT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct StatsSnapshotItem {
    pub id: String,
    pub stats: Option<ContainerStats>,
    pub error: Option<ApiError>,
}

/// Muestra puntual de varios contenedores, en paralelo (límite 8) y con tope total de 5 s.
pub async fn stats_snapshot_inner(
    engine: &dyn EngineClient,
    ids: Vec<String>,
) -> ApiResult<Vec<StatsSnapshotItem>> {
    use futures_util::StreamExt;
    if ids.len() > SNAPSHOT_MAX_IDS {
        return Err(ApiError::new(
            ApiErrorCode::InvalidInput,
            format!("demasiados ids (máximo {SNAPSHOT_MAX_IDS})"),
        ));
    }
    let deadline = tokio::time::Instant::now() + SNAPSHOT_TIMEOUT;
    Ok(futures_util::stream::iter(ids)
        .map(|id| async move {
            // `stats_snapshot` valida el id igual que el resto de comandos.
            let r = tokio::time::timeout_at(deadline, engine.stats_snapshot(&id)).await;
            match r {
                Ok(Ok(stats)) => StatsSnapshotItem {
                    id,
                    stats: Some(stats),
                    error: None,
                },
                Ok(Err(e)) => StatsSnapshotItem {
                    id,
                    stats: None,
                    error: Some(e.into()),
                },
                Err(_) => StatsSnapshotItem {
                    id,
                    stats: None,
                    error: Some(engine_core::EngineError::Timeout.into()),
                },
            }
        })
        .buffered(SNAPSHOT_CONCURRENCY)
        .collect()
        .await)
}

/// Las acciones reversibles se ejecutan directo, pero solo si la política lo permite:
/// blindaje por si mañana cambia.
async fn reversible(engine: &dyn EngineClient, action: Action, id: &str) -> ApiResult<()> {
    if decide(&action, Interactivity::Interactive, false) != engine_core::Decision::Allow {
        return Err(ApiError::new(
            ApiErrorCode::PolicyDenied,
            "la política exige confirmación para esta acción",
        ));
    }
    let r = match action {
        Action::StartContainer => engine.start_container(id).await,
        Action::StopContainer => engine.stop_container(id).await,
        Action::RestartContainer => engine.restart_container(id).await,
        _ => {
            return Err(ApiError::new(
                ApiErrorCode::Internal,
                "acción no reversible",
            ));
        }
    };
    r.map_err(ApiError::from)
}

pub async fn start_inner(engine: &dyn EngineClient, id: &str) -> ApiResult<()> {
    reversible(engine, Action::StartContainer, id).await
}

pub async fn stop_inner(engine: &dyn EngineClient, id: &str) -> ApiResult<()> {
    reversible(engine, Action::StopContainer, id).await
}

pub async fn restart_inner(engine: &dyn EngineClient, id: &str) -> ApiResult<()> {
    reversible(engine, Action::RestartContainer, id).await
}

#[tauri::command]
pub async fn connection_status(state: State<'_, AppState>) -> Result<ConnectionStatus, ApiError> {
    Ok(state.engine.diagnose().await)
}

#[tauri::command]
pub async fn reconnect(state: State<'_, AppState>) -> Result<ConnectionStatus, ApiError> {
    // Al cambiar la conexión no se puede confiar en tickets emitidos antes.
    state.actions.invalidate_all();
    state.create.invalidate_all();
    Ok(state.engine.reconnect().await)
}

#[tauri::command]
pub async fn list_containers(state: State<'_, AppState>, all: bool) -> ApiResult<Vec<Container>> {
    Ok(state.engine.list_containers(all).await?)
}

#[tauri::command]
pub async fn inspect_container(
    state: State<'_, AppState>,
    id: String,
) -> ApiResult<ContainerDetail> {
    Ok(state.engine.inspect_container(&id).await?)
}

#[tauri::command]
pub async fn container_stats_snapshot(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> ApiResult<Vec<StatsSnapshotItem>> {
    stats_snapshot_inner(state.engine.as_ref(), ids).await
}

#[tauri::command]
pub async fn list_images(state: State<'_, AppState>) -> ApiResult<Vec<Image>> {
    Ok(state.engine.list_images().await?)
}

#[tauri::command]
pub async fn list_volumes(state: State<'_, AppState>) -> ApiResult<Vec<Volume>> {
    Ok(state.engine.list_volumes().await?)
}

#[tauri::command]
pub async fn list_networks(state: State<'_, AppState>) -> ApiResult<Vec<Network>> {
    Ok(state.engine.list_networks().await?)
}

/// CPU/memoria del equipo y uso de disco de Docker. Si `df` falla, `disk_known = false` (no es un error).
#[tauri::command]
pub async fn system_usage(state: State<'_, AppState>) -> ApiResult<SystemUsage> {
    Ok(state.engine.system_usage().await?)
}

/// GPU del equipo (solo NVIDIA vía `nvidia-smi` y solo con motor local). Sin GPU o sin `nvidia-smi` devuelve `[]`.
#[tauri::command]
pub async fn gpu_status(state: State<'_, AppState>) -> ApiResult<Vec<GpuInfo>> {
    // Con un daemon remoto la GPU del equipo local no dice nada del servidor.
    if state.engine.is_remote() {
        return Ok(Vec::new());
    }
    Ok(crate::gpu::probe().await)
}

#[tauri::command]
pub async fn start_container(state: State<'_, AppState>, id: String) -> ApiResult<()> {
    let _guard = state.action_guard().await?;
    start_inner(state.engine.as_ref(), &id).await
}

#[tauri::command]
pub async fn stop_container(state: State<'_, AppState>, id: String) -> ApiResult<()> {
    let _guard = state.action_guard().await?;
    stop_inner(state.engine.as_ref(), &id).await
}

#[tauri::command]
pub async fn restart_container(state: State<'_, AppState>, id: String) -> ApiResult<()> {
    let _guard = state.action_guard().await?;
    restart_inner(state.engine.as_ref(), &id).await
}

#[tauri::command]
pub async fn plan_action(
    state: State<'_, AppState>,
    request: ActionRequest,
) -> ApiResult<ActionPlan> {
    state.ensure_not_switching()?;
    state.actions.plan(request).await.map_err(ApiError::from)
}

#[tauri::command]
pub async fn execute_action(
    state: State<'_, AppState>,
    ticket: String,
    typed: Option<String>,
) -> ApiResult<ActionOutcome> {
    let _guard = state.action_guard().await?;
    state
        .actions
        .execute(&ticket, typed.as_deref())
        .await
        .map_err(ApiError::from)
}

#[tauri::command]
pub async fn cancel_action(state: State<'_, AppState>, ticket: String) -> ApiResult<()> {
    state.actions.cancel(&ticket);
    Ok(())
}

#[tauri::command]
pub async fn subscribe_engine_events<R: Runtime>(
    state: State<'_, AppState>,
    window: Window<R>,
    on_event: Channel<EngineFeed>,
) -> ApiResult<String> {
    let sink: Arc<dyn Sink<EngineFeed>> = Arc::new(on_event);
    let panic_sink = sink.clone();
    state.streams.spawn(
        window.label(),
        StreamKind::Events,
        run_events(state.engine.clone(), sink),
        move || {
            panic_sink.send(EngineFeed::Ended {
                reason: EndReason::Internal,
            });
        },
    )
}

#[tauri::command]
pub async fn subscribe_logs<R: Runtime>(
    state: State<'_, AppState>,
    window: Window<R>,
    id: String,
    tail: Option<u32>,
    follow: bool,
    on_event: Channel<LogFeed>,
) -> ApiResult<String> {
    let stream = state.engine.logs(
        &id,
        LogsRequest {
            tail,
            follow,
            since: None,
        },
    );
    let sink: Arc<dyn Sink<LogFeed>> = Arc::new(on_event);
    let panic_sink = sink.clone();
    state.streams.spawn(
        window.label(),
        StreamKind::Logs,
        run_logs(stream, sink, follow),
        move || {
            panic_sink.send(LogFeed::Ended {
                reason: EndReason::Internal,
                error: None,
            });
        },
    )
}

#[tauri::command]
pub async fn subscribe_stats<R: Runtime>(
    state: State<'_, AppState>,
    window: Window<R>,
    id: String,
    on_event: Channel<StatsFeed>,
) -> ApiResult<String> {
    let stream = state.engine.stats(&id);
    let sink: Arc<dyn Sink<StatsFeed>> = Arc::new(on_event);
    let panic_sink = sink.clone();
    state.streams.spawn(
        window.label(),
        StreamKind::Stats,
        run_stats(stream, sink),
        move || {
            panic_sink.send(StatsFeed::Ended {
                reason: EndReason::Internal,
                error: None,
            });
        },
    )
}

#[tauri::command]
pub async fn unsubscribe<R: Runtime>(
    state: State<'_, AppState>,
    window: Window<R>,
    subscription_id: String,
) -> ApiResult<()> {
    // Solo las suscripciones de ESTA ventana; un id ajeno responde igual que uno inexistente
    // (Ok, idempotente) y no se aborta.
    state.streams.abort_in(window.label(), &subscription_id);
    Ok(())
}

/// Al recargar la página los canales JS desaparecen: el frontend lo llama al arrancar. La
/// limpieza real la hace `begin_page` (hook de carga de página); aquí solo se abortan las
/// suscripciones de épocas anteriores, nunca las creadas tras la carga actual.
#[tauri::command]
pub async fn reset_subscriptions<R: Runtime>(
    state: State<'_, AppState>,
    window: Window<R>,
) -> ApiResult<()> {
    state.streams.reset_stale(window.label());
    Ok(())
}

#[cfg(test)]
mod tests {
    use engine_core::EngineError;
    use engine_core::testing::MockEngine;

    use super::*;

    #[tokio::test]
    async fn reversibles_llaman_al_motor() {
        let e = MockEngine::new();
        start_inner(&e, "a").await.expect("start");
        stop_inner(&e, "b").await.expect("stop");
        restart_inner(&e, "c").await.expect("restart");
        assert_eq!(
            e.calls(),
            [
                "start_container:a",
                "stop_container:b",
                "restart_container:c"
            ]
        );
    }

    fn ids(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("c{i}")).collect()
    }

    #[tokio::test]
    async fn snapshot_devuelve_un_elemento_por_id_en_orden_con_errores_por_elemento() {
        let e = MockEngine::new();
        e.state()
            .fail
            .insert("stats_snapshot".into(), EngineError::NotFound("x".into()));
        let out = stats_snapshot_inner(&e, ids(3)).await.expect("ok");
        assert_eq!(out.len(), 3);
        assert_eq!(out[1].id, "c1");
        assert!(out.iter().all(|i| i.stats.is_none()));
        assert_eq!(
            out[0].error.as_ref().map(|e| e.code),
            Some(ApiErrorCode::NotFound)
        );
        e.state().fail.clear();
        let out = stats_snapshot_inner(&e, ids(2)).await.expect("ok");
        assert!(out.iter().all(|i| i.stats.is_some() && i.error.is_none()));
        let json = serde_json::to_value(&out[0]).expect("json");
        assert_eq!(json["id"], "c0");
        assert!(json["stats"]["cpu_percent"].is_number() && json["error"].is_null());
    }

    #[tokio::test]
    async fn snapshot_rechaza_mas_de_64_ids_y_valida_ids() {
        let e = MockEngine::new();
        let err = stats_snapshot_inner(&e, ids(65)).await.expect_err("tope");
        assert_eq!(err.code, ApiErrorCode::InvalidInput);
        assert!(
            stats_snapshot_inner(&e, vec![])
                .await
                .expect("vacío")
                .is_empty()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn snapshot_corre_de_a_8_y_respeta_el_tope_de_5_s() {
        let e = MockEngine::new();
        e.state().stats_delay = Some(std::time::Duration::from_secs(1));
        let t0 = tokio::time::Instant::now();
        let out = stats_snapshot_inner(&e, ids(16)).await.expect("ok");
        // 16 ids / 8 en paralelo = 2 rondas de 1 s.
        assert_eq!(t0.elapsed(), std::time::Duration::from_secs(2));
        assert!(out.iter().all(|i| i.stats.is_some()));
        // 64 ids de 1 s con 8 en paralelo serían 8 s: los que no caben dan timeout.
        let t0 = tokio::time::Instant::now();
        let out = stats_snapshot_inner(&e, ids(64)).await.expect("ok");
        assert_eq!(t0.elapsed(), SNAPSHOT_TIMEOUT);
        let ok = out.iter().filter(|i| i.stats.is_some()).count();
        assert_eq!(ok, 40); // 5 rondas de 8
        assert!(
            out[63]
                .error
                .as_ref()
                .is_some_and(|e| e.code == ApiErrorCode::Timeout)
        );
    }

    #[tokio::test]
    async fn errores_del_motor_se_serializan_con_codigo() {
        let e = MockEngine::new();
        e.state()
            .fail
            .insert("start_container".into(), EngineError::Conflict("ya".into()));
        let err = start_inner(&e, "a").await.expect_err("falla");
        assert_eq!(err.code, ApiErrorCode::Conflict);
        let json = serde_json::to_value(&err).expect("json");
        assert_eq!(json["code"], "conflict");
        assert_eq!(json["message"], "ya");
        assert!(json["cause"].is_null());
    }

    #[test]
    fn api_error_de_conexion_lleva_la_causa() {
        let err: ApiError = EngineError::Connection {
            cause: engine_core::ConnectionCause::PermissionDenied,
            message: "denegado".into(),
        }
        .into();
        let json = serde_json::to_value(&err).expect("json");
        assert_eq!(json["code"], "connection");
        assert_eq!(json["cause"], "permission_denied");
    }
}
