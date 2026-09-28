//! Shell de escritorio (Tauri): expone el núcleo al frontend mediante comandos IPC.
//! No contiene lógica de negocio; solo traduce entre la UI y `EngineClient`.

mod build_feed;
mod commands;
mod commands_engine;
mod commands_open;
mod commands_remote;
mod commands_shell;
mod commands_stacks;
mod commands_store;
mod commands_tools;
mod commands_window;
mod exec_sessions;
mod gpu;
mod notify;
mod pull_feed;
mod shell;
mod stack_ops;
mod state;
mod streams;
mod switch;
mod tray;
mod window_ctl;

#[cfg(test)]
mod contract_fixtures;
#[cfg(test)]
mod tests_engine;
#[cfg(test)]
mod tests_shell;
#[cfg(test)]
mod tests_stacks;
#[cfg(test)]
mod tests_store;
#[cfg(test)]
mod tests_tools;

use std::sync::Arc;

use engine_docker::DockerEngine;
use store::Store;
use tauri::{Manager, RunEvent, WindowEvent};

use crate::state::AppState;

pub fn run() {
    // El motor se construye sin fallar: sin socket la app arranca y muestra el estado de conexión.
    let mut state = AppState::new(Arc::new(DockerEngine::new()));
    // La persistencia es opcional: si falla, la app arranca igualmente (sin grupos ni perfiles).
    match Store::open_default() {
        Ok(s) => state.store = Some(Arc::new(s)),
        Err(e) => state.store_error = Some(e.to_string()),
    }
    // Sockets de túneles huérfanos de una ejecución anterior (p. ej. tras un cierre brusco).
    state.remote.purge_stale();

    let built = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            commands::system_usage,
            commands::gpu_status,
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
            commands_stacks::compose_info,
            commands_stacks::list_stacks,
            commands_stacks::stack_read,
            commands_stacks::stack_save,
            commands_stacks::stack_validate,
            commands_stacks::stack_create,
            commands_stacks::stack_link,
            commands_stacks::stack_unlink,
            commands_stacks::run_stack_op,
            commands_stacks::cancel_stack_op,
            commands_engine::subscribe_exec,
            commands_engine::exec_write,
            commands_engine::exec_resize,
            commands_engine::exec_close,
            commands_engine::subscribe_pull,
            commands_engine::plan_create_container,
            commands_engine::create_container,
            commands_engine::create_volume,
            commands_engine::create_network,
            commands_store::groups_load,
            commands_store::groups_mutate,
            commands_store::groups_import_legacy,
            commands_store::prefs_get,
            commands_store::prefs_set,
            commands_remote::connection_list,
            commands_remote::connection_probe_host_key,
            commands_remote::connection_trust_host_key,
            commands_remote::connection_test,
            commands_remote::connection_save,
            commands_remote::connection_delete,
            commands_remote::connection_select,
            commands_store::registry_list,
            commands_store::registry_save,
            commands_store::registry_delete,
            commands_store::registry_test,
            commands_tools::build_plan,
            commands_tools::subscribe_build,
            commands_tools::cleanup_report,
            commands_tools::podman_detect,
            commands_open::open_port_in_browser,
            commands_shell::tray_status,
            commands_shell::notify_user,
            commands_shell::busy_summary,
            commands_shell::quit_app,
            commands_shell::subscribe_app_events,
            commands_window::window_set_decorations,
            commands_window::window_minimize,
            commands_window::window_toggle_maximize,
            commands_window::window_close,
            commands_window::window_start_drag,
            commands_window::window_start_resize,
        ])
        // Bandeja, preferencias de ventana y notificaciones (nada de esto es fatal si falla).
        .setup(|app| {
            window_ctl::init_shell(app.handle());
            Ok(())
        })
        // Cada carga/recarga de página aborta lo anterior de esa ventana ANTES de que corra su
        // JS: sus canales ya no existen y `reset_subscriptions` no puede pisar lo nuevo.
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                webview
                    .app_handle()
                    .state::<AppState>()
                    .streams
                    .begin_page(webview.label());
            }
        })
        // Cierre de ventana: se cancelan sus streams y se invalidan los tickets pendientes.
        .on_window_event(|window, event| match event {
            // Cierre controlado desde el backend: bandeja, confirmación con operaciones en
            // curso o cierre normal (nada de `beforeunload` en la webview).
            WindowEvent::CloseRequested { api, .. } => {
                window_ctl::on_close_requested(window, api);
            }
            WindowEvent::Destroyed => {
                let state = window.state::<AppState>();
                state.streams.abort_for_window(window.label());
                state.actions.invalidate_all();
                state.create.invalidate_all();
            }
            _ => {}
        })
        .build(tauri::generate_context!());

    match built {
        Ok(app) => app.run(|handle, event| {
            match event {
                // Antes de salir se cierran las terminales (matan su shell dentro del
                // contenedor); con tope de 3 s para no bloquear el cierre.
                // Además cierra el túnel SSH (mata sus `ssh` y borra el socket).
                RunEvent::ExitRequested { .. } => window_ctl::graceful_shutdown(handle),
                RunEvent::Exit => {
                    let state = handle.state::<AppState>();
                    state.streams.abort_all();
                    window_ctl::graceful_shutdown(handle);
                }
                _ => {}
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
            .filter_map(|s| {
                let s = s.trim();
                // Acepta cualquier módulo `commands*::` (commands, commands_stacks, commands_engine).
                let (module, name) = s.split_once("::")?;
                module.starts_with("commands").then_some(name)
            })
            .collect();
        let mut a: Vec<&str> = in_handler.clone();
        let mut b: Vec<&str> = COMMAND_NAMES.to_vec();
        a.sort_unstable();
        b.sort_unstable();
        assert_eq!(a, b, "lista de comandos y de permisos desalineadas");
        // Bidireccional: ningún `allow-*` del capability sin comando (permiso huérfano).
        let caps_json: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).expect("json");
        let mut in_caps: Vec<String> = caps_json["permissions"]
            .as_array()
            .expect("permissions")
            .iter()
            .filter_map(|p| p.as_str())
            .filter(|p| p.starts_with("allow-"))
            .map(String::from)
            .collect();
        in_caps.sort_unstable();
        let mut expected: Vec<String> = COMMAND_NAMES
            .iter()
            .map(|n| format!("allow-{}", n.replace('_', "-")))
            .collect();
        expected.sort_unstable();
        assert_eq!(
            in_caps, expected,
            "sobran o faltan permisos en capabilities/default.json"
        );
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
