//! Tests de las herramientas de la Ola 2 bajo la ACL real de Tauri: informe de limpieza (solo
//! lectura), plan/ejecución de `cleanup` por elemento, planes de build y detección de Podman.

use std::sync::Arc;

use engine_core::testing::MockEngine;
use engine_core::testing_create::MockCreate;
use engine_core::testing_exec::MockExec;
use engine_core::testing_pull::MockPull;
use engine_core::testing_stacks::MockStacks;
use engine_core::{BuildFeed, BuildOutcome, ContainerState};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tokio::sync::mpsc;

use crate::build_feed::start_build;
use crate::state::AppState;
use crate::streams::Sink;

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

fn ok(r: Result<InvokeResponseBody, serde_json::Value>) -> serde_json::Value {
    match r.expect("respuesta OK") {
        InvokeResponseBody::Json(s) => serde_json::from_str(&s).expect("json"),
        InvokeResponseBody::Raw(_) => panic!("binaria"),
    }
}

fn state(engine: Arc<MockEngine>) -> AppState {
    AppState::with_parts(
        engine,
        Arc::new(MockExec::default()),
        Arc::new(MockPull { events: vec![] }),
        Arc::new(MockCreate::default()),
        Arc::new(MockStacks::default()),
        Arc::new(MockStacks::default()),
    )
}

fn engine() -> Arc<MockEngine> {
    let e = Arc::new(MockEngine::new());
    {
        let mut s = e.state();
        s.containers.push(MockEngine::container(
            "c1",
            "parado",
            ContainerState::Exited,
            "t1",
        ));
        s.images.push(MockEngine::image("sha256:aa", "sobra:1", 0));
        s.volumes.push(MockEngine::volume("libre", "t", &[]));
        s.networks
            .push(MockEngine::network("n1", "sobra", &[], false));
    }
    e
}

