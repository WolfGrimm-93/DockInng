//! Tests del shell de escritorio (Ola 3) bajo la ACL real de Tauri: bandeja, notificaciones,
//! salida controlada, ventana propia y «abrir puerto». Sin sesión gráfica: la ventana es la del
//! runtime simulado y la bandeja/notificaciones se sustituyen por dobles.

use std::path::PathBuf;
use std::sync::Arc;

use engine_core::ContainerState;
use engine_core::PortMapping;
use engine_core::testing::MockEngine;
use engine_core::testing_create::MockCreate;
use engine_core::testing_exec::MockExec;
use engine_core::testing_pull::MockPull;
use engine_core::testing_stacks::MockStacks;
use serde_json::{Value, json};
use store::Store;
use tauri::Manager;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;

use crate::notify::testing::MockNotifier;
use crate::shell::ShellState;
use crate::state::AppState;

fn request(cmd: &str, body: Value) -> InvokeRequest {
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

fn tempdir(tag: &str) -> PathBuf {
    let d = PathBuf::from("/tmp").join(format!(
        "dktest-shell-{tag}-{}",
        &uuid::Uuid::now_v7().simple().to_string()[20..]
    ));
    std::fs::create_dir_all(&d).expect("tempdir");
    d
}

struct Harness {
    webview: tauri::WebviewWindow<tauri::test::MockRuntime>,
    app: tauri::App<tauri::test::MockRuntime>,
    notifier: Arc<MockNotifier>,
    dir: Option<PathBuf>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        if let Some(d) = &self.dir {
            let _ = std::fs::remove_dir_all(d);
        }
    }
}

fn harness(tag: &str, with_store: bool) -> Harness {
    let engine = Arc::new(MockEngine::new());
    {
        let mut s = engine.state();
        let mut web = MockEngine::container("c1", "web", ContainerState::Running, "t");
        web.summary.ports = vec![PortMapping {
            ip: None,
            private_port: 80,
            public_port: Some(8080),
            protocol: "tcp".into(),
        }];
        s.containers.push(web);
    }
    let mut state = AppState::with_parts(
        engine,
        Arc::new(MockExec::default()),
        Arc::new(MockPull { events: vec![] }),
        Arc::new(MockCreate::default()),
        Arc::new(MockStacks::default()),
        Arc::new(MockStacks::default()),
    );
    let notifier = MockNotifier::new();
    state.shell = ShellState::with_notifier(notifier.clone());
    let dir = with_store.then(|| tempdir(tag));
    if let Some(d) = &dir {
        state.store = Some(Arc::new(Store::open(&d.join("data")).expect("store")));
    }
    let app = mock_builder()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            crate::commands_shell::tray_status,
            crate::commands_shell::notify_user,
            crate::commands_shell::busy_summary,
            crate::commands_shell::subscribe_app_events,
            crate::commands_window::window_set_decorations,
            crate::commands_window::window_minimize,
            crate::commands_window::window_toggle_maximize,
            crate::commands_window::window_start_resize,
            crate::commands_open::open_port_in_browser,
            crate::commands_store::prefs_get,
            crate::commands_store::prefs_set,
        ])
        .build(tauri::generate_context!())
        .expect("app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("ventana");
    Harness {
        webview,
        app,
        notifier,
        dir,
    }
}

impl Harness {
    fn call(&self, cmd: &str, body: Value) -> Result<Value, Value> {
        get_ipc_response(&self.webview, request(cmd, body)).map(|r| match r {
            InvokeResponseBody::Json(s) => serde_json::from_str(&s).expect("json"),
            InvokeResponseBody::Raw(_) => panic!("respuesta binaria inesperada"),
        })
    }

    fn ok(&self, cmd: &str, body: Value) -> Value {
        self.call(cmd, body)
            .unwrap_or_else(|e| panic!("{cmd} falló: {e}"))
    }

    fn state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }
}

#[test]
fn estado_de_bandeja_y_resumen_de_ocupacion() {
    let h = harness("tray", false);
    assert_eq!(
        h.ok("tray_status", json!({})),
        json!({"available": false, "error": null})
    );
    h.state().shell.set_tray(Err("sin libappindicator".into()));
    assert_eq!(
        h.ok("tray_status", json!({})),
        json!({"available": false, "error": "sin libappindicator"})
    );
    assert_eq!(
        h.ok("busy_summary", json!({})),
        json!({"stacks": 0, "pulls": 0, "builds": 0, "terminals": 0})
    );
    // Una descarga en curso se refleja en el resumen.
    let _permit = h.state().pulls.acquire("main", "nginx:latest").unwrap();
    assert_eq!(h.ok("busy_summary", json!({}))["pulls"], 1);
    assert!(!h.state().busy_summary().is_idle());
}

