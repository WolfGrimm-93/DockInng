//! Pruebas contra un Docker real, marcadas `#[ignore]`: se ejecutan con
//! `DOCKINNG_LIVE_TESTS=1 cargo test -p engine-docker --test live -- --ignored`.
//! El daemon local puede tener datos de otros proyectos.
//!
//! Reglas duras: solo se crean/tocan recursos `dockinng-test-<uuid>` con la label
//! `dev.dockinng.test=1`; nunca prune; sin `pull` (se usa `alpine:latest` local);
//! un test a la vez (cerrojo global).

use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use bollard::Docker;
use bollard::models::{
    ContainerConfig, ContainerCreateBody, HostConfig, NetworkCreateRequest, VolumeCreateRequest,
};
use bollard::query_parameters::{
    CommitContainerOptionsBuilder, CreateContainerOptionsBuilder, ListContainersOptionsBuilder,
    RemoveContainerOptionsBuilder,
};
use engine_core::{
    ActionRequest, ActionService, ConnectionStatus, ContainerState, EngineClient, EngineError,
    LogStream, LogsRequest, MountKind, PlanDecision, testing::MockEngine,
};
use engine_docker::DockerEngine;
use futures_util::{FutureExt, StreamExt};

const PREFIX: &str = "dockinng-test-";
const LABEL: &str = "dev.dockinng.test";
const BASE_IMAGE: &str = "alpine:latest";

static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn short() -> String {
    uuid::Uuid::now_v7().simple().to_string()[20..].to_string()
}

/// Entorno de una prueba: motor real + registro de lo creado para limpiarlo.
struct Env {
    docker: Docker,
    engine: DockerEngine,
    id: String,
    containers: StdMutex<Vec<String>>,
    volumes: StdMutex<Vec<String>>,
    networks: StdMutex<Vec<String>>,
    images: StdMutex<Vec<String>>,
}

fn test_labels() -> HashMap<String, String> {
    HashMap::from([(LABEL.to_string(), "1".to_string())])
}

fn assert_ours(name: &str) {
    assert!(
        name.starts_with(PREFIX),
        "se intentó tocar un recurso ajeno: {name}"
    );
}

impl Env {
    /// `None` = no hay Docker / no habilitado / falta la imagen: la prueba se omite.
    async fn new(name: &str) -> Option<Env> {
        if std::env::var("DOCKINNG_LIVE_TESTS").ok().as_deref() != Some("1") {
            eprintln!(
                "SKIP {name}: define DOCKINNG_LIVE_TESTS=1 para correr pruebas contra Docker"
            );
            return None;
        }
        let engine = DockerEngine::new();
        if tokio::time::timeout(Duration::from_secs(3), engine.ping())
            .await
            .map(|r| r.is_err())
            .unwrap_or(true)
        {
            panic!("{name}: no hay Docker");
        }
        let docker = Docker::connect_with_unix_defaults().ok()?;
        if docker.inspect_image(BASE_IMAGE).await.is_err() {
            panic!("{name}: falta la imagen {BASE_IMAGE} (no se hace pull)");
        }
        Some(Env {
            docker,
            engine,
            id: short(),
            containers: Default::default(),
            volumes: Default::default(),
            networks: Default::default(),
            images: Default::default(),
        })
    }

    fn name(&self, what: &str) -> String {
        format!("{PREFIX}{}-{what}", self.id)
    }

    async fn create_container(
        &self,
        what: &str,
        image: &str,
        cmd: &[&str],
        tty: bool,
        binds: Vec<String>,
        network: Option<String>,
    ) -> String {
        let name = self.name(what);
        let body = ContainerCreateBody {
            image: Some(image.into()),
            cmd: Some(cmd.iter().map(|s| s.to_string()).collect()),
            labels: Some(test_labels()),
            tty: Some(tty),
            host_config: Some(HostConfig {
                binds: Some(binds),
                network_mode: network,
                ..Default::default()
            }),
            ..Default::default()
        };
        let opts = CreateContainerOptionsBuilder::default().name(&name).build();
        let r = self
            .docker
            .create_container(Some(opts), body)
            .await
            .expect("crear contenedor de prueba");
        self.containers.lock().expect("lock").push(name.clone());
        assert!(!r.id.is_empty());
        name
    }

