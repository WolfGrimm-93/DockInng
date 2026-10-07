//! Aprobación de acciones destructivas (T1): el webview NO puede fabricar la confirmación.
//! `execute_action(ticket, typed)` no tiene campo `confirmed`; la aprobación la concede un
//! diálogo NATIVO (aquí, `FakeApprovals`, que simula al usuario).

use std::sync::Arc;

use engine_core::ContainerState;
use engine_core::testing::MockEngine;
use engine_core::testing_create::MockCreate;
use engine_core::testing_exec::MockExec;
use engine_core::testing_pull::MockPull;
use engine_core::testing_stacks::MockStacks;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;

use crate::approvals::FakeApprovals;
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

fn json_of(
    r: Result<InvokeResponseBody, serde_json::Value>,
) -> Result<serde_json::Value, serde_json::Value> {
    r.map(|b| match b {
        InvokeResponseBody::Json(s) => serde_json::from_str(&s).expect("json"),
        InvokeResponseBody::Raw(_) => panic!("binaria"),
    })
}

fn state(engine: Arc<MockEngine>, approvals: Arc<FakeApprovals>) -> AppState {
    let mut st = AppState::with_parts(
        engine,
        Arc::new(MockExec::default()),
        Arc::new(MockPull { events: vec![] }),
        Arc::new(MockCreate::default()),
        Arc::new(MockStacks::default()),
        Arc::new(MockStacks::default()),
    );
    st.approvals = approvals;
    st
}

fn engine_con_contenedor_parado() -> Arc<MockEngine> {
    let e = Arc::new(MockEngine::new());
    e.state().containers.push(MockEngine::container(
        "c1",
        "parado",
        ContainerState::Exited,
        "t1",
    ));
    e
}

fn engine_con_volumen() -> Arc<MockEngine> {
    let e = Arc::new(MockEngine::new());
    e.state()
        .volumes
        .push(MockEngine::volume("libre", "t", &[]));
    e
}

