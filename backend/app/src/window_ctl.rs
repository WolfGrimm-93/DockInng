//! Control de la ventana principal desde el backend: mostrar/ocultar, decoraciones, arrastre y
//! redimensionado, y el flujo de salida. Nada de esto usa la API JS `core:window`: la webview
//! solo invoca comandos propios (`commands_window`) y este módulo actúa sobre la ventana.

use std::time::Duration;

use engine_core::{ApiError, ApiErrorCode};
use tauri::{AppHandle, Manager, Runtime, Window};
use tauri_runtime::ResizeDirection;

use crate::shell::{AppFeed, CloseAction, decide_close};
use crate::state::AppState;

/// Etiqueta de la ventana principal.
pub const MAIN_LABEL: &str = "main";

/// Dirección de redimensionado (lista cerrada; la UI envía el nombre en snake_case).
pub fn parse_resize_direction(s: &str) -> Result<ResizeDirection, ApiError> {
    Ok(match s {
        "north" => ResizeDirection::North,
        "south" => ResizeDirection::South,
        "east" => ResizeDirection::East,
        "west" => ResizeDirection::West,
        "north_east" => ResizeDirection::NorthEast,
        "north_west" => ResizeDirection::NorthWest,
        "south_east" => ResizeDirection::SouthEast,
        "south_west" => ResizeDirection::SouthWest,
        _ => {
            return Err(ApiError::new(
                ApiErrorCode::InvalidInput,
                "dirección de redimensionado desconocida",
            ));
        }
    })
}

/// Error genérico cuando la ventana rechaza una operación (el detalle va al log).
pub fn window_error(what: &str, e: impl std::fmt::Display) -> ApiError {
    eprintln!("ventana: {what} falló: {e}");
    ApiError::new(
        ApiErrorCode::Internal,
        format!("no se pudo {what} la ventana"),
    )
}

/// Muestra la ventana principal y le da el foco (en Wayland el compositor puede negar el foco;
/// entonces solo queda visible).
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let shell = &app.state::<AppState>().shell;
    if shell.is_hidden() {
        shell.set_hidden(false);
        shell.emit(AppFeed::WindowVisibility { visible: true });
    }
}

/// Oculta la ventana principal (la app sigue en la bandeja).
pub fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.hide();
    }
    let shell = &app.state::<AppState>().shell;
    if !shell.is_hidden() {
        shell.set_hidden(true);
        shell.emit(AppFeed::WindowVisibility { visible: false });
    }
}

/// Alterna la visibilidad (menú y clic de la bandeja).
pub fn toggle_main<R: Runtime>(app: &AppHandle<R>) {
    let showing = app
        .get_webview_window(MAIN_LABEL)
        .is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false));
    if showing {
        hide_main(app);
    } else {
        show_main(app);
    }
}

/// La ventana no está a la vista: sin foco, minimizada u oculta.
pub fn is_in_background<R: Runtime>(window: &Window<R>) -> bool {
    let visible = window.is_visible().unwrap_or(true);
    let minimized = window.is_minimized().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(true);
    !visible || minimized || !focused
}

/// Aplica las decoraciones del sistema (barra de título y bordes) a la ventana principal.
pub fn apply_decorations<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    if let Some(w) = app.get_webview_window(MAIN_LABEL)
        && let Err(e) = w.set_decorations(enabled)
    {
        eprintln!("no se pudieron cambiar las decoraciones: {e}");
    }
}

/// Carga las preferencias del shell desde el almacén (las ausentes quedan por defecto).
fn load_prefs(state: &AppState) {
    let Some(store) = state.store.as_ref() else {
        return;
    };
    for key in [
        "notify_enabled",
        "notify_events",
        "tray_enabled",
        "close_to_tray",
        "window_decorations",
        "start_minimized",
    ] {
        if let Ok(Some(v)) = store.prefs_get(key) {
            state.shell.apply_pref(key, &v);
        }
    }
}

/// Arranque del shell (en `setup`): preferencias, decoraciones, bandeja, visibilidad inicial y
/// vigilante de eventos. Nada falla hacia fuera: sin bandeja la app sigue y se informa por
/// `tray_status`. La ventana se crea oculta (`visible: false`) para aplicar las decoraciones
/// sin parpadeo y SIEMPRE se muestra aquí, salvo «iniciar minimizado» con bandeja utilizable.
pub fn init_shell<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    load_prefs(&state);
    let prefs = state.shell.prefs();
    apply_decorations(app, prefs.window_decorations);

    let tray = crate::tray::setup_tray(app);
    if let Err(e) = &tray {
        eprintln!("bandeja no disponible, la app sigue sin ella: {e}");
    }
    state.shell.set_tray(tray);
    if let Some(t) = state.shell.tray() {
        t.set_visible(prefs.tray_enabled);
    }

    if prefs.start_minimized && state.shell.tray_usable() {
        // Arranca oculta: se recupera desde la bandeja.
        state.shell.set_hidden(true);
    } else {
        show_main(app);
    }
    tauri::async_runtime::spawn(crate::notify::run_watcher(app.clone()));
}

