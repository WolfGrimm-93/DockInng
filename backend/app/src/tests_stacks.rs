//! Tests de stacks: operaciones con progreso, límites, cancelación, aislamiento entre ventanas
//! y los comandos IPC bajo la ACL real de Tauri (con `docker compose` simulado por `FakeSpawn`).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use compose::ComposeRunner;
use compose::fakes::{FakeSpawn, Script};
use compose::files::StackStore;
use compose::runner::Limits;
use engine_core::testing::MockEngine;
use engine_core::testing_create::MockCreate;
use engine_core::testing_exec::MockExec;
use engine_core::testing_pull::MockPull;
use engine_core::testing_stacks::MockStacks;
use engine_core::{
    ApiErrorCode, ComposeContainer, ContainerState, StackOp, StackOpFeed, StackOutcome,
};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tokio::sync::mpsc;

use crate::stack_ops::start_stack_op;
use crate::state::AppState;
use crate::streams::{MAX_STACK_OPS, Sink};

const CONFIG: &str = include_str!("../../crates/compose/tests/fixtures/config.json");
const UP: &str = include_str!("../../crates/compose/tests/fixtures/up_progress_json.ndjson");
const YAML: &str = "services:\n  sleeper:\n    image: alpine:latest\n";

struct ChanSink<T>(mpsc::UnboundedSender<T>);
impl<T: Send + 'static> Sink<T> for ChanSink<T> {
    fn send(&self, item: T) -> bool {
        self.0.send(item).is_ok()
    }
}
fn chan() -> (
    Arc<dyn Sink<StackOpFeed>>,
    mpsc::UnboundedReceiver<StackOpFeed>,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    (Arc::new(ChanSink(tx)), rx)
}

struct TmpDir(PathBuf);
impl Drop for TmpDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Rig {
    state: AppState,
    mock_stacks: Arc<MockStacks>,
    _tmp: TmpDir,
}

fn rig(fake: Arc<FakeSpawn>) -> Rig {
    let tmp = TmpDir(std::env::temp_dir().join(format!(
        "dockinng-app-stacks-{}-{}",
        std::process::id(),
        uuid::Uuid::now_v7().simple()
    )));
    std::fs::create_dir_all(&tmp.0).unwrap();
    let fake = fake.with_compose_5();
    let runner = ComposeRunner::with_parts(
        Some("unix:///run/dockinng-test.sock".into()),
        fake,
        Limits {
            flush_every: Duration::from_millis(10),
            term_grace: Duration::from_millis(300),
            ..Limits::default()
        },
        StackStore::new(tmp.0.join("stacks")),
    );
    let mock_stacks = Arc::new(MockStacks::default());
    let engine = Arc::new(MockEngine::new());
    let state = AppState::with_parts(
        engine,
        Arc::new(MockExec::default()),
        Arc::new(MockPull { events: vec![] }),
        Arc::new(MockCreate::default()),
        mock_stacks.clone(),
        Arc::new(runner),
    );
    Rig {
        state,
        mock_stacks,
        _tmp: tmp,
    }
}

async fn create(r: &Rig, name: &str) {
    r.state
        .stacks
        .control
        .stack_create(name, YAML, "")
        .await
        .unwrap();
}

async fn ended(rx: &mut mpsc::UnboundedReceiver<StackOpFeed>) -> Vec<StackOpFeed> {
    let mut all = Vec::new();
    loop {
        let e = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("a tiempo")
            .expect("feed");
        let end = matches!(e, StackOpFeed::Ended { .. });
        all.push(e);
        if end {
            return all;
        }
    }
}

