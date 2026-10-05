//! Operaciones de stacks contra un lanzador falso que reproduce las salidas REALES de Compose 5.5.1.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use compose::fakes::{FakeSpawn, Script};
use compose::files::StackStore;
use compose::runner::{ComposeRunner, Limits};
use engine_core::{
    ApiErrorCode, CancelSignal, ComposeContainer, ContainerState, EngineError, IssueKind,
    StackControl, StackOp, StackOpFeed, StackOrigin, StackOutcome, StackRisk, StackSink,
};

const CONFIG: &str = include_str!("fixtures/config.json");
const UP: &str = include_str!("fixtures/up_progress_json.ndjson");
const UP_ERR: &str = include_str!("fixtures/up_progress_json_error.ndjson");
const SIGTERM: &str = include_str!("fixtures/down_progress_json_sigterm.ndjson");
const STOP: &str = include_str!("fixtures/stop_progress_json.ndjson");
const YAML: &str = "services:\n  sleeper:\n    image: alpine:latest\n";

struct Tmp(PathBuf);
impl Tmp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("dockinng-compose-ops-{}", uuid_like()));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!(
        "{n}-{}-{}",
        std::process::id(),
        N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

fn fast_limits() -> Limits {
    Limits {
        flush_every: Duration::from_millis(10),
        term_grace: Duration::from_millis(300),
        ..Limits::default()
    }
}

fn runner_with(fake: &Arc<FakeSpawn>, limits: Limits, tmp: &Tmp) -> ComposeRunner {
    let r = ComposeRunner::with_parts(
        Some("unix:///run/dockinng-test.sock".into()),
        fake.clone(),
        limits,
        StackStore::new(tmp.0.join("stacks")),
    );
    r.set_env_source(vec![
        ("PATH".into(), "/usr/bin".into()),
        ("HOME".into(), "/home/u".into()),
        ("COMPOSE_FILE".into(), "/etc/passwd".into()),
        ("DOCKER_HOST".into(), "tcp://evil:1".into()),
        ("API_KEY".into(), "secreto".into()),
    ]);
    r
}

fn feeds() -> (StackSink, Arc<Mutex<Vec<StackOpFeed>>>) {
    let store = Arc::new(Mutex::new(Vec::new()));
    let s2 = store.clone();
    (Arc::new(move |e| s2.lock().unwrap().push(e)), store)
}

fn never() -> CancelSignal {
    Box::pin(std::future::pending())
}

fn ended(feeds: &Arc<Mutex<Vec<StackOpFeed>>>) -> StackOpFeed {
    feeds
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|f| matches!(f, StackOpFeed::Ended { .. }))
        .cloned()
        .expect("Ended")
}

async fn setup(fake: Arc<FakeSpawn>, tmp: &Tmp) -> ComposeRunner {
    setup_named(fake, tmp, "web").await
}

async fn setup_named(fake: Arc<FakeSpawn>, tmp: &Tmp, name: &str) -> ComposeRunner {
    let fake = fake.with_compose_5();
    let r = runner_with(&fake, fast_limits(), tmp);
    r.stack_create(name, YAML, "SECRETO=valor-super-secreto\n")
        .await
        .unwrap();
    r
}

