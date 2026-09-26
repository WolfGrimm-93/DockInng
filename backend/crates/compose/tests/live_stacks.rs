//! Pruebas contra Docker/Compose REALES. Se ejecutan con
//! `DOCKINNG_LIVE_TESTS=1 cargo test -p compose --test live_stacks -- --ignored --test-threads=1`.
//!
//! Reglas duras: solo proyectos `dockinng-test-<id>` con la label `dev.dockinng.test=1` en cada
//! servicio; imagen local `alpine:latest` con `pull_policy: never` (jamás un pull); nunca prune;
//! los archivos de los stacks viven en un directorio temporal (no en `~/.local/share`); un
//! comando Docker a la vez (cerrojo global + `flock`) y limpieza por nombre exacto.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use compose::ComposeRunner;
use compose::files::StackStore;
use compose::runner::Limits;
use engine_core::{
    ActionRequest, ActionService, CancelSignal, ContainerState, EngineClient, IssueKind,
    PlanDecision, StackControl, StackDiscovery, StackOp, StackOpFeed, StackOrigin, StackOutcome,
    StackSink, StackStatus,
};
use engine_docker::DockerEngine;

const PREFIX: &str = "dockinng-test-";
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn short() -> String {
    uuid::Uuid::now_v7().simple().to_string()[20..].to_string()
}

/// Cerrojo entre procesos (otros agentes/tests también usan el daemon): `flock` exclusivo.
struct FileLock(std::fs::File);
impl FileLock {
    fn take() -> Self {
        use std::os::fd::AsRawFd;
        let f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(std::env::temp_dir().join("dockinng-live-docker.lock"))
            .expect("lock");
        // SAFETY: fd válido durante la vida de `f`.
        unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) };
        Self(f)
    }
}
impl Drop for FileLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: ver `take`.
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

/// Limpieza SIEMPRE (también si el test falla): solo contenedores del proyecto exacto que
/// además llevan la label de prueba, y su red por defecto.
struct Cleanup {
    projects: Vec<String>,
    dirs: Vec<PathBuf>,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        for p in &self.projects {
            assert!(p.starts_with(PREFIX), "limpieza de un proyecto ajeno: {p}");
            let out = std::process::Command::new("docker")
                .args([
                    "ps",
                    "-aq",
                    "--filter",
                    &format!("label=com.docker.compose.project={p}"),
                    "--filter",
                    "label=dev.dockinng.test=1",
                ])
                .output();
            if let Ok(o) = out {
                for id in String::from_utf8_lossy(&o.stdout).split_whitespace() {
                    let _ = std::process::Command::new("docker")
                        .args(["rm", "-f", id])
                        .output();
                }
            }
            let _ = std::process::Command::new("docker")
                .args(["network", "rm", &format!("{p}_default")])
                .output();
        }
        for d in &self.dirs {
            let _ = std::fs::remove_dir_all(d);
        }
    }
}

fn enabled(name: &str) -> bool {
    if std::env::var("DOCKINNG_LIVE_TESTS").ok().as_deref() != Some("1") {
        eprintln!("SKIP {name}: define DOCKINNG_LIVE_TESTS=1");
        return false;
    }
    true
}

fn stack_yaml(project: &str) -> String {
    // `trap`: el shell (PID 1) atiende SIGTERM y el stack baja rápido. `stubborn` ignora SIGTERM
    // a propósito (tarda `-t 10` s): sirve para cancelar a mitad de operación.
    let _ = project;
    r#"services:
  fast:
    image: alpine:latest
    pull_policy: never
    command: ["sh", "-c", "trap 'exit 0' TERM; while true; do sleep 1; done"]
    labels:
      dev.dockinng.test: "1"
  fast2:
    image: alpine:latest
    pull_policy: never
    command: ["sh", "-c", "trap 'exit 0' TERM; while true; do sleep 1; done"]
    labels:
      dev.dockinng.test: "1"
"#
    .into()
}

fn stubborn_yaml() -> String {
    r#"services:
  stubborn:
    image: alpine:latest
    pull_policy: never
    command: ["sleep", "300"]
    labels:
      dev.dockinng.test: "1"
"#
    .into()
}