#[tokio::test]
async fn operacion_completa_por_el_servicio_con_progreso_y_fin() {
    let fake = FakeSpawn::new();
    fake.on(
        "config --format json",
        Script::default().stdout(&CONFIG.replace("dockinng-test-recon", "web")),
    );
    fake.on(
        " up ",
        Script::lines(&UP.replace("dockinng-test-recon", "web")),
    );
    let r = rig(fake);
    create(&r, "web").await;
    let (sink, mut rx) = chan();
    let id = start_stack_op(
        &r.state.streams,
        &r.state.stacks,
        "main",
        "web",
        StackOp::Up { services: None },
        sink,
    )
    .await
    .unwrap();
    assert_eq!(id.len(), 36);
    let feeds = ended(&mut rx).await;
    assert!(matches!(feeds[0], StackOpFeed::Started { .. }));
    assert!(
        feeds
            .iter()
            .any(|f| matches!(f, StackOpFeed::Progress { .. }))
    );
    assert!(matches!(
        feeds.last().unwrap(),
        StackOpFeed::Ended {
            outcome: StackOutcome::Success,
            ..
        }
    ));
}

#[tokio::test]
async fn errores_previos_se_devuelven_al_comando_sin_lanzar_tarea() {
    let r = rig(FakeSpawn::new());
    create(&r, "web").await;
    let (sink, _rx) = chan();
    for bad in ["../x", "A", "a/b", ""] {
        let e = start_stack_op(
            &r.state.streams,
            &r.state.stacks,
            "main",
            bad,
            StackOp::Stop { services: None },
            sink.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, ApiErrorCode::InvalidInput, "{bad:?}");
    }
    let e = start_stack_op(
        &r.state.streams,
        &r.state.stacks,
        "main",
        "web",
        StackOp::Up {
            services: Some(vec!["--evil".into()]),
        },
        sink,
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ApiErrorCode::InvalidInput);
    assert_eq!(r.state.streams.total(), 0);
}

#[tokio::test]
async fn cuarta_operacion_simultanea_es_conflict_y_no_deja_el_stack_ocupado() {
    let fake = FakeSpawn::new();
    fake.on(
        " stop ",
        Script::default().then_sleep(Duration::from_secs(30)),
    );
    let r = rig(fake);
    let names: Vec<String> = (0..=MAX_STACK_OPS).map(|i| format!("s{i}")).collect();
    for n in &names {
        create(&r, n).await;
    }
    let mut ids = Vec::new();
    let mut rxs = Vec::new();
    for n in names.iter().take(MAX_STACK_OPS) {
        let (sink, rx) = chan();
        rxs.push(rx);
        ids.push(
            start_stack_op(
                &r.state.streams,
                &r.state.stacks,
                "main",
                n,
                StackOp::Stop { services: None },
                sink,
            )
            .await
            .unwrap(),
        );
    }
    let (sink, _rx) = chan();
    let last = names.last().unwrap();
    let e = start_stack_op(
        &r.state.streams,
        &r.state.stacks,
        "main",
        last,
        StackOp::Stop { services: None },
        sink.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ApiErrorCode::Conflict);
    // Otra ventana tiene su propio cupo, y el stack rechazado quedó libre.
    start_stack_op(
        &r.state.streams,
        &r.state.stacks,
        "otra",
        last,
        StackOp::Stop { services: None },
        sink,
    )
    .await
    .unwrap();
    r.state.streams.abort_all();
}