#[tokio::test]
async fn up_real_ok_config_antes_progreso_y_sin_flags_peligrosos() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on("config --format json", Script::default().stdout(CONFIG));
    fake.on(" up ", Script::lines(UP));
    let r = setup_named(fake.clone(), &tmp, "dockinng-test-recon").await;
    let (sink, store) = feeds();
    let op = r
        .prepare_op("dockinng-test-recon", StackOp::Up { services: None })
        .await
        .unwrap();
    op.run(sink, never()).await;
    let f = store.lock().unwrap().clone();
    assert!(
        matches!(&f[0], StackOpFeed::Started { op, stack, compose_version } if op == "up" && stack == "dockinng-test-recon" && compose_version == "5.5.1")
    );
    let StackOpFeed::Ended {
        outcome,
        exit_code,
        error,
        ..
    } = ended(&store)
    else {
        unreachable!()
    };
    assert_eq!(
        (outcome, exit_code, error),
        (StackOutcome::Success, Some(0), None)
    );
    // Último Progress: los dos servicios de config.json al 100 %.
    let last = f
        .iter()
        .rev()
        .find_map(|e| match e {
            StackOpFeed::Progress { services, .. } => Some(services.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(last.len(), 2);
    assert!(last.iter().all(|s| s.percent == 100));
    // Ningún ítem duplicado por (id,status,text).
    let n_items: usize = f
        .iter()
        .map(|e| match e {
            StackOpFeed::Progress { items, .. } => items.len(),
            _ => 0,
        })
        .sum();
    assert!((3..=10).contains(&n_items), "{n_items}");

    let calls = fake.calls();
    let cfg_i = calls
        .iter()
        .position(|c| c.display.contains("config --format json"))
        .unwrap();
    let up_i = calls
        .iter()
        .position(|c| c.display.contains(" up "))
        .unwrap();
    assert!(cfg_i < up_i, "config va antes de up");
    let up = &calls[up_i];
    assert!(up.display.starts_with(
        "docker compose --ansi never --progress json -p dockinng-test-recon --project-directory "
    ));
    assert!(up.display.ends_with(" up -d"));
    // Entorno: sin COMPOSE_FILE ni API_KEY; DOCKER_HOST forzado.
    assert!(
        up.env
            .iter()
            .all(|(k, _)| k != "COMPOSE_FILE" && k != "API_KEY")
    );
    let host: Vec<_> = up.env.iter().filter(|(k, _)| k == "DOCKER_HOST").collect();
    assert_eq!(host.len(), 1);
    assert_eq!(host[0].1, "unix:///run/dockinng-test.sock");
    // `config` es de lectura: sin --progress.
    assert!(!calls[cfg_i].display.contains("--progress"));
}

#[tokio::test]
async fn up_con_error_de_creacion() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on("config --format json", Script::default().stdout(CONFIG));
    fake.on(" up ", Script::lines(UP_ERR).exit(1));
    let r = setup(fake, &tmp).await;
    let (sink, store) = feeds();
    r.prepare_op("web", StackOp::Up { services: None })
        .await
        .unwrap()
        .run(sink, never())
        .await;
    let StackOpFeed::Ended {
        outcome,
        exit_code,
        error,
        issues,
    } = ended(&store)
    else {
        unreachable!()
    };
    assert_eq!(outcome, StackOutcome::Failed);
    assert_eq!(exit_code, Some(1));
    let e = error.unwrap();
    assert_eq!(e.code, ApiErrorCode::ComposeFailed);
    assert!(e.message.contains("No such image"));
    assert!(
        issues.is_empty(),
        "un error de runtime no es un problema del YAML"
    );
}

#[tokio::test]
async fn yaml_invalido_falla_rapido_con_linea_y_sin_lanzar_up() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on(
        "config --format json",
        Script::lines("go-yaml load error in parser (while parsing a block mapping) at L2.C3-L4.C4: did not find expected key")
            .exit(1),
    );
    let r = setup(fake.clone(), &tmp).await;
    let (sink, store) = feeds();
    r.prepare_op("web", StackOp::Up { services: None })
        .await
        .unwrap()
        .run(sink, never())
        .await;
    let StackOpFeed::Ended {
        outcome,
        error,
        issues,
        ..
    } = ended(&store)
    else {
        unreachable!()
    };
    assert_eq!(outcome, StackOutcome::Failed);
    assert_eq!(error.unwrap().code, ApiErrorCode::InvalidCompose);
    assert_eq!(
        (issues[0].line, issues[0].column, issues[0].kind),
        (Some(2), Some(3), IssueKind::Syntax)
    );
    assert!(fake.displays().iter().all(|d| !d.contains(" up ")));
}

#[tokio::test]
async fn servicio_inexistente_se_rechaza_antes_de_ejecutar() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on("config --format json", Script::default().stdout(CONFIG));
    let r = setup(fake.clone(), &tmp).await;
    let (sink, store) = feeds();
    r.prepare_op(
        "web",
        StackOp::Restart {
            services: Some(vec!["nope".into()]),
        },
    )
    .await
    .unwrap()
    .run(sink, never())
    .await;
    let StackOpFeed::Ended { outcome, error, .. } = ended(&store) else {
        unreachable!()
    };
    assert_eq!(outcome, StackOutcome::Failed);
    assert_eq!(error.unwrap().code, ApiErrorCode::InvalidInput);
    assert!(fake.displays().iter().all(|d| !d.contains(" restart ")));
    // Servicio válido: va tras `--`.
    let (sink, store) = feeds();
    r.prepare_op(
        "web",
        StackOp::Restart {
            services: Some(vec!["sleeper".into()]),
        },
    )
    .await
    .unwrap()
    .run(sink, never())
    .await;
    assert!(matches!(
        ended(&store),
        StackOpFeed::Ended {
            outcome: StackOutcome::Success,
            ..
        }
    ));
    assert!(
        fake.displays()
            .iter()
            .any(|d| d.ends_with("restart -t 10 -- sleeper"))
    );
}