macro_rules! webview {
    ($st:expr) => {{
        let app = mock_builder()
            .manage($st)
            .invoke_handler(tauri::generate_handler![
                crate::commands::plan_action,
                crate::commands::execute_action,
            ])
            .build(tauri::generate_context!())
            .expect("app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("ventana");
        (app, webview)
    }};
}

/// Un canje con `confirmed: true` enviado desde el webview NO debe ejecutar la acción: no hay
/// diálogo nativo que lo haya aprobado. (Antes de T1 este test fallaba: el bypass funcionaba.)
#[test]
fn webview_no_puede_autoconfirmar_con_confirmed_true() {
    let e = engine_con_contenedor_parado();
    let fake = FakeApprovals::new(false);
    let (_app, webview) = webview!(state(e.clone(), fake.clone()));
    let call = |cmd: &str, body: serde_json::Value| get_ipc_response(&webview, request(cmd, body));

    let plan = json_of(call(
        "plan_action",
        serde_json::json!({"request": {"type": "cleanup", "selection": {"containers": ["c1"]}}}),
    ))
    .expect("plan");
    assert_eq!(plan["decision"]["type"], "confirm");

    let r = json_of(call(
        "execute_action",
        serde_json::json!({"ticket": plan["ticket"], "typed": null, "confirmed": true}),
    ));
    assert!(r.is_err(), "el webview no debe poder autoconfirmar: {r:?}");
    assert_eq!(fake.pedidos().len(), 1, "el diálogo nativo sí se pidió");
    assert!(
        !e.calls().iter().any(|c| c.starts_with("remove_container")),
        "no se debe borrar nada sin aprobación: {:?}",
        e.calls()
    );
}

/// Con la aprobación nativa concedida, el canje funciona y el diálogo muestra la acción.
#[test]
fn aprobacion_nativa_concedida_ejecuta_y_muestra_la_accion() {
    let e = engine_con_contenedor_parado();
    let fake = FakeApprovals::new(true);
    let (_app, webview) = webview!(state(e.clone(), fake.clone()));
    let call = |cmd: &str, body: serde_json::Value| get_ipc_response(&webview, request(cmd, body));

    let plan = json_of(call(
        "plan_action",
        serde_json::json!({"request": {"type": "cleanup", "selection": {"containers": ["c1"]}}}),
    ))
    .expect("plan");
    let out = json_of(call(
        "execute_action",
        serde_json::json!({"ticket": plan["ticket"], "typed": null}),
    ))
    .expect("ejecuta");
    assert_eq!(out["succeeded"].as_array().unwrap().len(), 1);
    let pedidos = fake.pedidos();
    assert_eq!(pedidos.len(), 1);
    assert!(
        pedidos[0].lines.iter().any(|l| l.contains("parado")),
        "{pedidos:?}"
    );
    assert!(pedidos[0].typed_hint.is_none());
}

/// Si el usuario rechaza el diálogo, `PolicyDenied` y el ticket NO se consume: al aceptarlo
/// después, el mismo ticket sirve.
#[test]
fn aprobacion_rechazada_no_consume_el_ticket() {
    let e = engine_con_contenedor_parado();
    let fake = FakeApprovals::new(false);
    let (_app, webview) = webview!(state(e.clone(), fake.clone()));
    let call = |cmd: &str, body: serde_json::Value| get_ipc_response(&webview, request(cmd, body));

    let plan = json_of(call(
        "plan_action",
        serde_json::json!({"request": {"type": "cleanup", "selection": {"containers": ["c1"]}}}),
    ))
    .expect("plan");
    let err = json_of(call(
        "execute_action",
        serde_json::json!({"ticket": plan["ticket"], "typed": null}),
    ))
    .expect_err("rechazado");
    assert_eq!(err["code"], "policy_denied");
    assert!(e.calls().iter().all(|c| !c.starts_with("remove_container")));

    fake.fijar(true);
    let out = json_of(call(
        "execute_action",
        serde_json::json!({"ticket": plan["ticket"], "typed": null}),
    ))
    .expect("ahora sí");
    assert_eq!(out["succeeded"].as_array().unwrap().len(), 1);
}

/// `ConfirmTyped`: el diálogo nativo aparece igual y además el texto se valida en el núcleo.
#[test]
fn confirm_typed_pide_dialogo_y_luego_el_texto() {
    let e = engine_con_volumen();
    let fake = FakeApprovals::new(true);
    let (_app, webview) = webview!(state(e.clone(), fake.clone()));
    let call = |cmd: &str, body: serde_json::Value| get_ipc_response(&webview, request(cmd, body));

    let plan = json_of(call(
        "plan_action",
        serde_json::json!({"request": {"type": "cleanup", "selection": {"volumes": ["libre"]}}}),
    ))
    .expect("plan");
    assert_eq!(plan["decision"]["type"], "confirm_typed");

    // Texto incorrecto: el diálogo se muestra, pero el núcleo rechaza el texto.
    let err = json_of(call(
        "execute_action",
        serde_json::json!({"ticket": plan["ticket"], "typed": "no"}),
    ))
    .expect_err("texto mal");
    assert_eq!(err["code"], "typed_mismatch");
    // Texto correcto: se ejecuta.
    let out = json_of(call(
        "execute_action",
        serde_json::json!({"ticket": plan["ticket"], "typed": "ELIMINAR"}),
    ))
    .expect("ok");
    assert_eq!(out["succeeded"].as_array().unwrap().len(), 1);
    let pedidos = fake.pedidos();
    assert_eq!(pedidos.len(), 2, "un diálogo por intento");
    assert_eq!(pedidos[0].typed_hint.as_deref(), Some("ELIMINAR"));
}

/// Sin diálogo real (estado por defecto), nada se canjea.
#[test]
fn sin_origen_de_aprobacion_nada_se_canjea() {
    let e = engine_con_contenedor_parado();
    let app_state = AppState::with_parts(
        e.clone(),
        Arc::new(MockExec::default()),
        Arc::new(MockPull { events: vec![] }),
        Arc::new(MockCreate::default()),
        Arc::new(MockStacks::default()),
        Arc::new(MockStacks::default()),
    );
    let (_app, webview) = webview!(app_state);
    let call = |cmd: &str, body: serde_json::Value| get_ipc_response(&webview, request(cmd, body));
    let plan = json_of(call(
        "plan_action",
        serde_json::json!({"request": {"type": "cleanup", "selection": {"containers": ["c1"]}}}),
    ))
    .expect("plan");
    let err = json_of(call(
        "execute_action",
        serde_json::json!({"ticket": plan["ticket"], "typed": null}),
    ))
    .expect_err("sin aprobación");
    assert_eq!(err["code"], "policy_denied");
    assert!(e.calls().iter().all(|c| !c.starts_with("remove_container")));
}