#[tokio::test]
async fn cancelar_es_solo_de_la_ventana_duena() {
    let fake = FakeSpawn::new();
    fake.on(
        " stop ",
        Script::default()
            .then_sleep(Duration::from_secs(30))
            .on_term(&[r#"{"error":true}"#], 1),
    );
    let r = rig(fake.clone());
    create(&r, "web").await;
    let (sink, mut rx) = chan();
    let id = start_stack_op(
        &r.state.streams,
        &r.state.stacks,
        "main",
        "web",
        StackOp::Stop { services: None },
        sink,
    )
    .await
    .unwrap();
    // Otra ventana y un id inventado: `not_found`.
    assert_eq!(
        r.state.stacks.cancel("otra", &id).unwrap_err().code,
        ApiErrorCode::NotFound
    );
    assert_eq!(
        r.state.stacks.cancel("main", "no-existe").unwrap_err().code,
        ApiErrorCode::NotFound
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    r.state.stacks.cancel("main", &id).unwrap();
    let feeds = ended(&mut rx).await;
    assert!(matches!(
        feeds.last().unwrap(),
        StackOpFeed::Ended {
            outcome: StackOutcome::Canceled,
            error: None,
            ..
        }
    ));
    assert_eq!(fake.signals(), vec!["term"]);
    // Cancelar de nuevo: la entrada ya no existe.
    assert!(r.state.stacks.cancel("main", &id).is_err());
}

#[tokio::test]
async fn abort_duro_y_cierre_de_ventana_no_dejan_huerfanos() {
    let fake = FakeSpawn::new();
    fake.on(
        " stop ",
        Script::default().then_sleep(Duration::from_secs(60)),
    );
    let r = rig(fake.clone());
    for n in ["a", "b"] {
        create(&r, n).await;
    }
    let (s1, _r1) = chan();
    let (s2, _r2) = chan();
    let id = start_stack_op(
        &r.state.streams,
        &r.state.stacks,
        "main",
        "a",
        StackOp::Stop { services: None },
        s1,
    )
    .await
    .unwrap();
    start_stack_op(
        &r.state.streams,
        &r.state.stacks,
        "main",
        "b",
        StackOp::Stop { services: None },
        s2,
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    // `unsubscribe` de una.
    assert!(r.state.streams.abort(&id));
    // Cierre de la ventana: la otra.
    assert_eq!(r.state.streams.abort_for_window("main"), 1);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        fake.signals().iter().filter(|s| **s == "drop_term").count(),
        2,
        "{:?}",
        fake.signals()
    );
    // Y los stacks quedan libres.
    let (s3, _r3) = chan();
    start_stack_op(
        &r.state.streams,
        &r.state.stacks,
        "main",
        "a",
        StackOp::Stop { services: None },
        s3,
    )
    .await
    .unwrap();
    r.state.streams.abort_all();
}

#[tokio::test]
async fn list_stacks_une_contenedores_descubiertos_y_stacks_propios() {
    let fake = FakeSpawn::new();
    fake.on("config --format json", Script::default().stdout(CONFIG));
    let r = rig(fake);
    create(&r, "propio").await;
    r.mock_stacks
        .containers
        .lock()
        .unwrap()
        .push(ComposeContainer {
            id: "1".into(),
            name: "ajeno-w-1".into(),
            image: "nginx".into(),
            state: ContainerState::Running,
            status: "Up".into(),
            project: "ajeno".into(),
            service: "w".into(),
            working_dir: Some("/w".into()),
            config_files: vec!["/w/compose.yaml".into()],
            environment_file: None,
            oneoff: false,
            number: Some(1),
            health: None,
        });
    let list = r.state.stacks.list_stacks().await.unwrap();
    let names: Vec<_> = list.iter().map(|s| (s.name.as_str(), s.origin)).collect();
    assert_eq!(
        names,
        [
            ("ajeno", engine_core::StackOrigin::Discovered),
            ("propio", engine_core::StackOrigin::Managed)
        ]
    );
    assert!(!list[0].editable && list[1].editable);
    let s = r.state.stacks.summary_of("ajeno").await.unwrap();
    assert_eq!(s.running, 1);
    assert!(r.state.stacks.summary_of("nada").await.is_err());
}

// ---------------------------------------------------------------------------------- IPC + ACL

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

#[test]
fn ipc_de_stacks_bajo_la_acl_real() {
    let fake = FakeSpawn::new();
    fake.on("config --format json", Script::default().stdout(CONFIG));
    fake.on(" stop", Script::lines(""));
    let r = rig(fake);
    let app = mock_builder()
        .manage(r.state)
        .invoke_handler(tauri::generate_handler![
            crate::commands_stacks::compose_info,
            crate::commands_stacks::list_stacks,
            crate::commands_stacks::stack_read,
            crate::commands_stacks::stack_save,
            crate::commands_stacks::stack_validate,
            crate::commands_stacks::stack_create,
            crate::commands_stacks::stack_link,
            crate::commands_stacks::stack_unlink,
            crate::commands_stacks::run_stack_op,
            crate::commands_stacks::cancel_stack_op,
        ])
        .build(tauri::generate_context!())
        .expect("app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("ventana");
    let call = |cmd: &str, body: serde_json::Value| get_ipc_response(&webview, request(cmd, body));

    let info = ok(call("compose_info", serde_json::json!({})));
    assert_eq!(info["available"], true);
    assert_eq!(info["version"], "5.5.1");
    assert_eq!(info["flavor"], "plugin");
    let info = ok(call("compose_info", serde_json::json!({"recheck": true})));
    assert_eq!(info["supported"], true);

    let created = ok(call(
        "stack_create",
        serde_json::json!({"name": "demo", "yaml": YAML, "env": "A=1\n"}),
    ));
    assert_eq!(created["name"], "demo");
    assert_eq!(created["origin"], "managed");
    assert_eq!(created["status"], "declared");
    assert_eq!(created["editable"], true);
    let dup = call(
        "stack_create",
        serde_json::json!({"name": "demo", "yaml": YAML, "env": ""}),
    )
    .expect_err("duplicado");
    assert_eq!(dup["code"], "conflict");
    let bad = call(
        "stack_create",
        serde_json::json!({"name": "../x", "yaml": YAML, "env": ""}),
    )
    .expect_err("nombre inválido");
    assert_eq!(bad["code"], "invalid_input");

    let list = ok(call("list_stacks", serde_json::json!({})));
    assert_eq!(list.as_array().unwrap().len(), 1);

    let files = ok(call("stack_read", serde_json::json!({"name": "demo"})));
    assert_eq!(files["yaml"], YAML);
    assert_eq!(files["env"], "A=1\n");
    let rev = files["revision"].as_str().unwrap().to_string();
    let saved = ok(call(
        "stack_save",
        serde_json::json!({"name": "demo", "yaml": "services: {}\n", "env": "", "expectedRevision": rev}),
    ));
    assert_ne!(saved["revision"], files["revision"]);
    let stale = call(
        "stack_save",
        serde_json::json!({"name": "demo", "yaml": YAML, "env": "", "expectedRevision": rev}),
    )
    .expect_err("revisión vieja");
    assert_eq!(stale["code"], "state_changed");
    let denied = call(
        "stack_save",
        serde_json::json!({"name": "ajeno", "yaml": YAML, "env": ""}),
    )
    .expect_err("discovered");
    assert_eq!(denied["code"], "policy_denied");

    let v = ok(call(
        "stack_validate",
        serde_json::json!({"name": "demo", "yaml": YAML, "env": ""}),
    ));
    assert_eq!(v["ok"], true);
    assert_eq!(v["services"], serde_json::json!(["second", "sleeper"]));

    let unl = call("stack_unlink", serde_json::json!({"name": "demo"})).expect_err("managed");
    assert_eq!(unl["code"], "policy_denied");
    let link =
        call("stack_link", serde_json::json!({"path": "/etc/passwd"})).expect_err("peligrosa");
    assert!(["policy_denied", "invalid_input"].contains(&link["code"].as_str().unwrap()));

    let id = ok(call(
        "run_stack_op",
        serde_json::json!({"name": "demo", "op": {"type": "stop"}, "onEvent": "__CHANNEL__:1"}),
    ));
    assert_eq!(id.as_str().unwrap().len(), 36);
    let nf = call(
        "cancel_stack_op",
        serde_json::json!({"subscriptionId": "no-existe"}),
    )
    .expect_err("ajeno");
    assert_eq!(nf["code"], "not_found");
    ok(call(
        "cancel_stack_op",
        serde_json::json!({"subscriptionId": id}),
    ));
    // Operación con servicio hostil: rechazada antes de lanzar nada.
    let e = call(
        "run_stack_op",
        serde_json::json!({"name": "demo", "op": {"type": "up", "services": ["--evil"]}, "onEvent": "__CHANNEL__:2"}),
    )
    .expect_err("servicio hostil");
    assert_eq!(e["code"], "invalid_input");
}