#[tokio::test]
async fn nombres_de_servicio_hostiles_no_llegan_a_compose() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    let r = setup(fake.clone(), &tmp).await;
    for bad in ["--evil", "a;b", "$(x)", "a b", "a\nb", ""] {
        let res = r
            .prepare_op(
                "web",
                StackOp::Stop {
                    services: Some(vec![bad.into()]),
                },
            )
            .await;
        assert!(res.is_err(), "{bad:?}");
    }
    let many = vec!["a".to_string(); 33];
    assert!(
        r.prepare_op(
            "web",
            StackOp::Stop {
                services: Some(many)
            }
        )
        .await
        .is_err()
    );
    for bad in ["../x", "A", "a/b", "", "-x"] {
        assert!(
            r.prepare_op(bad, StackOp::Stop { services: None })
                .await
                .is_err(),
            "{bad:?}"
        );
    }
    assert!(fake.displays().iter().all(|d| !d.contains("stop")));
}

#[tokio::test]
async fn cancelar_envia_sigterm_y_emite_canceled_sin_matar() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on(
        " stop ",
        Script::lines(STOP.lines().next().unwrap())
            .then_sleep(Duration::from_secs(60))
            .on_term(&SIGTERM.lines().collect::<Vec<_>>(), 1),
    );
    let r = setup(fake.clone(), &tmp).await;
    let (sink, store) = feeds();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let cancel: CancelSignal = Box::pin(async move {
        let _ = rx.await;
    });
    let op = r
        .prepare_op("web", StackOp::Stop { services: None })
        .await
        .unwrap();
    let h = tokio::spawn(op.run(sink, cancel));
    tokio::time::sleep(Duration::from_millis(150)).await;
    tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), h)
        .await
        .unwrap()
        .unwrap();
    let StackOpFeed::Ended { outcome, error, .. } = ended(&store) else {
        unreachable!()
    };
    assert_eq!(outcome, StackOutcome::Canceled);
    assert!(error.is_none());
    assert_eq!(fake.signals(), vec!["term"]);
}

#[tokio::test]
async fn si_ignora_sigterm_se_remata_con_sigkill() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on(
        " stop ",
        Script::default()
            .then_sleep(Duration::from_secs(60))
            .ignoring_term(),
    );
    let r = setup(fake.clone(), &tmp).await;
    let (sink, store) = feeds();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let cancel: CancelSignal = Box::pin(async move {
        let _ = rx.await;
    });
    let op = r
        .prepare_op("web", StackOp::Stop { services: None })
        .await
        .unwrap();
    let h = tokio::spawn(op.run(sink, cancel));
    tokio::time::sleep(Duration::from_millis(100)).await;
    tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), h)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        ended(&store),
        StackOpFeed::Ended {
            outcome: StackOutcome::Canceled,
            ..
        }
    ));
    assert_eq!(fake.signals(), vec!["term", "kill"]);
}

#[tokio::test]
async fn soltar_el_canal_de_cancelacion_no_cancela() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on(
        " stop ",
        Script::lines(STOP).then_sleep(Duration::from_millis(200)),
    );
    let r = setup(fake.clone(), &tmp).await;
    let (sink, store) = feeds();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    // Mismo patrón que el comando: un `Err` (emisor soltado) NO es una cancelación.
    let cancel: CancelSignal = Box::pin(async move {
        if rx.await.is_err() {
            std::future::pending::<()>().await;
        }
    });
    drop(tx);
    r.prepare_op("web", StackOp::Stop { services: None })
        .await
        .unwrap()
        .run(sink, cancel)
        .await;
    assert!(matches!(
        ended(&store),
        StackOpFeed::Ended {
            outcome: StackOutcome::Success,
            ..
        }
    ));
    assert!(fake.signals().is_empty());
}

#[tokio::test]
async fn timeout_termina_el_proceso() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new().with_compose_5();
    fake.on(
        " stop ",
        Script::default().then_sleep(Duration::from_secs(60)),
    );
    let limits = Limits {
        quick_timeout: Duration::from_millis(200),
        ..fast_limits()
    };
    let r = runner_with(&fake, limits, &tmp);
    r.stack_create("web", YAML, "").await.unwrap();
    let (sink, store) = feeds();
    r.prepare_op("web", StackOp::Stop { services: None })
        .await
        .unwrap()
        .run(sink, never())
        .await;
    let StackOpFeed::Ended { outcome, error, .. } = ended(&store) else {
        unreachable!()
    };
    assert_eq!(outcome, StackOutcome::Timeout);
    assert_eq!(error.unwrap().code, ApiErrorCode::Timeout);
    assert!(fake.signals().contains(&"term"));
}