/// Una preferencia del shell cambió (tras `prefs_set`): se refleja en caliente.
pub fn on_pref_changed<R: Runtime>(app: &AppHandle<R>, key: &str, value: &serde_json::Value) {
    let state = app.state::<AppState>();
    if !state.shell.apply_pref(key, value) {
        return;
    }
    let prefs = state.shell.prefs();
    match key {
        "window_decorations" => apply_decorations(app, prefs.window_decorations),
        "tray_enabled" => {
            if let Some(t) = state.shell.tray() {
                t.set_visible(prefs.tray_enabled);
            }
            // Sin icono no hay forma de recuperar una ventana oculta.
            if !prefs.tray_enabled && state.shell.is_hidden() {
                show_main(app);
            }
        }
        _ => {}
    }
}

/// Cierre ordenado: primero aborta todas las tareas supervisadas (incluidos `compose up`/`pull`),
/// para que sus guardias maten los subprocesos antes de que el runtime de Tauri desaparezca;
/// después cierra terminales exec (con tope de 3 s) y el túnel SSH. Es idempotente: se puede
/// llamar antes de salir y otra vez al recibir `Exit`.
pub fn graceful_shutdown<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    state.streams.abort_all();
    tauri::async_runtime::block_on(state.exec_sessions.close_all(Duration::from_secs(3)));
    tauri::async_runtime::block_on(state.remote.deactivate());
}

/// Sale de la aplicación sin más preguntas.
pub fn quit_now<R: Runtime>(app: &AppHandle<R>) {
    app.state::<AppState>().shell.set_quitting(true);
    app.exit(0);
}

/// Petición de salida (menú «Salir» de la bandeja, `quit_app(false)`): sin operaciones en curso
/// sale; con operaciones muestra la ventana y pide confirmación a la UI. Si la UI no está
/// escuchando, sale igualmente para no dejar una aplicación imposible de cerrar.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let busy = state.busy_summary();
    if busy.is_idle() {
        quit_now(app);
        return;
    }
    show_main(app);
    if !state.shell.emit(AppFeed::QuitRequested { summary: busy }) {
        quit_now(app);
    }
}

/// `WindowEvent::CloseRequested` de la ventana principal.
pub fn on_close_requested<R: Runtime>(window: &Window<R>, api: &tauri::CloseRequestApi) {
    if window.label() != MAIN_LABEL {
        return;
    }
    let app = window.app_handle();
    let state = app.state::<AppState>();
    let action = decide_close(
        &state.shell.prefs(),
        state.shell.tray_alive(),
        state.busy_summary(),
        state.shell.is_quitting(),
    );
    match action {
        CloseAction::Allow => {}
        CloseAction::HideToTray => {
            api.prevent_close();
            hide_main(app);
        }
        CloseAction::AskConfirmation(summary) => {
            api.prevent_close();
            show_main(app);
            // Sin UI escuchando no se puede preguntar: se deja cerrar.
            if !state.shell.emit(AppFeed::QuitRequested { summary }) {
                state.shell.set_quitting(true);
                let _ = window.close();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direcciones_de_redimensionado_en_lista_cerrada() {
        let ok = [
            ("north", ResizeDirection::North),
            ("south", ResizeDirection::South),
            ("east", ResizeDirection::East),
            ("west", ResizeDirection::West),
            ("north_east", ResizeDirection::NorthEast),
            ("north_west", ResizeDirection::NorthWest),
            ("south_east", ResizeDirection::SouthEast),
            ("south_west", ResizeDirection::SouthWest),
        ];
        for (name, dir) in ok {
            assert_eq!(parse_resize_direction(name).unwrap(), dir, "{name}");
        }
        for bad in [
            "",
            "North",
            "up",
            "north-east",
            "north_east ",
            "../x",
            "center",
        ] {
            let e = parse_resize_direction(bad).unwrap_err();
            assert_eq!(e.code, ApiErrorCode::InvalidInput, "{bad}");
        }
    }
}
