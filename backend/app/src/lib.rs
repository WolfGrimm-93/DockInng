//! Shell de escritorio (Tauri): expone el núcleo al frontend mediante comandos IPC.
//! No contiene lógica de negocio; solo traduce entre la UI y `EngineClient`.

use std::sync::Arc;

use engine_core::{Container, EngineClient};
use engine_docker::DockerEngine;
use tauri::State;

/// Motor compartido entre comandos. Se conecta una sola vez al arrancar.
struct AppState {
    engine: Arc<dyn EngineClient>,
}

#[tauri::command]
async fn list_containers(state: State<'_, AppState>, all: bool) -> Result<Vec<Container>, String> {
    state
        .engine
        .list_containers(all)
        .await
        .map_err(|e| e.to_string())
}

pub fn run() {
    // Conectar es perezoso en bollard: falla solo si la configuración es inválida.
    let engine = DockerEngine::connect().expect("configuración de Docker inválida");

    tauri::Builder::default()
        .manage(AppState {
            engine: Arc::new(engine),
        })
        .invoke_handler(tauri::generate_handler![list_containers])
        .run(tauri::generate_context!())
        .expect("error al ejecutar DockInng");
}