#[tokio::test]
async fn una_operacion_por_stack() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on(
        " stop ",
        Script::default().then_sleep(Duration::from_millis(300)),
    );
    let r = setup(fake, &tmp).await;
    let first = r
        .prepare_op("web", StackOp::Stop { services: None })
        .await
        .unwrap();
    let second = r.prepare_op("web", StackOp::Start { services: None }).await;
    assert!(matches!(second, Err(EngineError::Conflict(_))));
    // Otro stack no se ve afectado.
    // Al terminar se libera.
    let (sink, _) = feeds();
    first.run(sink, never()).await;
    let held = r
        .prepare_op("web", StackOp::Start { services: None })
        .await
        .unwrap();
    assert!(
        r.prepare_op("web", StackOp::Start { services: None })
            .await
            .is_err()
    );
    // Soltar sin ejecutar también libera.
    drop(held);
    r.prepare_op("web", StackOp::Start { services: None })
        .await
        .unwrap();
}

#[tokio::test]
async fn sin_progress_json_se_repite_en_texto_plano() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on(
        "--progress json",
        Script::lines("unknown flag: --progress").exit(1),
    );
    fake.on(
        "--progress plain",
        Script::lines(include_str!("fixtures/up_progress_plain.txt")).exit(0),
    );
    fake.on("config --format json", Script::default().stdout(CONFIG));
    let r = setup(fake.clone(), &tmp).await;
    let (sink, store) = feeds();
    r.prepare_op("web", StackOp::Up { services: None })
        .await
        .unwrap()
        .run(sink, never())
        .await;
    assert!(matches!(
        ended(&store),
        StackOpFeed::Ended {
            outcome: StackOutcome::Success,
            ..
        }
    ));
    let d = fake.displays();
    assert!(d.iter().any(|x| x.contains("--progress json")));
    assert!(d.iter().any(|x| x.contains("--progress plain")));
    // La siguiente operación ya usa plain directamente.
    let n_before = d.iter().filter(|x| x.contains("--progress json")).count();
    let (sink, _) = feeds();
    r.prepare_op("web", StackOp::Up { services: None })
        .await
        .unwrap()
        .run(sink, never())
        .await;
    let n_after = fake
        .displays()
        .iter()
        .filter(|x| x.contains("--progress json"))
        .count();
    assert_eq!(n_before, n_after);
}

#[tokio::test]
async fn salida_desbordada_mata_el_proceso() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new().with_compose_5();
    let flood: String = (0..400)
        .map(|i| {
            format!(
                "{{\"id\":\"Volume v{i}\",\"status\":\"Working\",\"text\":\"{}\"}}\n",
                "x".repeat(100)
            )
        })
        .collect();
    fake.on(
        " stop ",
        Script::lines(&flood).then_sleep(Duration::from_secs(60)),
    );
    let limits = Limits {
        max_stderr_total: 10 * 1024,
        ..fast_limits()
    };
    let r = runner_with(&fake, limits, &tmp);
    r.stack_create("web", YAML, "").await.unwrap();
    let (sink, store) = feeds();
    r.prepare_op("web", StackOp::Stop { services: None })
        .await
        .unwrap()
        .run(sink, never())
        .await;
    let StackOpFeed::Ended { outcome, error, .. } = ended(&store) else {
        unreachable!()
    };
    assert_eq!(outcome, StackOutcome::Failed);
    assert!(error.unwrap().message.contains("demasiada salida"));
    assert!(fake.signals().contains(&"term"));
}

#[tokio::test]
async fn los_secretos_del_env_no_salen_en_mensajes_ni_logs() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on(
        " start",
        Script::lines("WARN variable valor-super-secreto ignorada\n{\"error\":true,\"message\":\"fallo con valor-super-secreto dentro\"}")
            .exit(1),
    );
    let r = setup(fake, &tmp).await;
    let (sink, store) = feeds();
    r.prepare_op("web", StackOp::Start { services: None })
        .await
        .unwrap()
        .run(sink, never())
        .await;
    let dump = format!("{:?}", store.lock().unwrap());
    assert!(!dump.contains("valor-super-secreto"), "{dump}");
    assert!(dump.contains("***"));
}

