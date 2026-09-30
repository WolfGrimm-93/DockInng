//! Shell de escritorio (Tauri): expone el núcleo al frontend mediante comandos IPC.
//! No contiene lógica de negocio; solo traduce entre la UI y `EngineClient`.

use std::sync::Arc;

use engine_core::{Container, EngineClient};
use engine_docker::DockerEngine;
use tauri::{Emitter, Manager, State, WindowEvent};

#[allow(dead_code)]
mod stack_ops;
mod window_ctl;

use window_ctl::{CloseConfirmation, CloseDecision, WindowController};

/// Motor compartido entre comandos. Se conecta una sola vez al arrancar.
struct AppState {
    engine: Arc<dyn EngineClient>,
    window: Arc<WindowController>,
}

#[tauri::command]
async fn list_containers(state: State<'_, AppState>, all: bool) -> Result<Vec<Container>, String> {
    state
        .engine
        .list_containers(all)
        .await
        .map_err(|e| e.to_string())
}

/// Registra el comienzo de una operación Compose. El contador vive en el
/// backend para que CloseRequested no deje trabajo huérfano.
#[tauri::command]
fn start_stack_operation(state: State<'_, AppState>) -> bool {
    state.window.operation_started()
}

#[tauri::command]
fn finish_stack_operation(state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    let may_exit = state.window.operation_finished();
    if may_exit {
        app.exit(0);
    }
    may_exit
}

#[tauri::command]
fn confirm_close(state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    match state.window.confirm_close() {
        CloseConfirmation::Exit => {
            app.exit(0);
            true
        }
        // El guard de la operación sigue vivo; el flujo Compose debe notificar
        // finish_stack_operation antes de permitir la salida.
        CloseConfirmation::WaitForOperations => false,
    }
}

#[tauri::command]
fn cancel_close(state: State<'_, AppState>) -> bool {
    state.window.cancel_close()
}

pub fn run() {
    // Conectar es perezoso en bollard: falla solo si la configuración es inválida.
    let engine = DockerEngine::connect().expect("configuración de Docker inválida");
    let window = Arc::new(WindowController::default());

    tauri::Builder::default()
        .manage(AppState {
            engine: Arc::new(engine),
            window,
        })
        .invoke_handler(tauri::generate_handler![
            list_containers,
            start_stack_operation,
            finish_stack_operation,
            confirm_close,
            cancel_close
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.window.close_requested() == CloseDecision::AskConfirmation {
                    api.prevent_close();
                    let active = state.window.active_operations();
                    let _ = window.emit("close-confirmation-required", active);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error al ejecutar DockInng");
}