#[test]
fn ipc_de_herramientas_bajo_la_acl_real() {
    let e = engine();
    let app = mock_builder()
        .manage(state(e.clone()))
        .invoke_handler(tauri::generate_handler![
            crate::commands_tools::build_plan,
            crate::commands_tools::cleanup_report,
            crate::commands_tools::podman_detect,
            crate::commands::plan_action,
            crate::commands::execute_action,
        ])
        .build(tauri::generate_context!())
        .expect("app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("ventana");
    let call = |cmd: &str, body: serde_json::Value| get_ipc_response(&webview, request(cmd, body));

    // Informe: solo lectura y con la forma que espera el frontend.
    let r = ok(call("cleanup_report", serde_json::json!({"minAgeDays": 0})));
    let cats = r["categories"].as_array().expect("categorías");
    let ids: Vec<&str> = cats.iter().map(|c| c["id"].as_str().unwrap()).collect();
    assert_eq!(
        ids,
        [
            "stopped_containers",
            "dangling_images",
            "unused_images",
            "unused_volumes",
            "unused_networks",
            "build_cache"
        ]
    );
    assert!(r["generated_at"].as_str().unwrap().ends_with('Z'));
    let vols = &cats[3]["items"][0];
    assert_eq!(vols["risk"], "high");
    assert_eq!(vols["selected_by_default"], false);
    assert!(
        e.calls()
            .iter()
            .all(|c| c.starts_with("list_") || c.starts_with("system_usage")),
        "{:?}",
        e.calls()
    );
    // Sin argumento también vale.
    let _ = ok(call("cleanup_report", serde_json::json!({})));

    // Plan + ejecución de la limpieza por elemento (sin volúmenes: confirmación simple).
    let plan = ok(call(
        "plan_action",
        serde_json::json!({"request": {"type": "cleanup", "selection": {
            "containers": ["c1"], "images": ["sobra:1"], "networks": ["n1"]
        }}}),
    ));
    assert_eq!(plan["decision"]["type"], "confirm");
    assert_eq!(plan["affected"].as_array().unwrap().len(), 3);
    let out = ok(call(
        "execute_action",
        serde_json::json!({"ticket": plan["ticket"], "typed": null}),
    ));
    assert_eq!(out["succeeded"].as_array().unwrap().len(), 3);
    assert!(out["failed"].as_array().unwrap().is_empty());
    // Con un volumen se exige ELIMINAR.
    let plan = ok(call(
        "plan_action",
        serde_json::json!({"request": {"type": "cleanup", "selection": {"volumes": ["libre"]}}}),
    ));
    assert_eq!(plan["decision"]["type"], "confirm_typed");
    assert_eq!(plan["decision"]["expected"], "ELIMINAR");
    // Una selección vacía o que apunta a algo en uso se rechaza.
    let bad = call(
        "plan_action",
        serde_json::json!({"request": {"type": "cleanup", "selection": {}}}),
    )
    .expect_err("vacía");
    assert_eq!(bad["code"], "invalid_input");

    // Build: plan de un contexto normal (sin ticket) y errores tipados.
    let dir =
        std::env::temp_dir().join(format!("dockinng-test-app-build-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).unwrap();
    let plan = ok(call(
        "build_plan",
        serde_json::json!({"spec": {
            "context_dir": dir.display().to_string(), "dockerfile": null, "tag": null,
            "build_args": [["NPM_TOKEN", "x"]], "target": null, "no_cache": false, "pull": false
        }}),
    ));
    assert_eq!(plan["decision"]["type"], "allow");
    assert!(plan["ticket"].is_null());
    assert_eq!(plan["warnings"][0]["type"], "secret_like_arg");
    let bad = call(
        "build_plan",
        serde_json::json!({"spec": {
            "context_dir": "/no/existe/dockinng-test", "dockerfile": null, "tag": null,
            "build_args": [], "target": null, "no_cache": false, "pull": false
        }}),
    )
    .expect_err("no existe");
    assert_eq!(bad["code"], "invalid_input");
    let _ = std::fs::remove_dir_all(&dir);

    // Podman: lista (vacía o no según la máquina) con la forma esperada.
    let p = ok(call("podman_detect", serde_json::json!({})));
    for c in p.as_array().expect("lista") {
        assert!(c["path"].is_string() && c["rootless"].is_boolean() && c["source"].is_string());
    }
}

struct ChanSink(mpsc::UnboundedSender<BuildFeed>);
impl Sink<BuildFeed> for ChanSink {
    fn send(&self, item: BuildFeed) -> bool {
        self.0.send(item).is_ok()
    }
}

#[tokio::test]
async fn subscribe_build_rechaza_de_forma_sincrona_una_especificacion_invalida() {
    let st = state(engine());
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn Sink<BuildFeed>> = Arc::new(ChanSink(tx));
    let spec = engine_core::BuildSpec {
        context_dir: "/no/existe/dockinng-test".into(),
        dockerfile: None,
        tag: None,
        build_args: vec![],
        target: None,
        no_cache: false,
        pull: false,
    };
    let e = start_build(&st, "main", spec, None, sink).expect_err("inválida");
    assert_eq!(e.code, engine_core::ApiErrorCode::InvalidInput);
}

/// Un contexto válido arranca la tarea y SIEMPRE termina con `Ended` (con o sin `docker`).
#[tokio::test]
async fn subscribe_build_termina_siempre_con_ended() {
    let st = state(engine());
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn Sink<BuildFeed>> = Arc::new(ChanSink(tx));
    let dir =
        std::env::temp_dir().join(format!("dockinng-test-app-build-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).unwrap();
    // Sin Dockerfile: `docker build` falla (o no hay docker): ambos acaban en `failed`.
    let spec = engine_core::BuildSpec {
        context_dir: dir.display().to_string(),
        dockerfile: None,
        tag: None,
        build_args: vec![],
        target: None,
        no_cache: false,
        pull: false,
    };
    start_build(&st, "main", spec, None, sink).expect("arranca");
    let last = loop {
        let f = tokio::time::timeout(std::time::Duration::from_secs(30), rx.recv())
            .await
            .expect("a tiempo")
            .expect("feed");
        if matches!(f, BuildFeed::Ended { .. }) {
            break f;
        }
    };
    let _ = std::fs::remove_dir_all(&dir);
    match last {
        BuildFeed::Ended { outcome, error, .. } => {
            assert_eq!(outcome, BuildOutcome::Failed);
            assert!(error.is_some());
        }
        _ => unreachable!(),
    }
}