#[tokio::test]
async fn down_por_control_ok_y_error() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on(" down ", Script::default());
    let r = setup(fake.clone(), &tmp).await;
    r.down("web").await.unwrap();
    let d = fake.displays();
    let down = d.iter().find(|x| x.contains(" down ")).unwrap();
    assert!(down.ends_with(" down -t 10"));
    for bad in ["-v", "--rmi", "--remove-orphans"] {
        assert!(!down.contains(bad));
    }
    // Error.
    let tmp2 = Tmp::new();
    let fake2 = FakeSpawn::new();
    fake2.on(
        " down ",
        Script::lines("{\"error\":true,\"message\":\"boom\"}").exit(1),
    );
    let r2 = setup(fake2, &tmp2).await;
    let err = r2.down("web").await.unwrap_err();
    assert!(
        matches!(
            err,
            EngineError::Coded {
                code: ApiErrorCode::ComposeFailed,
                ..
            }
        ),
        "{err:?}"
    );
}

#[tokio::test]
async fn stack_descubierto_solo_admite_stop_start_restart_y_down_por_nombre() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new().with_compose_5();
    let r = runner_with(&fake, fast_limits(), &tmp);
    for op in [
        StackOp::Up { services: None },
        StackOp::Pull { services: None },
    ] {
        match r.prepare_op("ajeno", op).await {
            Err(EngineError::Coded { code, message }) => {
                assert_eq!(code, ApiErrorCode::PolicyDenied);
                assert!(
                    message.contains(
                        "solo fue descubierto; vincula su archivo compose para gestionarlo"
                    ),
                    "{message}"
                );
            }
            other => panic!("se esperaba policy_denied: {:?}", other.err()),
        }
    }
    for op in [
        StackOp::Start { services: None },
        StackOp::Restart { services: None },
    ] {
        let (sink, store) = feeds();
        r.prepare_op("ajeno", op)
            .await
            .unwrap()
            .run(sink, never())
            .await;
        assert!(matches!(
            ended(&store),
            StackOpFeed::Ended {
                outcome: StackOutcome::Success,
                ..
            }
        ));
    }
    let (sink, store) = feeds();
    r.prepare_op("ajeno", StackOp::Stop { services: None })
        .await
        .unwrap()
        .run(sink, never())
        .await;
    assert!(matches!(
        ended(&store),
        StackOpFeed::Ended {
            outcome: StackOutcome::Success,
            ..
        }
    ));
    r.down("ajeno").await.unwrap();
    for d in fake
        .displays()
        .iter()
        .filter(|d| d.contains(" stop ") || d.contains(" down "))
    {
        assert!(!d.contains(" -f "), "{d}");
        assert!(d.contains("-p ajeno"));
    }
}

#[tokio::test]
async fn compose_ausente_o_v1() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on("compose version", Script::missing());
    fake.on("docker-compose", Script::missing());
    fake.on("docker", Script::missing());
    let r = runner_with(&fake, fast_limits(), &tmp);
    let info = r.compose_info(true).await;
    assert!(!info.available);
    let err = r.stack_create("web", YAML, "").await;
    assert!(err.is_ok(), "crear archivos no requiere compose");
    let e = r
        .prepare_op("web", StackOp::Up { services: None })
        .await
        .err()
        .unwrap();
    assert!(
        matches!(
            e,
            EngineError::Coded {
                code: ApiErrorCode::ComposeMissing,
                ..
            }
        ),
        "{e:?}"
    );

    // Compose v1 (texto): detectado pero no soportado.
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on("compose version", Script::missing());
    fake.on("docker-compose version", Script::default().exit(1));
    fake.on(
        "--version",
        Script::default().stdout("docker-compose version 1.29.2, build 5becea4c\n"),
    );
    let r = runner_with(&fake, fast_limits(), &tmp);
    let info = r.compose_info(true).await;
    assert!(info.available && !info.supported);
    assert_eq!(info.version.as_deref(), Some("1.29.2"));
}

#[tokio::test]
async fn info_se_cachea() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new().with_compose_5();
    let r = runner_with(&fake, fast_limits(), &tmp);
    let a = r.compose_info(false).await;
    let n = fake.calls().len();
    let b = r.compose_info(false).await;
    assert_eq!(a, b);
    assert_eq!(fake.calls().len(), n);
    r.compose_info(true).await;
    assert!(fake.calls().len() > n);
    assert_eq!(a.version.as_deref(), Some("5.5.1"));
    assert!(a.supported && a.available);
}