fn feeds() -> (StackSink, Arc<Mutex<Vec<StackOpFeed>>>) {
    let store = Arc::new(Mutex::new(Vec::new()));
    let s2 = store.clone();
    (Arc::new(move |e| s2.lock().unwrap().push(e)), store)
}

fn last_ended(f: &Arc<Mutex<Vec<StackOpFeed>>>) -> StackOpFeed {
    f.lock()
        .unwrap()
        .iter()
        .rev()
        .find(|e| matches!(e, StackOpFeed::Ended { .. }))
        .cloned()
        .expect("Ended")
}

fn never() -> CancelSignal {
    Box::pin(std::future::pending())
}

async fn run(r: &ComposeRunner, name: &str, op: StackOp) -> (Vec<StackOpFeed>, StackOutcome) {
    let (sink, store) = feeds();
    r.prepare_op(name, op)
        .await
        .expect("prepare")
        .run(sink, never())
        .await;
    let StackOpFeed::Ended { outcome, .. } = last_ended(&store) else {
        unreachable!()
    };
    let all = store.lock().unwrap().clone();
    (all, outcome)
}

async fn project_containers(
    engine: &DockerEngine,
    project: &str,
) -> Vec<engine_core::ComposeContainer> {
    engine
        .list_compose_containers()
        .await
        .unwrap()
        .into_iter()
        .filter(|c| c.project == project)
        .collect()
}

/// Procesos vivos cuyo cmdline contiene `docker compose` y `-p <project>` (huérfanos).
fn compose_processes(project: &str) -> Vec<u32> {
    let needle = format!("-p\0{project}\0");
    let mut out = Vec::new();
    for e in std::fs::read_dir("/proc").unwrap().flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let Ok(cmd) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
            continue;
        };
        let s = String::from_utf8_lossy(&cmd);
        if s.contains(&needle) && s.contains("compose") {
            out.push(pid);
        }
    }
    out
}

struct Setup {
    runner: ComposeRunner,
    engine: Arc<DockerEngine>,
    project: String,
    root: PathBuf,
}

async fn setup(
    tag: &str,
) -> Option<(
    Setup,
    Cleanup,
    FileLock,
    tokio::sync::MutexGuard<'static, ()>,
)> {
    if !enabled(tag) {
        return None;
    }
    let guard = LOCK.lock().await;
    let file_lock = FileLock::take();
    let engine = Arc::new(DockerEngine::new());
    engine.ping().await.expect("hay Docker");
    let images = engine.list_images().await.unwrap();
    assert!(
        images.iter().any(|i| i.reference == "alpine:latest"),
        "falta alpine:latest (no se hace pull)"
    );
    let project = format!("{PREFIX}{}", short());
    let root = std::env::temp_dir().join(format!("dockinng-live-{}", short()));
    std::fs::create_dir_all(&root).unwrap();
    let runner = ComposeRunner::with_parts(
        Some(engine.endpoint().display()),
        Arc::new(compose::proc::TokioSpawn),
        Limits::default(),
        StackStore::new(root.join("stacks")),
    );
    let cleanup = Cleanup {
        projects: vec![project.clone()],
        dirs: vec![root.clone()],
    };
    Some((
        Setup {
            runner,
            engine,
            project,
            root,
        },
        cleanup,
        file_lock,
        guard,
    ))
}