#[test]
fn notify_user_valida_y_respeta_las_preferencias() {
    let h = harness("notify", false);
    // Validación: tipo fuera de la lista, título vacío o demasiado largo.
    for body in [
        json!({"kind": "start", "title": "x", "body": ""}),
        json!({"kind": "die", "title": "  ", "body": ""}),
        json!({"kind": "die", "title": "a".repeat(81), "body": ""}),
        json!({"kind": "die", "title": "t", "body": "b".repeat(241)}),
    ] {
        let e = h.call("notify_user", body.clone()).unwrap_err();
        assert_eq!(e["code"], "invalid_input", "{body}");
    }
    // Desactivadas (valor por defecto): responde bien y no muestra nada.
    h.ok(
        "notify_user",
        json!({"kind": "die", "title": "web cayó", "body": ""}),
    );
    assert!(h.notifier.shown().is_empty());
    // Activadas: se muestra limpio de marcado y el duplicado inmediato se silencia.
    h.state().shell.apply_pref("notify_enabled", &json!(true));
    let msg = json!({"kind": "die", "title": "web <b>cayó</b>", "body": "código & 1"});
    h.ok("notify_user", msg.clone());
    h.ok("notify_user", msg);
    let shown = h.notifier.shown();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].title, "web bcayó/b");
    assert_eq!(shown[0].body, "código 1");
}

#[test]
fn ventana_propia_valida_direcciones_y_aplica_decoraciones() {
    let h = harness("window", false);
    let e = h
        .call("window_start_resize", json!({"direction": "arriba"}))
        .unwrap_err();
    assert_eq!(e["code"], "invalid_input");
    h.ok("window_toggle_maximize", json!({}));
    h.ok("window_minimize", json!({}));
    // Sin almacén: se aplica en caliente y queda en las preferencias en memoria.
    h.ok("window_set_decorations", json!({"enabled": false}));
    assert!(!h.state().shell.prefs().window_decorations);
    h.ok("window_set_decorations", json!({"enabled": true}));
    assert!(h.state().shell.prefs().window_decorations);
}

#[test]
fn las_preferencias_del_shell_se_validan_y_se_aplican_en_caliente() {
    let h = harness("prefs", true);
    assert!(!h.state().shell.prefs().close_to_tray);
    h.ok("prefs_set", json!({"key": "close_to_tray", "value": true}));
    assert!(h.state().shell.prefs().close_to_tray);
    assert_eq!(
        h.ok("prefs_get", json!({"key": "close_to_tray"})),
        json!(true)
    );
    // Un valor inválido se rechaza y NO altera el estado.
    let e = h
        .call("prefs_set", json!({"key": "close_to_tray", "value": "si"}))
        .unwrap_err();
    assert_eq!(e["code"], "invalid_input");
    assert!(h.state().shell.prefs().close_to_tray);
    h.ok(
        "prefs_set",
        json!({"key": "notify_events", "value": {"oom": false}}),
    );
    assert!(!h.state().shell.prefs().notify_events.oom);
    let e = h
        .call(
            "prefs_set",
            json!({"key": "notify_events", "value": {"otro": true}}),
        )
        .unwrap_err();
    assert_eq!(e["code"], "invalid_input");
    // Ocultar el icono con la ventana oculta la vuelve a mostrar (si no, sería inalcanzable).
    let tray = crate::tray::testing::MockTray::new();
    h.state().shell.set_tray(Ok(tray.clone()));
    h.state().shell.set_hidden(true);
    h.ok("prefs_set", json!({"key": "tray_enabled", "value": false}));
    assert_eq!(tray.visibility(), vec![false]);
    assert!(!h.state().shell.is_hidden());
    h.ok("prefs_set", json!({"key": "tray_enabled", "value": true}));
    assert_eq!(tray.visibility(), vec![false, true]);
    // window_set_decorations persiste con almacén.
    h.ok("window_set_decorations", json!({"enabled": false}));
    assert_eq!(
        h.ok("prefs_get", json!({"key": "window_decorations"})),
        json!(false)
    );
}

#[test]
fn suscripcion_a_eventos_de_la_app_sin_core_default() {
    let h = harness("feed", false);
    h.ok("subscribe_app_events", json!({"onEvent": "__CHANNEL__:1"}));
}

#[test]
fn abrir_puerto_rechaza_lo_que_no_publica_el_contenedor() {
    let h = harness("open", false);
    for (body, code) in [
        (
            json!({"id": "c1", "port": 8080, "scheme": "file"}),
            "invalid_input",
        ),
        (
            json!({"id": "c1", "port": 9999, "scheme": "http"}),
            "invalid_input",
        ),
        (
            json!({"id": "c1", "port": 70000, "scheme": "http"}),
            "invalid_input",
        ),
        (
            json!({"id": "zzz", "port": 8080, "scheme": "http"}),
            "not_found",
        ),
    ] {
        let e = h.call("open_port_in_browser", body.clone()).unwrap_err();
        assert_eq!(e["code"], code, "{body}");
    }
}