#[tokio::test]
async fn validar_por_stdin_con_env_temporal_que_se_borra() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on(
        "config --format json",
        Script::default()
            .stdout(&CONFIG.replace("\"pull_policy\": \"never\"", "\"privileged\": true")),
    );
    let r = setup(fake.clone(), &tmp).await;
    let v = r
        .stack_validate(Some("web"), YAML, "K=vvvvvv")
        .await
        .unwrap();
    assert!(v.ok);
    assert_eq!(v.services, vec!["second", "sleeper"]);
    assert!(v.risks.contains(&StackRisk::Privileged));
    let call = fake
        .calls()
        .into_iter()
        .find(|c| c.display.contains("config --format json"))
        .unwrap();
    assert!(call.display.contains("-f -"));
    assert_eq!(call.stdin.as_deref(), Some(YAML.as_bytes()));
    let env_path = call
        .args
        .iter()
        .position(|a| a == "--env-file")
        .map(|i| call.args[i + 1].clone())
        .unwrap();
    assert!(!Path::new(&env_path).exists(), "el .env temporal se borra");
    assert!(!Path::new(&env_path).parent().unwrap().exists());
    // El stack guardado no cambió.
    assert_eq!(
        std::fs::read_to_string(tmp.0.join("stacks/web/compose.yaml")).unwrap(),
        YAML
    );
}

#[tokio::test]
async fn validar_devuelve_problemas_con_linea() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on(
        "config --format json",
        Script::lines("validating -: services.sleeper additional properties 'imagen' not allowed")
            .exit(1),
    );
    let r = setup(fake, &tmp).await;
    let yaml = "services:\n  sleeper:\n    imagen: x\n";
    let v = r.stack_validate(None, yaml, "").await.unwrap();
    assert!(!v.ok);
    assert_eq!(v.issues[0].kind, IssueKind::Schema);
    assert_eq!(v.issues[0].line, Some(3));
    // Contenido inválido no llega a Compose.
    assert!(r.stack_validate(None, "a\0b", "").await.is_err());
    assert!(
        r.stack_validate(None, &"x".repeat(1024 * 1024 + 1), "")
            .await
            .is_err()
    );
    assert!(r.stack_validate(Some("../x"), YAML, "").await.is_err());
}

#[tokio::test]
async fn vincular_deriva_el_nombre_y_valida_con_config() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on(
        "config --format json",
        Script::default().stdout(&CONFIG.replace("dockinng-test-recon", "Mi Proyecto")),
    );
    let r = setup(fake.clone(), &tmp).await;
    let proj = tmp.0.join("proyecto");
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::write(proj.join("compose.yaml"), YAML).unwrap();
    let name = r
        .stack_link(proj.join("compose.yaml").to_str().unwrap(), vec![])
        .await
        .unwrap();
    assert_eq!(name, "mi-proyecto");
    assert_eq!(
        r.origin_of("mi-proyecto").await.unwrap(),
        Some(StackOrigin::Linked)
    );
    // Ya existe.
    assert!(matches!(
        r.stack_link(proj.join("compose.yaml").to_str().unwrap(), vec![])
            .await,
        Err(EngineError::Conflict(_))
    ));
    // Rutas peligrosas.
    for bad in [
        "/etc/passwd",
        "/proc/self/environ",
        "relativo.yaml",
        "/no/existe.yaml",
    ] {
        assert!(r.stack_link(bad, vec![]).await.is_err(), "{bad}");
    }
    // Desvincular no toca el archivo.
    r.stack_unlink("mi-proyecto").await.unwrap();
    assert!(proj.join("compose.yaml").exists());
}

#[tokio::test]
async fn discovered_no_se_edita_ni_se_borra() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    let r = setup(fake, &tmp).await;
    let err = r.stack_save("ajeno", YAML, "", None).await.unwrap_err();
    assert!(
        matches!(
            err,
            EngineError::Coded {
                code: ApiErrorCode::PolicyDenied,
                ..
            }
        ),
        "{err:?}"
    );
    assert!(r.delete_files("ajeno").await.is_err());
    // Lectura de solo lectura de un compose descubierto.
    let f = tmp.0.join("ajeno.yaml");
    std::fs::write(&f, YAML).unwrap();
    let c = |files: Vec<String>| ComposeContainer {
        id: "1".into(),
        name: "ajeno-w-1".into(),
        image: "x".into(),
        state: ContainerState::Running,
        status: String::new(),
        project: "ajeno".into(),
        service: "w".into(),
        working_dir: None,
        config_files: files,
        environment_file: None,
        oneoff: false,
        number: Some(1),
        health: None,
    };
    let ok = r
        .stack_read("ajeno", vec![c(vec![f.to_string_lossy().into_owned()])])
        .await
        .unwrap();
    assert_eq!(ok.origin, StackOrigin::Discovered);
    assert!(!ok.editable);
    assert_eq!(ok.env, "");
    // Labels manipuladas hacia archivos ajenos: rechazadas.
    for evil in [
        "/etc/passwd",
        "/proc/self/environ",
        "/etc/shadow.yaml",
        "relativo.yaml",
    ] {
        assert!(
            r.stack_read("ajeno", vec![c(vec![evil.into()])])
                .await
                .is_err(),
            "{evil}"
        );
    }
}

