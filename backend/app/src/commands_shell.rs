//! Comandos IPC del shell de escritorio (Ola 3): bandeja, notificaciones y salida controlada.
//!
//!   tray_status() -> {available: bool, error: string|null}
//!   notify_user{kind, title, body} -> ()   kind: die|oom|unhealthy|op_done (lista cerrada);
//!       título ≤ 80 y texto ≤ 240 caracteres; se elimina `<`, `>`, `&` y controles. Silencioso
//!       (Ok) si las notificaciones o ese tipo están desactivados, si hay un aviso reciente del
//!       mismo tipo+título (anti-ruido) o, para `op_done`, si la ventana está a la vista.
//!   busy_summary() -> {stacks, pulls, builds, terminals}
//!   quit_app{confirmed} -> ()   con `confirmed=false` y operaciones en curso NO sale: avisa a la
//!       UI por `subscribe_app_events` (`quit_requested`); con `true` sale siempre.
//!   subscribe_app_events{onEvent: Channel<AppFeed>} -> ()   (una sola suscripción: reemplaza)
//!       AppFeed = {type:"quit_requested", summary} | {type:"window_visibility", visible}

use std::time::Instant;

use engine_core::ApiError;
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State, Window};

use crate::notify::{Notification, NotifyKind, deliver, validate_user_notification};
use crate::shell::{AppFeed, BusySummary, ShellState, TrayStatus};
use crate::state::AppState;
use crate::window_ctl::{is_in_background, quit_now, request_quit};

type ApiResult<T> = Result<T, ApiError>;

/// Núcleo de `notify_user` (separado para probarlo sin ventana). Devuelve si se mostró.
pub fn notify_user_inner(
    shell: &ShellState,
    kind: &str,
    title: &str,
    body: &str,
    window_in_background: bool,
    now: Instant,
) -> ApiResult<bool> {
    let kind = NotifyKind::parse(kind)?;
    let notification: Notification = validate_user_notification(title, body)?;
    // El fin de una operación solo interesa si el usuario no está mirando la ventana.
    if kind == NotifyKind::OpDone && !window_in_background {
        return Ok(false);
    }
    let key = format!("ui:{}:{}", kind.as_str(), notification.title);
    Ok(deliver(shell, kind, &key, &notification, now))
}

#[tauri::command]
pub async fn tray_status(state: State<'_, AppState>) -> ApiResult<TrayStatus> {
    Ok(state.shell.tray_status())
}

#[tauri::command]
pub async fn notify_user<R: Runtime>(
    state: State<'_, AppState>,
    window: Window<R>,
    kind: String,
    title: String,
    body: String,
) -> ApiResult<()> {
    notify_user_inner(
        &state.shell,
        &kind,
        &title,
        &body,
        is_in_background(&window),
        Instant::now(),
    )?;
    Ok(())
}

#[tauri::command]
pub async fn busy_summary(state: State<'_, AppState>) -> ApiResult<BusySummary> {
    Ok(state.busy_summary())
}

#[tauri::command]
pub async fn quit_app<R: Runtime>(app: AppHandle<R>, confirmed: bool) -> ApiResult<()> {
    if confirmed {
        quit_now(&app);
    } else {
        request_quit(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn subscribe_app_events(
    state: State<'_, AppState>,
    on_event: Channel<AppFeed>,
) -> ApiResult<()> {
    state.shell.subscribe_feed(on_event);
    Ok(())
}
