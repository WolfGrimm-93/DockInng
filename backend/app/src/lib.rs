//! Shell de escritorio (Tauri): expone el núcleo al frontend mediante comandos IPC.
//! No contiene lógica de negocio; solo traduce entre la UI y `EngineClient`.

mod commands;
mod state;
mod streams;

use std::sync::Arc;

use engine_docker::DockerEngine;
use tauri::{Manager, RunEvent, WindowEvent};

use crate::state::AppState;

pub fn run() {
    // El motor se construye sin fallar: sin socket la app arranca y muestra el estado de conexión.
    let state = AppState::new(Arc::new(DockerEngine::new()));

    let built = tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::connection_status,
            commands::reconnect,
            commands::list_containers,
            commands::inspect_container,
            commands::container_stats_snapshot,
            commands::list_images,
            commands::list_volumes,
            commands::list_networks,
            commands::start_container,
            commands::stop_container,
            commands::restart_container,
            commands::plan_action,
            commands::execute_action,
            commands::cancel_action,
            commands::subscribe_engine_events,
            commands::subscribe_logs,
            commands::subscribe_stats,
            commands::unsubscribe,
            commands::reset_subscriptions,
        ])
        // Cierre de ventana: se cancelan sus streams y se invalidan los tickets pendientes.
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                state.streams.abort_for_window(window.label());
                state.actions.invalidate_all();
            }
        })
        .build(tauri::generate_context!());

    match built {
        Ok(app) => app.run(|handle, event| {
            if let RunEvent::Exit = event {
                handle.state::<AppState>().streams.abort_all();
            }
        }),
        Err(e) => {
            eprintln!("no se pudo iniciar DockInng: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use engine_docker::DockerEngine;
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
    use tauri::webview::InvokeRequest;

    use crate::state::AppState;

    fn request(cmd: &str, body: serde_json::Value) -> InvokeRequest {
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().expect("url"),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        }
    }

    /// Recorre el IPC real (ACL del manifest + capability + serialización) con un motor
    /// sin socket: la app NO entra en pánico y los comandos responden con datos tipados.
    #[test]
    fn ipc_con_acl_real_y_sin_socket_no_entra_en_panico() {
        let state = AppState::new(Arc::new(DockerEngine::with_socket(
            "/nonexistent/docker.sock",
        )));
        let app = mock_builder()
            .manage(state)
            .invoke_handler(tauri::generate_handler![
                crate::commands::connection_status,
                crate::commands::list_containers,
                crate::commands::plan_action,
            ])
            .build(tauri::generate_context!())
            .expect("app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("ventana");

        let JsonBody(status) = json(get_ipc_response(
            &webview,
            request("connection_status", serde_json::json!({})),
        ));
        assert_eq!(status["state"], "failed");
        assert_eq!(status["cause"], "socket_missing");

        let err = get_ipc_response(
            &webview,
            request("list_containers", serde_json::json!({"all": true})),
        )
        .expect_err("sin socket debe fallar");
        assert_eq!(err["code"], "connection");
        assert_eq!(err["cause"], "socket_missing");

        // prune_system nunca se ejecuta: el plan devuelve `deny`.
        let JsonBody(plan) = json(get_ipc_response(
            &webview,
            request(
                "plan_action",
                serde_json::json!({"request": {"type": "prune_system"}}),
            ),
        ));
        assert_eq!(plan["decision"]["type"], "deny");
        assert!(plan["ticket"].is_null());
    }

    /// Sin `core:default`: las suscripciones por `Channel` siguen funcionando bajo la ACL real.
    #[test]
    fn suscripcion_por_channel_funciona_sin_core_default() {
        let state = AppState::new(Arc::new(DockerEngine::with_socket(
            "/nonexistent/docker.sock",
        )));
        let app = mock_builder()
            .manage(state)
            .invoke_handler(tauri::generate_handler![
                crate::commands::subscribe_engine_events,
                crate::commands::subscribe_logs,
                crate::commands::unsubscribe,
                crate::commands::reset_subscriptions,
            ])
            .build(tauri::generate_context!())
            .expect("app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("ventana");
        let JsonBody(id) = json(get_ipc_response(
            &webview,
            request(
                "subscribe_engine_events",
                serde_json::json!({"onEvent": "__CHANNEL__:1"}),
            ),
        ));
        let id = id.as_str().expect("id de suscripción").to_string();
        assert_eq!(id.len(), 36);
        let JsonBody(_) = json(get_ipc_response(
            &webview,
            request(
                "subscribe_logs",
                serde_json::json!({
                    "id": "x", "tail": 10, "follow": false, "onEvent": "__CHANNEL__:2"
                }),
            ),
        ));
        json(get_ipc_response(
            &webview,
            request("unsubscribe", serde_json::json!({"subscriptionId": id})),
        ));
        json(get_ipc_response(
            &webview,
            request("reset_subscriptions", serde_json::json!({})),
        ));
    }

    struct JsonBody(serde_json::Value);

    fn json(r: Result<InvokeResponseBody, serde_json::Value>) -> JsonBody {
        match r.expect("respuesta OK") {
            InvokeResponseBody::Json(s) => JsonBody(serde_json::from_str(&s).expect("json")),
            InvokeResponseBody::Raw(_) => panic!("respuesta binaria inesperada"),
        }
    }

    // Los nombres de `command_names.rs` (permisos) deben coincidir con `generate_handler!`.
    include!("command_names.rs");

    #[test]
    fn permisos_y_handler_coinciden() {
        let src = include_str!("lib.rs");
        let handler = src
            .split("generate_handler![")
            .nth(1)
            .and_then(|s| s.split(']').next())
            .expect("generate_handler");
        let in_handler: Vec<&str> = handler
            .split(',')
            .filter_map(|s| s.trim().strip_prefix("commands::"))
            .collect();
        let mut a: Vec<&str> = in_handler.clone();
        let mut b: Vec<&str> = COMMAND_NAMES.to_vec();
        a.sort_unstable();
        b.sort_unstable();
        assert_eq!(a, b, "lista de comandos y de permisos desalineadas");
        // Y cada permiso del capability existe.
        let caps = include_str!("../capabilities/default.json");
        for n in COMMAND_NAMES {
            let perm = format!("\"allow-{}\"", n.replace('_', "-"));
            assert!(
                caps.contains(&perm),
                "falta el permiso {perm} en capabilities/default.json"
            );
        }
    }
}