#[tokio::test]
async fn list_stacks_une_disco_y_contenedores() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on("config --format json", Script::default().stdout(CONFIG));
    let r = setup(fake, &tmp).await;
    let list = r.list_stacks(vec![]).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "web");
    assert_eq!(list[0].status, engine_core::StackStatus::Declared);
    assert_eq!(list[0].services.len(), 2, "servicios declarados vía config");
    assert!(list[0].editable);
    assert_eq!(list[0].origin, StackOrigin::Managed);
}

fn container_of(project: &str, files: Vec<String>) -> ComposeContainer {
    ComposeContainer {
        id: "1".into(),
        name: format!("{project}-w-1"),
        image: "x".into(),
        state: ContainerState::Running,
        status: String::new(),
        project: project.into(),
        service: "w".into(),
        working_dir: None,
        config_files: files,
        environment_file: None,
        oneoff: false,
        number: Some(1),
        health: None,
    }
}

#[tokio::test]
async fn vincular_con_name_de_otro_proyecto_existente_es_conflict() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on(
        "config --format json",
        Script::default().stdout(&CONFIG.replace("dockinng-test-recon", "ajeno")),
    );
    let r = setup(fake, &tmp).await;
    let proj = tmp.0.join("p");
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::write(proj.join("compose.yaml"), YAML).unwrap();
    let path = proj.join("compose.yaml");
    let path = path.to_str().unwrap();
    // Existe un proyecto `ajeno` con OTROS archivos: conflicto y no se crea nada.
    let other = vec![container_of(
        "ajeno",
        vec!["/otro/lugar/compose.yaml".into()],
    )];
    let e = r.stack_link(path, other).await.unwrap_err();
    assert!(matches!(e, EngineError::Conflict(_)), "{e:?}");
    assert!(!tmp.0.join("stacks/ajeno").exists());
    // Si sus contenedores ya usan ESTE archivo, se puede vincular.
    let same = vec![container_of("ajeno", vec![path.to_string()])];
    assert_eq!(r.stack_link(path, same).await.unwrap(), "ajeno");
}

#[tokio::test]
async fn vincular_expande_la_tilde_y_rechaza_trucos() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    fake.on("config --format json", Script::default().stdout(CONFIG));
    let r = setup(fake, &tmp).await;
    for bad in [
        "~/../x.yaml",
        "~/",
        "~",
        "~root/x.yaml",
        "~/no-existe-dockinng.yaml",
    ] {
        assert!(r.stack_link(bad, vec![]).await.is_err(), "{bad}");
    }
}

#[tokio::test]
async fn el_endpoint_se_lee_en_cada_lanzamiento() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new().with_compose_5();
    let cur = Arc::new(Mutex::new("unix:///run/uno.sock".to_string()));
    let c2 = cur.clone();
    let r = ComposeRunner::with_endpoint_source(
        Arc::new(move || Some(c2.lock().unwrap().clone())),
        fake.clone(),
        fast_limits(),
        StackStore::new(tmp.0.join("stacks")),
    );
    r.stack_create("web", YAML, "").await.unwrap();
    let host = |f: &Arc<FakeSpawn>| {
        f.calls()
            .iter()
            .rev()
            .find(|c| c.display.contains(" stop"))
            .unwrap()
            .env
            .iter()
            .find(|(k, _)| k == "DOCKER_HOST")
            .unwrap()
            .1
            .clone()
    };
    let (sink, _) = feeds();
    r.prepare_op("web", StackOp::Stop { services: None })
        .await
        .unwrap()
        .run(sink, never())
        .await;
    assert_eq!(host(&fake), "unix:///run/uno.sock");
    *cur.lock().unwrap() = "unix:///run/dos.sock".into();
    let (sink, _) = feeds();
    r.prepare_op("web", StackOp::Stop { services: None })
        .await
        .unwrap()
        .run(sink, never())
        .await;
    assert_eq!(host(&fake), "unix:///run/dos.sock");
}

