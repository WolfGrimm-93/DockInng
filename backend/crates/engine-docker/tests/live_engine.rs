//! Pruebas contra un Docker real de exec, pull, crear contenedor, volumen y red.
//! `DOCKINNG_LIVE_TESTS=1 cargo test -p engine-docker --test live_engine -- --ignored --test-threads=1`
//!
//! Reglas duras: solo se crean/tocan recursos `dockinng-test-eng-<uuid>-*` con la label
//! `dev.dockinng.test=1`; nunca prune; el daemon tiene recursos de OTROS proyectos.
//! Nada se descarga de Docker Hub: se usa `alpine:latest` (ya local) y, para el pull, un
//! registro local falso en 127.0.0.1:54109 (opt-in con `DOCKINNG_LIVE_REGISTRY=1`).

use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use bollard::Docker;
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use bollard::models::{ContainerCreateBody, HostConfig};
use bollard::query_parameters::{
    CreateContainerOptionsBuilder, ListContainersOptionsBuilder, RemoveContainerOptionsBuilder,
    StartContainerOptions,
};
use engine_core::create::{
    CreateContainerSpec, CreateNetworkSpec, CreateService, CreateVolumeSpec, EnvVar, PortProtocol,
    PortSpec, RestartPolicy, VolumeSpec,
};
use engine_core::pull::{LayerPhase, PullTracker};
use engine_core::{
    ApiErrorCode, EngineClient, EngineError, EngineStream, ExecEngine, ExecRequest, PlanDecision,
    PullEngine,
};
use engine_docker::DockerEngine;
use futures_util::{FutureExt, StreamExt};

const PREFIX: &str = "dockinng-test-eng-";
const LABEL: &str = "dev.dockinng.test";
const BASE_IMAGE: &str = "alpine:latest";
const REGISTRY_IMAGE: &str = "localhost:54109/dockinng-test/layers:1";

static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn short() -> String {
    uuid::Uuid::now_v7().simple().to_string()[20..].to_string()
}

fn labels() -> HashMap<String, String> {
    HashMap::from([(LABEL.to_string(), "1".to_string())])
}

fn assert_ours(name: &str) {
    assert!(
        name.starts_with(PREFIX) || name.starts_with("localhost:54109/dockinng-test/"),
        "se intentó tocar un recurso ajeno: {name}"
    );
}

struct Env {
    docker: Docker,
    engine: Arc<DockerEngine>,
    id: String,
    containers: StdMutex<Vec<String>>,
    volumes: StdMutex<Vec<String>>,
    networks: StdMutex<Vec<String>>,
    images: StdMutex<Vec<String>>,
    /// Directorios temporales creados (se borran al limpiar).
    dirs: StdMutex<Vec<std::path::PathBuf>>,
}

impl Env {
    async fn new(name: &str) -> Option<Env> {
        if std::env::var("DOCKINNG_LIVE_TESTS").ok().as_deref() != Some("1") {
            eprintln!("SKIP {name}: define DOCKINNG_LIVE_TESTS=1");
            return None;
        }
        let engine = Arc::new(DockerEngine::new());
        if tokio::time::timeout(Duration::from_secs(3), engine.ping())
            .await
            .map(|r| r.is_err())
            .unwrap_or(true)
        {
            panic!("{name}: no hay Docker");
        }
        let docker = Docker::connect_with_unix_defaults().ok()?;
        assert!(
            docker.inspect_image(BASE_IMAGE).await.is_ok(),
            "falta {BASE_IMAGE} (no se hace pull)"
        );
        Some(Env {
            docker,
            engine,
            id: short(),
            containers: Default::default(),
            volumes: Default::default(),
            networks: Default::default(),
            images: Default::default(),
            dirs: Default::default(),
        })
    }

    fn name(&self, what: &str) -> String {
        format!("{PREFIX}{}-{what}", self.id)
    }

