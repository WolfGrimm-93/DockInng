//! Comandos IPC de la ventana (Ola 3): decoraciones en caliente y controles propios para la
//! ventana sin marco. Son comandos del backend con su propio permiso `allow-*`: la webview NO
//! recibe `core:window:*` (ni `data-tauri-drag-region`).
//!
//!   window_set_decorations{enabled} -> ()   (aplica en caliente y guarda `window_decorations`)
//!   window_minimize() / window_toggle_maximize() / window_close() -> ()
//!   window_start_drag() -> ()               (mover la ventana; debe llamarse desde `pointerdown`)
//!   window_start_resize{direction} -> ()    (north|south|east|west|north_east|north_west|
//!                                            south_east|south_west)
//!
//! `window_close` pasa por `CloseRequested`, así que respeta «cerrar a la bandeja» y la
//! confirmación de operaciones en curso.

use engine_core::ApiError;
use serde_json::json;
use tauri::{AppHandle, Runtime, State, Window};

use crate::commands_store::with_store;
use crate::state::AppState;
use crate::window_ctl::{apply_decorations, parse_resize_direction, window_error};

type ApiResult<T> = Result<T, ApiError>;

#[tauri::command]
pub async fn window_set_decorations<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    enabled: bool,
) -> ApiResult<()> {
    apply_decorations(&app, enabled);
    state
        .shell
        .apply_pref("window_decorations", &json!(enabled));
    // Persistencia best-effort: sin almacén (tests, base corrupta) el cambio en caliente vale.
    if state.store.is_some() {
        with_store(&state, move |s| {
            s.prefs_set("window_decorations", &json!(enabled))
        })
        .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn window_minimize<R: Runtime>(window: Window<R>) -> ApiResult<()> {
    window.minimize().map_err(|e| window_error("minimizar", e))
}

#[tauri::command]
pub async fn window_toggle_maximize<R: Runtime>(window: Window<R>) -> ApiResult<()> {
    let res = if window.is_maximized().unwrap_or(false) {
        window.unmaximize()
    } else {
        window.maximize()
    };
    res.map_err(|e| window_error("maximizar", e))
}

#[tauri::command]
pub async fn window_close<R: Runtime>(window: Window<R>) -> ApiResult<()> {
    window.close().map_err(|e| window_error("cerrar", e))
}

#[tauri::command]
pub async fn window_start_drag<R: Runtime>(window: Window<R>) -> ApiResult<()> {
    window
        .start_dragging()
        .map_err(|e| window_error("mover", e))
}

#[tauri::command]
pub async fn window_start_resize<R: Runtime>(
    window: Window<R>,
    direction: String,
) -> ApiResult<()> {
    let dir = parse_resize_direction(&direction)?;
    window
        .start_resize_dragging(dir)
        .map_err(|e| window_error("redimensionar", e))
}