    async fn create_volume(&self, what: &str) -> String {
        let name = self.name(what);
        self.docker
            .create_volume(VolumeCreateRequest {
                name: Some(name.clone()),
                labels: Some(test_labels()),
                ..Default::default()
            })
            .await
            .expect("crear volumen de prueba");
        self.volumes.lock().expect("lock").push(name.clone());
        name
    }

    async fn wait_exit(&self, id: &str) {
        for _ in 0..100 {
            let d = self.engine.inspect_container(id).await.expect("inspect");
            if d.summary.state == ContainerState::Exited {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("el contenedor {id} no terminó");
    }

    /// Borra solo lo creado por esta prueba, por nombre exacto y con prefijo verificado.
    async fn cleanup(&self) {
        let containers: Vec<String> = self.containers.lock().expect("lock").clone();
        for n in containers.iter().rev() {
            assert_ours(n);
            let o = RemoveContainerOptionsBuilder::default()
                .force(true)
                .v(false)
                .build();
            let _ = self.docker.remove_container(n, Some(o)).await;
        }
        let networks: Vec<String> = self.networks.lock().expect("lock").clone();
        for n in networks.iter().rev() {
            assert_ours(n);
            let _ = self.docker.remove_network(n).await;
        }
        let images: Vec<String> = self.images.lock().expect("lock").clone();
        for n in images.iter().rev() {
            assert_ours(n);
            let _ = self
                .docker
                .remove_image(
                    n,
                    None::<bollard::query_parameters::RemoveImageOptions>,
                    None,
                )
                .await;
        }
        let volumes: Vec<String> = self.volumes.lock().expect("lock").clone();
        for n in volumes.iter().rev() {
            assert_ours(n);
            let _ = self
                .docker
                .remove_volume(n, None::<bollard::query_parameters::RemoveVolumeOptions>)
                .await;
        }
    }
}

/// Ejecuta el cuerpo y limpia siempre, aunque el cuerpo falle.
async fn guarded<F: Future<Output = ()>>(env: &Env, body: F) {
    let r = AssertUnwindSafe(body).catch_unwind().await;
    env.cleanup().await;
    if let Err(p) = r {
        std::panic::resume_unwind(p);
    }
}

/// Elimina restos de ejecuciones anteriores: solo label de prueba Y prefijo en el nombre.
async fn cleanup_leftovers(env: &Env) {
    let filters = HashMap::from([("label".to_string(), vec![format!("{LABEL}=1")])]);
    let o = ListContainersOptionsBuilder::default()
        .all(true)
        .filters(&filters)
        .build();
    for c in env
        .docker
        .list_containers(Some(o))
        .await
        .unwrap_or_default()
    {
        for n in c.names.unwrap_or_default() {
            let n = n.trim_start_matches('/').to_string();
            if n.starts_with(PREFIX) {
                let o = RemoveContainerOptionsBuilder::default()
                    .force(true)
                    .v(false)
                    .build();
                let _ = env.docker.remove_container(&n, Some(o)).await;
            }
        }
    }
}

macro_rules! live {
    ($name:literal, |$env:ident| $body:block) => {{
        let _g = LOCK.lock().await;
        let Some($env) = Env::new($name).await else {
            return;
        };
        cleanup_leftovers(&$env).await;
        guarded(&$env, async { $body }).await;
    }};
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn ciclo_de_vida_y_remove_no_borra_volumenes() {
    live!("ciclo", |env| {
        let vol = env.create_volume("vol").await;
        let name = env
            .create_container(
                "ciclo",
                BASE_IMAGE,
                &["sleep", "60"],
                false,
                vec![format!("{vol}:/data")],
                None,
            )
            .await;
        let e = &env.engine;

        // list + inspect
        let d = e.inspect_container(&name).await.expect("inspect");
        let id = d.summary.id.clone();
        assert_eq!(id.len(), 64);
        assert_eq!(d.summary.state, ContainerState::Created);
        assert!(!d.tty);
        assert!(
            d.summary
                .mounts
                .iter()
                .any(|m| m.kind == MountKind::Volume && m.name.as_deref() == Some(vol.as_str()))
        );
        assert!(
            e.list_containers(true)
                .await
                .expect("list")
                .iter()
                .any(|c| c.id == id)
        );

        // start / start idempotente / stop / stop idempotente / restart
        e.start_container(&name).await.expect("start");
        e.start_container(&name)
            .await
            .expect("start idempotente (304)");
        let d = e.inspect_container(&name).await.expect("inspect");
        assert_eq!(d.summary.state, ContainerState::Running);
        assert!(d.pid.is_some() && d.started_at.is_some());
        assert!(
            e.list_containers(false)
                .await
                .expect("list")
                .iter()
                .any(|c| c.id == id)
        );
        e.stop_container(&name).await.expect("stop");
        e.stop_container(&name)
            .await
            .expect("stop idempotente (304)");
        e.restart_container(&name).await.expect("restart");
        assert_eq!(
            e.inspect_container(&name)
                .await
                .expect("inspect")
                .summary
                .state,
            ContainerState::Running
        );

        // Volumen en uso: remove_volume => Conflict.
        assert!(matches!(
            e.remove_volume(&vol).await,
            Err(EngineError::Conflict(_))
        ));
        // list_volumes trae tamaño y used_by del volumen de prueba.
        let v = e
            .list_volumes()
            .await
            .expect("volumes")
            .into_iter()
            .find(|v| v.name == vol)
            .expect("vol");
        assert!(v.size_bytes.is_some(), "df debería dar tamaño");
        assert_eq!(v.used_by, vec![name.clone()]);

        // remove sin force de uno corriendo => Conflict; con force funciona.
        assert!(matches!(
            e.remove_container(&id, false).await,
            Err(EngineError::Conflict(_))
        ));
        e.remove_container(&id, true).await.expect("remove force");
        assert!(matches!(
            e.inspect_container(&name).await,
            Err(EngineError::NotFound(_))
        ));
        // H8: el volumen con nombre sigue existiendo.
        assert!(
            e.inspect_volume(&vol).await.is_ok(),
            "remove_container no debe borrar volúmenes"
        );
        // Sin usar => se puede borrar por la vía unitaria.
        e.remove_volume(&vol).await.expect("remove volume");
    });
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn eventos_start_y_die() {
    live!("eventos", |env| {
        let name = env
            .create_container("ev", BASE_IMAGE, &["sleep", "60"], false, vec![], None)
            .await;
        let id = env
            .engine
            .inspect_container(&name)
            .await
            .expect("inspect")
            .summary
            .id;
        let mut events = env.engine.events();
        // Deja que el stream se conecte antes de provocar los eventos.
        let engine = env.engine.clone();
        let (n2, id2) = (name.clone(), id.clone());
        let trigger = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            engine.start_container(&n2).await.expect("start");
            engine.stop_container(&id2).await.expect("stop");
        });
        let mut seen = Vec::new();
        let r = tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(ev) = events.next().await {
                let ev = ev.expect("evento");
                if ev.id == id {
                    seen.push(ev.action.clone());
                    if seen.iter().any(|a| a == "start") && seen.iter().any(|a| a == "die") {
                        return;
                    }
                }
            }
        })
        .await;
        trigger.await.expect("trigger");
        assert!(r.is_ok(), "no llegaron start y die: {seen:?}");
    });
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn logs_multiplexados_tty_y_tail() {
    live!("logs", |env| {
        let mux = env
            .create_container(
                "mux",
                BASE_IMAGE,
                &["sh", "-c", "echo out; echo err >&2; echo tres"],
                false,
                vec![],
                None,
            )
            .await;
        env.engine.start_container(&mux).await.expect("start");
        env.wait_exit(&mux).await;
        let lines: Vec<_> = env
            .engine
            .logs(
                &mux,
                LogsRequest {
                    tail: Some(10),
                    follow: false,
                    since: None,
                },
            )
            .collect()
            .await;
        let lines: Vec<_> = lines.into_iter().map(|l| l.expect("línea")).collect();
        assert!(
            lines
                .iter()
                .any(|l| l.stream == LogStream::Stdout && l.message == "out"),
            "{lines:?}"
        );
        assert!(
            lines
                .iter()
                .any(|l| l.stream == LogStream::Stderr && l.message == "err"),
            "{lines:?}"
        );
        assert!(lines.iter().all(|l| l.timestamp.is_some()));
        // tail limita.
        let last: Vec<_> = env
            .engine
            .logs(
                &mux,
                LogsRequest {
                    tail: Some(1),
                    follow: false,
                    since: None,
                },
            )
            .collect()
            .await;
        assert_eq!(last.len(), 1);

        let tty = env
            .create_container(
                "tty",
                BASE_IMAGE,
                &["sh", "-c", "echo hola-tty"],
                true,
                vec![],
                None,
            )
            .await;
        env.engine.start_container(&tty).await.expect("start");
        env.wait_exit(&tty).await;
        let lines: Vec<_> = env
            .engine
            .logs(
                &tty,
                LogsRequest {
                    tail: None,
                    follow: false,
                    since: None,
                },
            )
            .collect()
            .await;
        let lines: Vec<_> = lines.into_iter().map(|l| l.expect("línea")).collect();
        assert!(
            lines
                .iter()
                .any(|l| l.stream == LogStream::Console && l.message == "hola-tty"),
            "{lines:?}"
        );
        assert!(
            env.engine
                .inspect_container(&tty)
                .await
                .expect("inspect")
                .tty
        );
    });
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn estadisticas_snapshot_y_stream() {
    live!("stats", |env| {
        let name = env
            .create_container("stats", BASE_IMAGE, &["sleep", "30"], false, vec![], None)
            .await;
        env.engine.start_container(&name).await.expect("start");
        let s = env.engine.stats_snapshot(&name).await.expect("snapshot");
        assert!(s.cpu_percent.is_finite() && s.cpu_percent >= 0.0);
        assert!(s.mem_used_bytes > 0 && s.mem_limit_bytes > 0);
        assert!(s.pids >= 1);
        let samples: Vec<_> = tokio::time::timeout(
            Duration::from_secs(8),
            env.engine.stats(&name).take(2).collect::<Vec<_>>(),
        )
        .await
        .expect("2 muestras en 8 s");
        assert_eq!(samples.len(), 2);
        assert!(samples.iter().all(|s| s.is_ok()));
    });
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn imagen_en_uso_y_red_con_endpoints() {
    live!("recursos", |env| {
        let e = &env.engine;
        // Imagen propia (commit de un contenedor de prueba) para no tocar imágenes ajenas.
        let base = env
            .create_container("base", BASE_IMAGE, &["true"], false, vec![], None)
            .await;
        let repo = env.name("img");
        env.docker
            .commit_container(
                CommitContainerOptionsBuilder::new()
                    .container(&base)
                    .repo(&repo)
                    .tag("v1")
                    .build(),
                ContainerConfig {
                    labels: Some(test_labels()),
                    ..Default::default()
                },
            )
            .await
            .expect("commit");
        let reference = format!("{repo}:v1");
        env.images.lock().expect("lock").push(repo.clone());
        env.images.lock().expect("lock").push(reference.clone());

        let net = env.name("net");
        env.docker
            .create_network(NetworkCreateRequest {
                name: net.clone(),
                labels: Some(test_labels()),
                ..Default::default()
            })
            .await
            .expect("crear red");
        env.networks.lock().expect("lock").push(net.clone());

        let user = env
            .create_container(
                "user",
                &reference,
                &["sleep", "30"],
                false,
                vec![],
                Some(net.clone()),
            )
            .await;
        e.start_container(&user).await.expect("start");

        let img = e
            .list_images()
            .await
            .expect("images")
            .into_iter()
            .find(|i| i.reference == reference)
            .expect("imagen");
        assert_eq!(img.containers, 1);
        assert!(!img.dangling && img.size_bytes > 0);
        // Imagen en uso: Docker rechaza (sin force).
        assert!(matches!(
            e.remove_image(&reference).await,
            Err(EngineError::Conflict(_))
        ));

        let n = e
            .list_networks()
            .await
            .expect("redes")
            .into_iter()
            .find(|n| n.name == net)
            .expect("red");
        assert_eq!(n.connected, vec![user.clone()]);
        assert!(!n.system);
        // Red con contenedor activo: no se puede borrar.
        assert!(matches!(
            e.remove_network(&n.id).await,
            Err(EngineError::Conflict(_)) | Err(EngineError::Engine { .. })
        ));

        // Al liberar todo, las vías unitarias funcionan.
        let uid = e
            .inspect_container(&user)
            .await
            .expect("inspect")
            .summary
            .id;
        e.remove_container(&uid, true).await.expect("rm");
        e.remove_network(&n.id).await.expect("rm red");
        e.remove_image(&reference).await.expect("rm imagen");
    });
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn diagnose_real_y_lecturas() {
    live!("diag", |env| {
        assert!(matches!(
            env.engine.diagnose().await,
            ConnectionStatus::Connected { .. }
        ));
        // Lecturas (solo lectura sobre datos ajenos).
        assert!(env.engine.list_containers(true).await.is_ok());
        assert!(env.engine.list_images().await.is_ok());
        assert!(env.engine.list_volumes().await.is_ok());
        assert!(env.engine.list_networks().await.is_ok());
        assert!(env.engine.info().await.is_ok());
        // Ids con caracteres raros se rechazan antes de llegar al daemon.
        assert!(matches!(
            env.engine.inspect_container("a/../b").await,
            Err(EngineError::InvalidInput(_))
        ));
    });
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn flujo_plan_ejecutar_contra_docker_real() {
    live!("flujo", |env| {
        let vol = env.create_volume("vol").await;
        let name = env
            .create_container(
                "flujo",
                BASE_IMAGE,
                &["true"],
                false,
                vec![format!("{vol}:/d")],
                None,
            )
            .await;
        let svc = ActionService::new(std::sync::Arc::new(env.engine.clone()));
        let plan = svc
            .plan(ActionRequest::RemoveContainers {
                ids: vec![name.clone()],
            })
            .await
            .expect("plan");
        assert_eq!(plan.decision, PlanDecision::Confirm);
        assert_eq!(plan.affected.len(), 1);
        let t = plan.ticket.expect("ticket");
        let out = svc.execute(&t, None).await.expect("execute");
        assert_eq!(out.succeeded.len(), 1, "{out:?}");
        assert!(matches!(
            env.engine.inspect_container(&name).await,
            Err(EngineError::NotFound(_))
        ));
        // El volumen sobrevive (no se envía v=true).
        assert!(env.engine.inspect_volume(&vol).await.is_ok());
        // Segundo uso del ticket: rechazado.
        assert!(svc.execute(&t, None).await.is_err());

        // Prune de volúmenes: SOLO se planifica (lectura) y se cancela; jamás se ejecuta aquí
        // porque el daemon tiene volúmenes de otros proyectos.
        let p = svc
            .plan(ActionRequest::PruneVolumes)
            .await
            .expect("plan prune");
        assert!(matches!(p.decision, PlanDecision::ConfirmTyped { .. }));
        if let Some(t) = p.ticket {
            assert!(svc.cancel(&t));
        }
        let _ = MockEngine::new();
    });
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn snapshot_de_cpu_es_correcto_en_la_primera_muestra() {
    live!("cpu", |env| {
        // Bucle que consume ~1 núcleo: el snapshot (stream=false) trae `precpu_stats`
        // poblado, así que el CPU% no debe ser 0.
        let name = env
            .create_container(
                "cpu",
                BASE_IMAGE,
                &["sh", "-c", "while :; do :; done"],
                false,
                vec![],
                None,
            )
            .await;
        env.engine.start_container(&name).await.expect("start");
        tokio::time::sleep(Duration::from_secs(2)).await;
        let s = env.engine.stats_snapshot(&name).await.expect("snapshot");
        assert!(s.cpu_percent.is_finite());
        assert!(
            s.cpu_percent > 30.0 && s.cpu_percent < 130.0,
            "un bucle ocupa ~100% de un núcleo; medido {}",
            s.cpu_percent
        );
    });
}