#[tokio::test]
async fn includes_remotos_se_rechazan_sin_ejecutar_compose() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    let r = setup(fake.clone(), &tmp).await;
    let bad = "include:\n  - https://github.com/x/y.git\nservices:\n  a:\n    image: x\n";
    let v = r.stack_validate(None, bad, "").await.unwrap();
    assert!(!v.ok);
    assert_eq!(v.issues[0].line, Some(2));
    assert!(fake.displays().iter().all(|d| !d.contains("config")));
    // Linked: el archivo del usuario con include remoto no se vincula.
    let proj = tmp.0.join("q");
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::write(proj.join("compose.yaml"), bad).unwrap();
    assert!(
        r.stack_link(proj.join("compose.yaml").to_str().unwrap(), vec![])
            .await
            .is_err()
    );
    assert!(fake.displays().iter().all(|d| !d.contains("config")));
}

#[tokio::test]
async fn secretos_no_salen_por_ningun_canal() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new();
    let sec = "s3cr3t-del-yaml";
    let yaml = format!("services:\n  a:\n    image: x\n    environment:\n      API_TOKEN: {sec}\n");
    fake.on(
        "config --format json",
        Script::lines(&format!(
            "validating -: services.a bad value {sec} (valor-super-secreto)"
        ))
        .exit(1),
    );
    fake.on(
        " start",
        Script::lines(&format!(
            "{{\"id\":\"Container web-{sec}-1\",\"status\":\"Working\",\"text\":\"Starting {sec}\",\"details\":\"det valor-super-secreto\"}}\nAVISO {sec}\n{{\"error\":true,\"message\":\"fallo valor-super-secreto\"}}"
        ))
        .exit(1),
    );
    let r = runner_with(&fake.clone().with_compose_5(), fast_limits(), &tmp);
    r.stack_create("web", &yaml, "SECRETO=valor-super-secreto\n")
        .await
        .unwrap();
    // Validación.
    let v = r
        .stack_validate(Some("web"), &yaml, "SECRETO=valor-super-secreto\n")
        .await
        .unwrap();
    let dump = format!("{v:?}");
    assert!(
        !dump.contains(sec) && !dump.contains("valor-super-secreto"),
        "{dump}"
    );
    // Operación: progreso, log y error final.
    let (sink, store) = feeds();
    r.prepare_op("web", StackOp::Start { services: None })
        .await
        .unwrap()
        .run(sink, never())
        .await;
    let dump = format!("{:?}", store.lock().unwrap());
    assert!(
        !dump.contains(sec) && !dump.contains("valor-super-secreto"),
        "{dump}"
    );
    assert!(dump.contains("***"));
}

#[tokio::test]
async fn sin_directorio_de_datos_los_stacks_propios_fallan_claro_y_lo_demas_sigue() {
    let fake = FakeSpawn::new().with_compose_5();
    let r = ComposeRunner::with_parts(None, fake, fast_limits(), StackStore::unavailable());
    let e = r.stack_create("web", YAML, "").await.unwrap_err();
    let api: engine_core::ApiError = e.into();
    assert_eq!(api.code, ApiErrorCode::Internal);
    assert!(
        api.message
            .contains("no se pudo determinar el directorio de datos"),
        "{}",
        api.message
    );
    assert!(r.stack_save("web", YAML, "", None).await.is_err());
    assert!(r.stack_unlink("web").await.is_err());
    assert!(r.list_stacks(vec![]).await.unwrap().is_empty());
    // Descubiertos: siguen operando por nombre.
    let (sink, store) = feeds();
    r.prepare_op("ajeno", StackOp::Stop { services: None })
        .await
        .unwrap()
        .run(sink, never())
        .await;
    assert!(matches!(
        ended(&store),
        StackOpFeed::Ended {
            outcome: StackOutcome::Success,
            ..
        }
    ));
}

#[tokio::test]
async fn restart_sin_servicios_con_include_que_escapa_falla_antes_de_compose() {
    let tmp = Tmp::new();
    let fake = FakeSpawn::new().with_compose_5();
    let r = runner_with(&fake, fast_limits(), &tmp);
    let yaml =
        "include:\n  - ../../secreto.yaml\nservices:\n  sleeper:\n    image: alpine:latest\n";
    r.stack_create("web", yaml, "").await.unwrap();
    let (sink, store) = feeds();
    r.prepare_op("web", StackOp::Restart { services: None })
        .await
        .unwrap()
        .run(sink, never())
        .await;
    let StackOpFeed::Ended {
        outcome,
        issues,
        error,
        ..
    } = ended(&store)
    else {
        panic!("Ended esperado")
    };
    assert_eq!(outcome, StackOutcome::Failed);
    assert_eq!(issues.first().and_then(|i| i.line), Some(2), "{issues:?}");
    assert!(error.is_some());
    // Ni `config` ni `restart` llegan a ejecutarse con el YAML inseguro.
    assert!(
        !fake.displays().iter().any(|d| d.contains(" restart")),
        "{:?}",
        fake.displays()
    );
}