    /// Contenedor auxiliar (sleep) creado por bollard directamente, con la label de prueba.
    async fn sleeper(&self, what: &str, start: bool) -> String {
        let name = self.name(what);
        let body = ContainerCreateBody {
            image: Some(BASE_IMAGE.into()),
            cmd: Some(vec!["sleep".into(), "300".into()]),
            labels: Some(labels()),
            host_config: Some(HostConfig::default()),
            ..Default::default()
        };
        self.docker
            .create_container(
                Some(CreateContainerOptionsBuilder::default().name(&name).build()),
                body,
            )
            .await
            .expect("crear auxiliar");
        self.containers.lock().expect("lock").push(name.clone());
        if start {
            self.docker
                .start_container(&name, None::<StartContainerOptions>)
                .await
                .expect("start auxiliar");
        }
        name
    }

    fn tmp_dir(&self, what: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("{PREFIX}{}-{what}", self.id));
        std::fs::create_dir_all(&d).expect("tmp");
        self.dirs.lock().expect("lock").push(d.clone());
        d
    }

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
        let dirs: Vec<std::path::PathBuf> = self.dirs.lock().expect("lock").clone();
        for d in dirs.iter() {
            assert_ours(d.file_name().and_then(|n| n.to_str()).unwrap_or(""));
            let _ = std::fs::remove_dir_all(d);
        }
    }
}

async fn guarded<F: Future<Output = ()>>(env: &Env, body: F) {
    let r = AssertUnwindSafe(body).catch_unwind().await;
    env.cleanup().await;
    if let Err(p) = r {
        std::panic::resume_unwind(p);
    }
}

/// Restos de ejecuciones anteriores de ESTE archivo: label de prueba Y prefijo propio.
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

fn service(env: &Env) -> CreateService {
    CreateService::new(env.engine.clone(), env.engine.clone())
}

fn base_spec(name: Option<String>) -> CreateContainerSpec {
    CreateContainerSpec {
        image: BASE_IMAGE.into(),
        name,
        ports: vec![],
        volumes: vec![],
        env: vec![],
        network: None,
        restart: RestartPolicy::No,
        restart_max_retries: None,
        command: Some("sleep 300".into()),
        labels: labels(),
    }
}