#[tokio::test]
#[ignore = "requiere Docker real: DOCKINNG_LIVE_TESTS=1"]
async fn live_ciclo_completo_de_un_stack_propio() {
    let Some((s, _cleanup, _fl, _g)) = setup("live_ciclo_completo").await else {
        return;
    };
    let r = &s.runner;
    let p = &s.project;
    let before = s.engine.list_containers(true).await.unwrap().len();

    let info = r.compose_info(true).await;
    assert!(info.available && info.supported, "{info:?}");
    assert_eq!(info.flavor, engine_core::ComposeFlavor::Plugin);

    // Crear y validar (YAML válido, con sintaxis rota y con esquema roto).
    r.stack_create(p, &stack_yaml(p), "GREETING=hola-live\n")
        .await
        .unwrap();
    let v = r
        .stack_validate(Some(p), &stack_yaml(p), "GREETING=hola-live\n")
        .await
        .unwrap();
    assert!(v.ok, "{v:?}");
    assert_eq!(v.services, ["fast", "fast2"]);
    assert!(v.risks.is_empty());
    let bad = "services:\n  web:\n    image: x\n   ports: [\n";
    let v = r.stack_validate(None, bad, "").await.unwrap();
    assert!(!v.ok);
    assert_eq!(v.issues[0].kind, IssueKind::Syntax);
    assert!(v.issues[0].line.is_some(), "{v:?}");
    let schema = "services:\n  web:\n    imagen: x\n";
    let v = r.stack_validate(None, schema, "").await.unwrap();
    assert!(!v.ok);
    assert_eq!(v.issues[0].kind, IssueKind::Schema);
    assert_eq!(v.issues[0].line, Some(3), "línea inferida: {v:?}");
    // Riesgos reales (config interpolado).
    let risky = "services:\n  a:\n    image: alpine:latest\n    privileged: true\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n";
    let v = r.stack_validate(None, risky, "").await.unwrap();
    assert!(v.ok);
    assert!(v.risks.contains(&engine_core::StackRisk::Privileged));
    assert!(v.risks.contains(&engine_core::StackRisk::DockerSock));

    // Lista: declarado (sin contenedores), servicios vía `config`.
    let list = r
        .list_stacks(project_containers(&s.engine, p).await)
        .await
        .unwrap();
    let me = list.iter().find(|x| &x.name == p).unwrap();
    assert_eq!(me.status, StackStatus::Declared);
    assert_eq!(me.services.len(), 2);

    // UP con progreso real.
    let (feed, outcome) = run(r, p, StackOp::Up { services: None }).await;
    assert_eq!(outcome, StackOutcome::Success, "{feed:?}");
    assert!(feed.iter().any(|f| matches!(f, StackOpFeed::Progress { items, .. } if items.iter().any(|i| i.name.contains("fast")))));
    let cs = project_containers(&s.engine, p).await;
    assert_eq!(cs.len(), 2);
    assert!(
        cs.iter()
            .all(|c| c.state == ContainerState::Running && !c.oneoff)
    );
    let list = r.list_stacks(cs.clone()).await.unwrap();
    let me = list.iter().find(|x| &x.name == p).unwrap();
    assert_eq!(
        (me.status, me.running, me.origin, me.editable),
        (StackStatus::Running, 2, StackOrigin::Managed, true)
    );

    // Un segundo `up` es idempotente; una operación a la vez por stack.
    let (sink, _st) = feeds();
    let held = r
        .prepare_op(p, StackOp::Start { services: None })
        .await
        .unwrap();
    assert!(
        r.prepare_op(p, StackOp::Stop { services: None })
            .await
            .is_err()
    );
    held.run(sink, never()).await;

    // RESTART / STOP de un servicio / START.
    let (_, o) = run(
        r,
        p,
        StackOp::Restart {
            services: Some(vec!["fast".into()]),
        },
    )
    .await;
    assert_eq!(o, StackOutcome::Success);
    let (_, o) = run(
        r,
        p,
        StackOp::Stop {
            services: Some(vec!["fast2".into()]),
        },
    )
    .await;
    assert_eq!(o, StackOutcome::Success);
    let cs = project_containers(&s.engine, p).await;
    let me = &r.list_stacks(cs.clone()).await.unwrap()[0];
    assert_eq!(me.status, StackStatus::Partial);
    let (_, o) = run(r, p, StackOp::Start { services: None }).await;
    assert_eq!(o, StackOutcome::Success);
    assert!(
        project_containers(&s.engine, p)
            .await
            .iter()
            .all(|c| c.state == ContainerState::Running)
    );

    // Servicio inexistente: falla sin tocar nada.
    let (sink, st) = feeds();
    r.prepare_op(
        p,
        StackOp::Restart {
            services: Some(vec!["nope".into()]),
        },
    )
    .await
    .unwrap()
    .run(sink, never())
    .await;
    assert!(matches!(
        last_ended(&st),
        StackOpFeed::Ended {
            outcome: StackOutcome::Failed,
            ..
        }
    ));

    // Guardar: con revisión vieja falla; el archivo sigue intacto.
    let f = r.stack_read(p, vec![]).await.unwrap();
    r.stack_save(
        p,
        &format!("# editado\n{}", f.yaml),
        &f.env,
        Some(&f.revision),
    )
    .await
    .unwrap();
    assert!(
        r.stack_save(p, &f.yaml, &f.env, Some(&f.revision))
            .await
            .is_err()
    );

    // Un YAML roto se guarda (es un borrador) pero `up` falla rápido con línea, sin ejecutar `up`.
    r.stack_save(p, "services:\n  a:\n\timage: x\n", "", None)
        .await
        .unwrap();
    let (sink, st) = feeds();
    r.prepare_op(p, StackOp::Up { services: None })
        .await
        .unwrap()
        .run(sink, never())
        .await;
    let StackOpFeed::Ended {
        outcome,
        issues,
        error,
        ..
    } = last_ended(&st)
    else {
        unreachable!()
    };
    assert_eq!(outcome, StackOutcome::Failed);
    assert!(
        issues.iter().any(|i| i.line.is_some()),
        "{issues:?} {error:?}"
    );
    r.stack_save(p, &stack_yaml(p), "", None).await.unwrap();

    // DOWN por plan → ticket con confirmación por nombre exacto.
    let actions = ActionService::with_stacks(s.engine.clone(), Some(Arc::new(r.clone())));
    let plan = actions
        .plan(ActionRequest::StackDown { project: p.clone() })
        .await
        .unwrap();
    assert_eq!(
        plan.decision,
        PlanDecision::ConfirmTyped {
            expected: p.clone()
        }
    );
    assert_eq!(
        plan.affected
            .iter()
            .filter(|a| a.kind == engine_core::ItemKind::Container)
            .count(),
        2
    );
    assert!(
        actions
            .execute(plan.ticket.as_deref().unwrap(), Some("otro-nombre"))
            .await
            .is_err()
    );
    let plan = actions
        .plan(ActionRequest::StackDown { project: p.clone() })
        .await
        .unwrap();
    let out = actions
        .execute(plan.ticket.as_deref().unwrap(), Some(p))
        .await
        .unwrap();
    assert!(out.failed.is_empty(), "{out:?}");
    assert!(
        project_containers(&s.engine, p).await.is_empty(),
        "down elimina los contenedores"
    );
    let nets = s.engine.list_networks().await.unwrap();
    assert!(nets.iter().all(|n| n.name != format!("{p}_default")));
    assert!(compose_processes(p).is_empty());

    // BORRAR: archivos fuera, sin contenedores.
    let plan = actions
        .plan(ActionRequest::StackDelete { name: p.clone() })
        .await
        .unwrap();
    let out = actions
        .execute(plan.ticket.as_deref().unwrap(), Some(p))
        .await
        .unwrap();
    assert!(out.failed.is_empty(), "{out:?}");
    assert!(!s.root.join("stacks").join(p).exists());
    assert_eq!(
        s.engine.list_containers(true).await.unwrap().len(),
        before,
        "0 restos"
    );
}

#[tokio::test]
#[ignore = "requiere Docker real: DOCKINNG_LIVE_TESTS=1"]
async fn live_cancelar_a_mitad_no_deja_huerfanos_y_estado_parcial() {
    let Some((s, _cleanup, _fl, _g)) = setup("live_cancelar").await else {
        return;
    };
    let r = &s.runner;
    let p = &s.project;
    r.stack_create(p, &stubborn_yaml(), "").await.unwrap();
    let (_, o) = run(r, p, StackOp::Up { services: None }).await;
    assert_eq!(o, StackOutcome::Success);
    // `restart -t 10` con un contenedor que ignora SIGTERM tarda ~10 s: se cancela a los 1,5 s.
    let (sink, st) = feeds();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let cancel: CancelSignal = Box::pin(async move {
        let _ = rx.await;
    });
    let op = r
        .prepare_op(p, StackOp::Restart { services: None })
        .await
        .unwrap();
    let h = tokio::spawn(op.run(sink, cancel));
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(
        !compose_processes(p).is_empty(),
        "compose debería seguir en curso"
    );
    tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(30), h)
        .await
        .unwrap()
        .unwrap();
    let StackOpFeed::Ended { outcome, error, .. } = last_ended(&st) else {
        unreachable!()
    };
    assert_eq!(outcome, StackOutcome::Canceled, "{:?}", st.lock().unwrap());
    assert!(error.is_none());
    assert!(
        compose_processes(p).is_empty(),
        "no quedan procesos de compose"
    );
    // El stack quedó libre y `down` (por control, sin ticket: es el propio test) limpia.
    tokio::time::sleep(Duration::from_secs(2)).await;
    r.down(p).await.unwrap();
    assert!(project_containers(&s.engine, p).await.is_empty());
    r.delete_files(p).await.unwrap();
}