/// Primer puerto libre del rango reservado del proyecto (54100–54108; el 54109 es del registro falso).
fn free_port() -> u16 {
    (54100u16..=54108)
        .find(|p| std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .expect("hay un puerto libre en 54100-54108")
}

// ---------------------------------------------------------------------- volumen y red

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn live_volumen_y_red_nuevos_con_duplicados_y_validacion() {
    live!("volumen_red", |env| {
        let svc = service(&env);
        // --- volumen
        let vname = env.name("vol");
        env.volumes.lock().expect("lock").push(vname.clone());
        let v = svc
            .create_volume(CreateVolumeSpec {
                name: vname.clone(),
                labels: labels(),
            })
            .await
            .expect("crear volumen");
        assert_eq!(v.name, vname);
        assert_eq!(v.driver, "local");
        assert_eq!(v.labels.get(LABEL).map(String::as_str), Some("1"));
        assert_eq!(
            v.labels.get("dev.dockinng.created").map(String::as_str),
            Some("1")
        );
        assert!(!v.anonymous);
        // Docker es idempotente, la app NO: el duplicado es Conflict.
        let e = svc
            .create_volume(CreateVolumeSpec {
                name: vname.clone(),
                labels: labels(),
            })
            .await
            .expect_err("duplicado");
        assert_eq!(e.code, ApiErrorCode::Conflict);
        // Nombres inválidos y etiquetas reservadas no llegan al daemon.
        for bad in ["", "a b", "a/b"] {
            let e = svc
                .create_volume(CreateVolumeSpec {
                    name: bad.into(),
                    labels: HashMap::new(),
                })
                .await
                .expect_err("inválido");
            assert_eq!(e.code, ApiErrorCode::InvalidInput, "{bad:?}");
        }
        let e = svc
            .create_volume(CreateVolumeSpec {
                name: env.name("vol-x"),
                labels: HashMap::from([("com.docker.compose.project".into(), "x".into())]),
            })
            .await
            .expect_err("etiqueta reservada");
        assert_eq!(e.code, ApiErrorCode::InvalidInput);
        // Nunca se crearon anónimos ni el volumen rechazado.
        let vols = env.engine.list_volumes().await.expect("list");
        assert!(!vols.iter().any(|v| v.name == env.name("vol-x")));

        // --- red
        let nname = env.name("net");
        env.networks.lock().expect("lock").push(nname.clone());
        let third = 200 + (env.id.bytes().map(u32::from).sum::<u32>() % 50);
        let subnet = format!("10.{third}.{}.0/24", 100 + env.id.len() as u32);
        let n = svc
            .create_network(CreateNetworkSpec {
                name: nname.clone(),
                internal: true,
                subnet: Some(subnet.clone()),
                gateway: None,
                labels: labels(),
            })
            .await
            .expect("crear red");
        assert_eq!(n.name, nname);
        assert!(n.internal);
        assert_eq!(n.driver, "bridge");
        assert!(n.subnets.contains(&subnet), "{:?}", n.subnets);
        let e = svc
            .create_network(CreateNetworkSpec {
                name: nname.clone(),
                internal: false,
                subnet: None,
                gateway: None,
                labels: labels(),
            })
            .await
            .expect_err("duplicada");
        assert_eq!(e.code, ApiErrorCode::Conflict);
        for (bad, sub) in [("bridge", None), ("HOST", None), ("x y", None)] {
            let e = svc
                .create_network(CreateNetworkSpec {
                    name: bad.into(),
                    internal: false,
                    subnet: sub,
                    gateway: None,
                    labels: HashMap::new(),
                })
                .await
                .expect_err("inválida");
            assert_eq!(e.code, ApiErrorCode::InvalidInput, "{bad}");
        }
        let e = svc
            .create_network(CreateNetworkSpec {
                name: env.name("net-bad"),
                internal: false,
                subnet: Some("999.1.1.0/24".into()),
                gateway: None,
                labels: HashMap::new(),
            })
            .await
            .expect_err("subred inválida");
        assert_eq!(e.code, ApiErrorCode::InvalidInput);
    });
}

// -------------------------------------------------------------------- crear contenedor

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn live_crear_contenedor_completo_y_errores() {
    live!("crear", |env| {
        let svc = service(&env);
        let vol = env.name("vol");
        env.volumes.lock().expect("lock").push(vol.clone());
        let dir = env.tmp_dir("bind");
        let port = free_port();
        let name = env.name("app");
        env.containers.lock().expect("lock").push(name.clone());

        let mut spec = base_spec(Some(name.clone()));
        spec.ports = vec![PortSpec {
            host_ip: None,
            host_port: Some(port),
            container_port: 80,
            protocol: PortProtocol::Tcp,
        }];
        spec.volumes = vec![
            VolumeSpec {
                source: vol.clone(),
                target: "/data".into(),
                read_only: false,
            },
            VolumeSpec {
                source: dir.to_str().expect("utf8").into(),
                target: "/host".into(),
                read_only: true,
            },
        ];
        spec.env = vec![EnvVar {
            key: "A".into(),
            value: "b=c".into(),
        }];
        spec.restart = RestartPolicy::OnFailure;
        spec.restart_max_retries = Some(3);
        spec.command = Some("sleep 300".into());

        let plan = svc.plan(spec.clone()).await.expect("plan");
        assert!(plan.ok, "{:?}", plan.field_errors);
        assert_eq!(plan.decision, PlanDecision::Allow);
        assert!(plan.ticket.is_none());
        // Volumen con nombre inexistente: Docker lo crea al crear el contenedor (se registró para limpiar).
        let res = svc.create(spec.clone(), false, None).await.expect("crear");
        assert_eq!(res.name, name);
        assert!(!res.started && res.start_error.is_none());

        // El inspect coincide con lo pedido.
        let i = env
            .docker
            .inspect_container(&name, None)
            .await
            .expect("inspect");
        let cfg = i.config.expect("config");
        assert_eq!(
            cfg.env
                .expect("env")
                .iter()
                .filter(|e| *e == "A=b=c")
                .count(),
            1
        );
        assert_eq!(cfg.cmd, Some(vec!["sleep".to_string(), "300".to_string()]));
        let lbls = cfg.labels.expect("labels");
        assert_eq!(lbls.get(LABEL).map(String::as_str), Some("1"));
        assert_eq!(
            lbls.get("dev.dockinng.created").map(String::as_str),
            Some("1")
        );
        let hc = i.host_config.expect("hc");
        let pb = hc.port_bindings.expect("pb");
        let b = pb["80/tcp"].as_ref().expect("v")[0].clone();
        assert_eq!(b.host_ip.as_deref(), Some("127.0.0.1"));
        assert_eq!(b.host_port, Some(port.to_string()));
        let rp = hc.restart_policy.expect("rp");
        assert_eq!(rp.maximum_retry_count, Some(3));
        assert_eq!(format!("{:?}", rp.name), "Some(ON_FAILURE)");
        let mounts = i.mounts.expect("mounts");
        assert!(
            mounts
                .iter()
                .any(|m| m.destination.as_deref() == Some("/data"))
        );
        let bind = mounts
            .iter()
            .find(|m| m.destination.as_deref() == Some("/host"))
            .expect("bind");
        assert_eq!(bind.rw, Some(false));
        assert!(hc.privileged != Some(true));

        // Nombre duplicado => Conflict.
        let e = svc
            .create(spec.clone(), false, None)
            .await
            .expect_err("duplicado");
        assert_eq!(e.code, ApiErrorCode::Conflict);

        // Bind inexistente: el daemon lo rechaza y el contenedor NO se crea.
        let mut s2 = base_spec(Some(env.name("nobind")));
        s2.volumes = vec![VolumeSpec {
            source: dir.join("no-existe").to_str().expect("utf8").into(),
            target: "/x".into(),
            read_only: false,
        }];
        let e = svc.create(s2.clone(), false, None).await.expect_err("bind");
        assert_eq!(e.code, ApiErrorCode::InvalidInput);
        assert!(
            env.docker
                .inspect_container(&env.name("nobind"), None)
                .await
                .is_err()
        );

        // Imagen ausente: NUNCA hace pull, devuelve image_missing.
        let mut s3 = base_spec(Some(env.name("noimg")));
        s3.image = "dockinng-test-eng-no-existe:1".into();
        let e = svc.create(s3, false, None).await.expect_err("imagen");
        assert_eq!(e.code, ApiErrorCode::ImageMissing);

        // Ruta relativa y red inexistente: errores de campo, sin tocar el daemon.
        let mut s4 = base_spec(None);
        s4.volumes = vec![VolumeSpec {
            source: "./datos".into(),
            target: "/d".into(),
            read_only: false,
        }];
        let p = svc.plan(s4).await.expect("plan");
        assert!(!p.ok && p.field_errors[0].field == "volumes[0].source");
        let mut s5 = base_spec(None);
        s5.network = Some(env.name("no-red"));
        let p = svc.plan(s5).await.expect("plan");
        assert!(!p.ok && p.field_errors[0].field == "network");

        // Crear e iniciar: started.
        let n2 = env.name("run");
        env.containers.lock().expect("lock").push(n2.clone());
        let r = svc
            .create(base_spec(Some(n2.clone())), true, None)
            .await
            .expect("crear e iniciar");
        assert!(r.started && r.start_error.is_none());
        let i = env
            .docker
            .inspect_container(&n2, None)
            .await
            .expect("inspect");
        assert_eq!(i.state.and_then(|s| s.running), Some(true));

        // Falla el arranque (puerto ocupado): Ok con `start_error`, el contenedor queda creado.
        let occupied = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("puerto");
        let busy = occupied.local_addr().expect("addr").port();
        let n3 = env.name("busy");
        env.containers.lock().expect("lock").push(n3.clone());
        let mut s6 = base_spec(Some(n3.clone()));
        s6.ports = vec![PortSpec {
            host_ip: Some("127.0.0.1".into()),
            host_port: Some(busy),
            container_port: 80,
            protocol: PortProtocol::Tcp,
        }];
        let r = svc
            .create(s6, true, None)
            .await
            .expect("crea aunque no arranque");
        assert!(!r.started);
        assert!(r.start_error.is_some(), "{r:?}");
        assert!(env.docker.inspect_container(&n3, None).await.is_ok());
        drop(occupied);
    });
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn live_crear_con_riesgos_exige_ticket_del_mismo_spec() {
    live!("riesgos", |env| {
        let svc = service(&env);
        let name = env.name("host");
        env.containers.lock().expect("lock").push(name.clone());
        // network=host: solo se CREA (no se inicia).
        let mut spec = base_spec(Some(name.clone()));
        spec.network = Some("host".into());
        let plan = svc.plan(spec.clone()).await.expect("plan");
        assert_eq!(plan.decision, PlanDecision::Confirm);
        let ticket = plan.ticket.expect("ticket");
        let e = svc
            .create(spec.clone(), false, None)
            .await
            .expect_err("sin ticket");
        assert_eq!(e.code, ApiErrorCode::TicketInvalid);
        // Ticket de otra spec (otro nombre): rechazado y consumido.
        let mut otra = spec.clone();
        otra.name = Some(env.name("otra"));
        let e = svc
            .create(otra, false, Some(&ticket))
            .await
            .expect_err("otra spec");
        assert_eq!(e.code, ApiErrorCode::TicketInvalid);
        assert!(
            env.docker
                .inspect_container(&env.name("otra"), None)
                .await
                .is_err()
        );
        // Ticket nuevo del mismo spec: se crea; un segundo uso falla.
        let ticket = svc
            .plan(spec.clone())
            .await
            .expect("plan")
            .ticket
            .expect("t");
        svc.create(spec.clone(), false, Some(&ticket))
            .await
            .expect("crea");
        let mut again = spec.clone();
        again.name = Some(env.name("again"));
        let e = svc
            .create(again, false, Some(&ticket))
            .await
            .expect_err("reuso");
        assert_eq!(e.code, ApiErrorCode::TicketInvalid);
        let i = env
            .docker
            .inspect_container(&name, None)
            .await
            .expect("inspect");
        assert_eq!(
            i.host_config.and_then(|h| h.network_mode).as_deref(),
            Some("host")
        );
    });
}

// ----------------------------------------------------------------------------- exec

/// Lee salida hasta que aparezca `needle` (o vence el plazo). Devuelve todo lo acumulado.
async fn read_until(out: &mut EngineStream<Vec<u8>>, needle: &str, secs: u64) -> Vec<u8> {
    let mut acc = Vec::new();
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        match tokio::time::timeout(Duration::from_millis(200), out.next()).await {
            Ok(Some(Ok(b))) => {
                acc.extend(b);
                if String::from_utf8_lossy(&acc).contains(needle) {
                    return acc;
                }
            }
            Ok(_) => return acc,
            Err(_) => {}
        }
    }
    acc
}

/// Procesos que corren dentro del contenedor (exec sin TTY, `ps`).
async fn ps(docker: &Docker, container: &str) -> String {
    let e = docker
        .create_exec(
            container,
            CreateExecOptions {
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                cmd: Some(vec!["ps"]),
                ..Default::default()
            },
        )
        .await
        .expect("exec ps");
    let StartExecResults::Attached { mut output, .. } = docker
        .start_exec(&e.id, Some(StartExecOptions::default()))
        .await
        .expect("start ps")
    else {
        panic!("desacoplado");
    };
    let mut s = String::new();
    while let Some(Ok(o)) = output.next().await {
        s.push_str(&String::from_utf8_lossy(&o.into_bytes()));
    }
    s
}

fn req(c: &str) -> ExecRequest {
    ExecRequest {
        container: c.into(),
        cols: 100,
        rows: 30,
    }
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn live_exec_sesion_resize_teclas_de_desacople_y_cierre_sin_fugas() {
    live!("exec", |env| {
        let c = env.sleeper("exec", true).await;
        let mut s = env.engine.open_exec(req(&c)).await.expect("abrir");
        assert!(s.info.shell == "/bin/sh" || s.info.shell == "/bin/bash");
        assert!(!s.info.risk.privileged && !s.info.risk.docker_socket);
        let mut acc = read_until(&mut s.output, "#", 5).await;
        assert!(!acc.is_empty(), "el shell debe mostrar algo (prompt)");

        s.control.write(b"echo hola-mundo\n").await.expect("write");
        acc = read_until(&mut s.output, "hola-mundo\r\n", 5).await;
        assert!(String::from_utf8_lossy(&acc).contains("hola-mundo"));

        // El resize inicial ya fue 100x30; se cambia y se verifica con stty.
        s.control.resize(132, 43).await.expect("resize");
        s.control.write(b"stty size\n").await.expect("write");
        let acc = read_until(&mut s.output, "43 132", 5).await;
        assert!(
            String::from_utf8_lossy(&acc).contains("43 132"),
            "{:?}",
            String::from_utf8_lossy(&acc)
        );

        // Teclas de desacople de Docker (Ctrl-P, Ctrl-Q): NO deben cerrar la sesión.
        s.control.write(&[0x10, 0x11]).await.expect("write");
        s.control.write(b"\necho sigo-vivo\n").await.expect("write");
        let acc = read_until(&mut s.output, "sigo-vivo\r\n", 5).await;
        assert!(
            String::from_utf8_lossy(&acc).contains("sigo-vivo"),
            "las teclas de desacople cerraron la sesión: {:?}",
            String::from_utf8_lossy(&acc)
        );

        // Un proceso en primer plano tampoco debe sobrevivir al cierre.
        s.control.write(b"sleep 251\n").await.expect("write");
        tokio::time::sleep(Duration::from_millis(300)).await;
        let before = ps(&env.docker, &c).await;
        assert!(before.contains("sleep 251"), "{before}");
        // Control positivo: el filtro de fugas de abajo sí ve un shell mientras la sesión vive.
        assert!(
            before
                .lines()
                .any(|l| l.contains("sh") && !l.contains("ps")),
            "el filtro no detecta el shell vivo:\n{before}"
        );

        // Cierre: mata el shell (soltar el stream NO lo mata: hallazgo verificado).
        let code = s.control.close().await;
        assert!(code.is_ok());
        tokio::time::sleep(Duration::from_millis(500)).await;
        let after = ps(&env.docker, &c).await;
        let leftovers: Vec<&str> = after
            .lines()
            .filter(|l| l.contains("sh") && !l.contains("ps"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "quedó un shell dentro del contenedor:\n{after}"
        );
        assert!(
            !after.contains("sleep 251"),
            "el proceso en primer plano sobrevivió:\n{after}"
        );
        assert!(
            after.contains("sleep 300"),
            "el proceso principal no debe tocarse:\n{after}"
        );
    });
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn live_exec_contenedor_parado_y_fin_natural_del_shell() {
    live!("exec2", |env| {
        // Parado: Conflict (el backend no confía en la UI).
        let stopped = env.sleeper("parado", false).await;
        let e = env
            .engine
            .open_exec(req(&stopped))
            .await
            .err()
            .expect("parado");
        assert!(matches!(e, EngineError::Conflict(_)), "{e:?}");
        // Inexistente y con id hostil.
        let e = env
            .engine
            .open_exec(req(&env.name("no-existe")))
            .await
            .err()
            .expect("404");
        assert!(matches!(e, EngineError::NotFound(_)), "{e:?}");
        let e = env.engine.open_exec(req("a/b?x")).await.err().expect("id");
        assert!(matches!(e, EngineError::InvalidInput(_)), "{e:?}");

        // Fin natural: `exit 7` => el stream termina y el código queda disponible.
        let c = env.sleeper("fin", true).await;
        let mut s = env.engine.open_exec(req(&c)).await.expect("abrir");
        read_until(&mut s.output, "#", 5).await;
        s.control.write(b"exit 7\n").await.expect("write");
        let mut ended = false;
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            if let Ok(None) =
                tokio::time::timeout(Duration::from_millis(200), s.output.next()).await
            {
                ended = true;
                break;
            }
        }
        assert!(ended, "el stream debe terminar al salir el shell");
        let mut code = None;
        for _ in 0..40 {
            code = s.control.exit_code().await;
            if code.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(code, Some(7));
        let after = ps(&env.docker, &c).await;
        assert!(
            !after.lines().any(|l| l.contains("sh") && !l.contains("ps")),
            "{after}"
        );
    });
}

/// Caracteriza el bug conocido de bollard con TTY: un fragmento de salida que empieza por
/// el byte 0x01/0x02 se interpreta como cabecera multiplexada y se pierde. Si este test
/// falla porque el fragmento SÍ llega, bollard lo corrigió: actualizar PENDIENTES.
#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn live_exec_regresion_bug_bollard_fragmento_que_empieza_con_byte_de_control() {
    live!("exec_raw", |env| {
        let c = env.sleeper("raw", true).await;
        let mut s = env.engine.open_exec(req(&c)).await.expect("abrir");
        read_until(&mut s.output, "#", 5).await;
        // `printf` tras una pausa: la salida empieza por 0x01 en su propio fragmento.
        s.control
            .write(b"sleep 0.5; printf '\\001AB\\n'; sleep 0.5; printf 'fin-raw\\n'\n")
            .await
            .expect("write");
        let acc = read_until(&mut s.output, "fin-raw\r\n", 8).await;
        let text = String::from_utf8_lossy(&acc).to_string();
        assert!(
            text.contains("fin-raw"),
            "la salida posterior debe llegar: {text:?}"
        );
        let lost = !acc.windows(3).any(|w| w == [0x01, b'A', b'B']);
        eprintln!("bug de bollard con TTY (fragmento que empieza por 0x01 perdido): {lost}");
        assert!(
            lost,
            "el fragmento con 0x01 al inicio llegó: bollard corrigió el bug; retirar el riesgo aceptado"
        );
        let _ = s.control.close().await;
    });
}

/// El riesgo se calcula del inspect REAL (claves del modelo de bollard): contenedor con
/// docker.sock, red y pid del equipo y privilegios.
#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn live_exec_riesgo_del_contenedor_desde_inspect_real() {
    live!("exec_risk", |env| {
        let name = env.name("risk");
        let body = ContainerCreateBody {
            image: Some(BASE_IMAGE.into()),
            cmd: Some(vec!["sleep".into(), "300".into()]),
            labels: Some(labels()),
            host_config: Some(HostConfig {
                binds: Some(vec!["/var/run/docker.sock:/var/run/docker.sock:ro".into()]),
                network_mode: Some("host".into()),
                pid_mode: Some("host".into()),
                privileged: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        };
        env.docker
            .create_container(
                Some(CreateContainerOptionsBuilder::default().name(&name).build()),
                body,
            )
            .await
            .expect("crear");
        env.containers.lock().expect("lock").push(name.clone());
        env.docker
            .start_container(&name, None::<StartContainerOptions>)
            .await
            .expect("start");
        let s = env.engine.open_exec(req(&name)).await.expect("abrir");
        let r = s.info.risk;
        assert!(
            r.privileged && r.docker_socket && r.host_pid && r.host_network,
            "{r:?}"
        );
        let _ = s.control.close().await;
        // Un contenedor normal no marca ningún riesgo.
        let calm = env.sleeper("calm", true).await;
        let s = env.engine.open_exec(req(&calm)).await.expect("abrir");
        assert_eq!(s.info.risk, engine_core::ExecRisk::default());
        let _ = s.control.close().await;
    });
}

// ----------------------------------------------------------------------------- pull

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y Docker"]
async fn live_pull_solo_caminos_de_error_sin_red_externa() {
    live!("pull_err", |env| {
        // Registro caído en localhost (sin tráfico externo): registry_unreachable.
        let e = env
            .engine
            .pull_image("localhost:1/dockinng-test/x:1")
            .next()
            .await
            .expect("evento")
            .expect_err("caído");
        assert!(
            matches!(
                e,
                EngineError::Coded {
                    code: ApiErrorCode::RegistryUnreachable,
                    ..
                }
            ),
            "{e:?}"
        );
        // Referencia inválida: por validación propia y por el daemon (mayúsculas).
        for bad in ["", "a b", "--x"] {
            let e = env
                .engine
                .pull_image(bad)
                .next()
                .await
                .expect("ev")
                .expect_err("inválida");
            assert!(matches!(e, EngineError::InvalidInput(_)), "{bad:?} {e:?}");
        }
        let e = env
            .engine
            .pull_image("localhost:1/dockinng-test/BAD:1")
            .next()
            .await
            .expect("ev")
            .expect_err("mayúsculas");
        assert!(matches!(e, EngineError::InvalidInput(_)), "{e:?}");
    });
}

/// Pull real por capas y cancelación contra el registro local falso en 127.0.0.1:54109
/// (opt-in: `DOCKINNG_LIVE_REGISTRY=1` con el registro levantado). Nada de Docker Hub.
#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1, Docker y DOCKINNG_LIVE_REGISTRY=1 con el registro local"]
async fn live_pull_por_capas_y_cancelacion_contra_registro_local() {
    if std::env::var("DOCKINNG_LIVE_REGISTRY").ok().as_deref() != Some("1") {
        eprintln!("SKIP: define DOCKINNG_LIVE_REGISTRY=1 con el registro local en 127.0.0.1:54109");
        return;
    }
    live!("pull_ok", |env| {
        assert_ours(REGISTRY_IMAGE);
        env.images
            .lock()
            .expect("lock")
            .push(REGISTRY_IMAGE.to_string());
        assert!(
            env.docker.inspect_image(REGISTRY_IMAGE).await.is_err(),
            "la imagen de prueba ya existía: no se toca"
        );
        // Cancelación PRIMERO (con Docker 29 los blobs quedan en caché tras un pull completo y
        // un segundo pull terminaría antes de poder cancelarlo): se suelta el stream a medias.
        let mut s = env.engine.pull_image(REGISTRY_IMAGE);
        let mut seen = 0;
        let mut saw_downloading = false;
        while let Some(ev) = s.next().await {
            let ev = ev.expect("evento");
            saw_downloading |= ev.status == "Downloading";
            seen += 1;
            if seen >= 8 && saw_downloading {
                break;
            }
            if seen >= 30 {
                break;
            }
        }
        drop(s);
        tokio::time::sleep(Duration::from_secs(4)).await;
        if saw_downloading {
            assert!(
                env.docker.inspect_image(REGISTRY_IMAGE).await.is_err(),
                "cancelar debe abortar la descarga: no debe quedar la imagen"
            );
        } else {
            // Contenido ya en caché del daemon: el pull terminó sin descargar y no hay nada que cancelar.
            // Usa un registro con contenido nuevo (ver `reg_fresh.py` en las notas) para verificarlo.
            eprintln!("AVISO: contenido en caché; cancelación no verificable en esta ejecución");
            let _ = env
                .docker
                .remove_image(
                    REGISTRY_IMAGE,
                    None::<bollard::query_parameters::RemoveImageOptions>,
                    None,
                )
                .await;
        }
        // Camino feliz.
        let mut t = PullTracker::new();
        let mut s = env.engine.pull_image(REGISTRY_IMAGE);
        let mut events = 0;
        while let Some(ev) = s.next().await {
            t.feed(&ev.expect("evento"));
            events += 1;
        }
        assert!(events > 5);
        let snap = t.snapshot();
        assert_eq!(snap.layers.len(), 3, "{snap:?}");
        assert!(snap.layers.iter().all(|l| l.phase == LayerPhase::Complete));
        assert!(snap.total_bytes > 10_000_000 && snap.done_bytes == snap.total_bytes);
        assert!(t.digest().is_some());
        assert!(env.docker.inspect_image(REGISTRY_IMAGE).await.is_ok());
        // Segundo pull: ya actualizada.
        let mut t2 = PullTracker::new();
        let mut s = env.engine.pull_image(REGISTRY_IMAGE);
        while let Some(ev) = s.next().await {
            t2.feed(&ev.expect("evento"));
        }
        assert!(t2.up_to_date());
        // Etiqueta inexistente en el registro: image_missing.
        let e = env
            .engine
            .pull_image("localhost:54109/dockinng-test/nope:1")
            .next()
            .await
            .expect("ev")
            .expect_err("404");
        assert!(
            matches!(
                e,
                EngineError::Coded {
                    code: ApiErrorCode::ImageMissing,
                    ..
                }
            ),
            "{e:?}"
        );
        // Requiere autenticación: auth_required.
        let e = env
            .engine
            .pull_image("localhost:54109/dockinng-test/private:1")
            .next()
            .await
            .expect("ev")
            .expect_err("401");
        assert!(
            matches!(
                e,
                EngineError::Coded {
                    code: ApiErrorCode::AuthRequired,
                    ..
                }
            ),
            "{e:?}"
        );
    });
}