#[tokio::test]
#[ignore = "requiere Docker real: DOCKINNG_LIVE_TESTS=1"]
async fn live_vincular_desvincular_y_stack_descubierto() {
    let Some((s, _cleanup, _fl, _g)) = setup("live_vincular").await else {
        return;
    };
    let r = &s.runner;
    let p = &s.project;
    // Proyecto externo con `name:` (el archivo lo hace el "usuario", fuera de la raíz de stacks).
    let ext = s.root.join("proyecto externo ñ");
    std::fs::create_dir_all(&ext).unwrap();
    let file = ext.join("compose.yaml");
    std::fs::write(&file, format!("name: {p}\n{}", stack_yaml(p))).unwrap();
    std::fs::write(ext.join(".env"), "X=1\n").unwrap();

    // Vincular: el nombre sale del `name:` real; los archivos del usuario no se copian.
    let name = r.stack_link(file.to_str().unwrap(), vec![]).await.unwrap();
    assert_eq!(&name, p);
    assert_eq!(r.origin_of(p).await.unwrap(), Some(StackOrigin::Linked));
    let files = r.stack_read(p, vec![]).await.unwrap();
    assert_eq!(files.origin, StackOrigin::Linked);
    assert!(files.editable);
    assert_eq!(files.env, "X=1\n");
    // Editar el archivo del usuario (D1): atómico y con revisión.
    r.stack_save(
        p,
        &format!("# hola\nname: {p}\n{}", stack_yaml(p)),
        "X=2\n",
        Some(&files.revision),
    )
    .await
    .unwrap();
    assert!(
        std::fs::read_to_string(&file)
            .unwrap()
            .starts_with("# hola")
    );
    assert_eq!(std::fs::read_to_string(ext.join(".env")).unwrap(), "X=2\n");

    let (_, o) = run(r, p, StackOp::Up { services: None }).await;
    assert_eq!(o, StackOutcome::Success);
    // Las labels apuntan al archivo del usuario.
    let cs = project_containers(&s.engine, p).await;
    assert_eq!(cs.len(), 2);
    assert!(cs[0].config_files[0].ends_with("compose.yaml"));

    // Desvincular: los contenedores siguen; el stack pasa a `discovered` (solo lectura).
    r.stack_unlink(p).await.unwrap();
    assert!(file.exists());
    let cs = project_containers(&s.engine, p).await;
    let list = r.list_stacks(cs.clone()).await.unwrap();
    let me = list.iter().find(|x| &x.name == p).unwrap();
    assert_eq!((me.origin, me.editable), (StackOrigin::Discovered, false));
    let rd = r.stack_read(p, cs.clone()).await.unwrap();
    assert_eq!(rd.origin, StackOrigin::Discovered);
    assert!(rd.yaml.contains("services:") && rd.env.is_empty() && !rd.editable);
    assert!(
        r.stack_save(p, "x: 1\n", "", None).await.is_err(),
        "discovered no se edita"
    );
    assert!(
        r.prepare_op(p, StackOp::Up { services: None })
            .await
            .is_err()
    );
    // Detener / arrancar / reiniciar un descubierto: por nombre de proyecto, sin archivos.
    let (feed, o) = run(r, p, StackOp::Stop { services: None }).await;
    assert_eq!(o, StackOutcome::Success, "{feed:?}");
    assert!(
        project_containers(&s.engine, p)
            .await
            .iter()
            .all(|c| c.state != ContainerState::Running)
    );
    let (feed, o) = run(r, p, StackOp::Start { services: None }).await;
    assert_eq!(o, StackOutcome::Success, "{feed:?}");
    assert!(
        project_containers(&s.engine, p)
            .await
            .iter()
            .all(|c| c.state == ContainerState::Running)
    );

    // DOWN de un descubierto por el flujo plan → ticket.
    let actions = ActionService::with_stacks(s.engine.clone(), Some(Arc::new(r.clone())));
    let plan = actions
        .plan(ActionRequest::StackDown { project: p.clone() })
        .await
        .unwrap();
    let out = actions
        .execute(plan.ticket.as_deref().unwrap(), Some(p))
        .await
        .unwrap();
    assert!(out.failed.is_empty(), "{out:?}");
    assert!(project_containers(&s.engine, p).await.is_empty());
    assert!(file.exists(), "los archivos del usuario no se tocan");
}

#[tokio::test]
#[ignore = "requiere Docker real: DOCKINNG_LIVE_TESTS=1"]
async fn live_yaml_hostil_y_entorno_aislado() {
    let Some((s, _cleanup, _fl, _g)) = setup("live_hostil").await else {
        return;
    };
    let r = &s.runner;
    // Bomba de alias: el tope de entrada (1 MiB) y el de tiempo/tamaño de salida la acotan.
    let mut bomb = String::from(
        "x-a: &a [\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\"]\n",
    );
    let mut prev = "a".to_string();
    for i in 0..6 {
        let cur = format!("{}{}", (b'b' + i as u8) as char, i);
        bomb.push_str(&format!("x-{cur}: &{cur} [*{prev},*{prev},*{prev},*{prev},*{prev},*{prev},*{prev},*{prev},*{prev}]\n"));
        prev = cur;
    }
    bomb.push_str("services:\n  a:\n    image: alpine:latest\n");
    let t0 = std::time::Instant::now();
    let res = r.stack_validate(None, &bomb, "").await;
    assert!(t0.elapsed() < Duration::from_secs(40), "acotada en tiempo");
    // Cualquier desenlace es válido (ok, error o tope), pero sin pánico ni proceso colgado.
    let _ = res;
    assert!(compose_processes("validacion").is_empty());
    // Entrada gigante: rechazada antes de lanzar nada.
    assert!(
        r.stack_validate(None, &"a".repeat(1024 * 1024 + 1), "")
            .await
            .is_err()
    );
    // `env_file` de un archivo ajeno: el mensaje se acota y no revienta.
    let evil = "services:\n  a:\n    image: alpine:latest\n    env_file: /etc/passwd\n";
    let v = r.stack_validate(None, evil, "").await.unwrap();
    for i in &v.issues {
        assert!(i.message.len() <= 2100);
    }
    // Claves duplicadas y !!binary: error, sin pánico.
    let v = r
        .stack_validate(None, "services:\n  a: {image: x}\n  a: {image: y}\n", "")
        .await
        .unwrap();
    assert!(!v.ok, "claves duplicadas: {v:?}");
    // `!!binary`: Compose lo acepta o lo rechaza, pero nunca hay pánico ni proceso colgado.
    let _ = r
        .stack_validate(None, "services:\n  a:\n    image: !!binary Zm9v\n", "")
        .await;
    // Un .env con secretos no aparece en los errores.
    let v = r
        .stack_validate(
            None,
            "services:\n  a:\n    image: ${IMG}\n    environment:\n      K: ${REQ:?falta}\n",
            "IMG=alpine:latest\nSECRET_TOKEN=super-secreto-12345\n",
        )
        .await
        .unwrap();
    assert!(!v.ok);
    assert!(!format!("{v:?}").contains("super-secreto-12345"));
    // No se crearon contenedores ni redes.
    assert!(project_containers(&s.engine, "validacion").await.is_empty());
    let _: &Path = &s.root;
}
