//! Pruebas VIVAS del túnel SSH contra un `sshd` local desechable (127.0.0.1:54110).
//! `DOCKINNG_LIVE_TESTS=1 DOCKINNG_LIVE_SSH=1 cargo test -p transport --test live_ssh -- --ignored --test-threads=1`
//!
//! Sin servidores reales: llave y host key desechables, `-F /dev/null`, known_hosts temporal.
//! El `docker system dial-stdio` remoto habla con el socket local del propio equipo y solo se
//! hacen lecturas (más un contenedor `dockinng-test-remote-*` con label `dev.dockinng.test=1`).

mod support;

use std::os::unix::fs::MetadataExt;
use std::sync::Arc;
use std::time::Duration;

use engine_core::{ConnectionCause, ConnectionStatus, EngineClient, HostKeyState, LogsRequest};
use engine_docker::{DockerEngine, Target};
use support::{LOCK, PORT, Sshd, gate, keygen, pid_alive};
use transport::keyscan;
use transport::ssh_args::SshTarget;
use transport::{Tunnel, TunnelConfig};

/// Motor apuntando al túnel (con la pista de fallos del transporte).
fn engine_for(t: &Tunnel) -> Arc<DockerEngine> {
    let e = Arc::new(DockerEngine::new());
    e.set_target(Target::tunnel(
        &t.socket_path().to_string_lossy(),
        "ssh://fixture",
        Some(t.failure_hint()),
    ));
    e
}

async fn start_tunnel(s: &Sshd, cfg: TunnelConfig) -> Tunnel {
    let target = SshTarget::from_spec(&s.spec()).expect("spec");
    Tunnel::start(&target, &s.known_hosts(), &s.tunnels_dir(), cfg)
        .await
        .expect("túnel")
}

async fn trust(s: &Sshd, spec: &engine_core::ConnSpec) -> engine_core::HostKeyProbe {
    let target = SshTarget::from_spec(spec).unwrap();
    let probe = keyscan::probe(&target, &s.known_hosts())
        .await
        .expect("probe");
    keyscan::trust(&target, &s.known_hosts(), &probe.fingerprint_sha256)
        .await
        .expect("trust")
}

async fn failed_cause(e: &DockerEngine) -> ConnectionCause {
    match e.diagnose().await {
        ConnectionStatus::Failed { cause, .. } => cause,
        ok => panic!("se esperaba fallo, hubo {ok:?}"),
    }
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y DOCKINNG_LIVE_SSH=1"]
async fn tofu_explicito_y_tunel_funcional_sin_huerfanos() {
    if !gate() {
        return;
    }
    let _g = LOCK.lock().await;
    let s = Sshd::start("ok");
    let spec = s.spec();
    let target = SshTarget::from_spec(&spec).unwrap();

    // 1) Primer contacto: desconocido; nada se escribe al sondear.
    let p = keyscan::probe(&target, &s.known_hosts()).await.unwrap();
    assert_eq!(p.state, HostKeyState::Unknown);
    assert!(p.fingerprint_sha256.starts_with("SHA256:"));
    assert!(!s.known_hosts().exists(), "sondear no debe escribir");
    // Una huella distinta a la vista se rechaza y sigue sin escribirse.
    assert!(
        keyscan::trust(&target, &s.known_hosts(), "SHA256:otra")
            .await
            .is_err()
    );
    assert!(!s.known_hosts().exists());
    // Confiar con la huella correcta.
    let trusted = keyscan::trust(&target, &s.known_hosts(), &p.fingerprint_sha256)
        .await
        .unwrap();
    assert_eq!(trusted.fingerprint_sha256, p.fingerprint_sha256);
    assert_eq!(trusted.state, HostKeyState::Trusted);
    // La huella guardada se recupera sin red y coincide con la que vio el usuario.
    assert_eq!(
        keyscan::stored_fingerprint(&s.known_hosts(), &target)
            .await
            .unwrap(),
        Some(p.fingerprint_sha256.clone())
    );
    assert_eq!(
        std::fs::metadata(s.known_hosts()).unwrap().mode() & 0o777,
        0o600
    );
    let p2 = keyscan::probe(&target, &s.known_hosts()).await.unwrap();
    assert_eq!(p2.state, HostKeyState::Trusted);

    // 2) Túnel: socket 0600, dir 0700 y el daemon responde a través de él.
    let tunnel = start_tunnel(&s, TunnelConfig::default()).await;
    assert_eq!(
        std::fs::metadata(tunnel.socket_path()).unwrap().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(tunnel.socket_path().parent().unwrap())
            .unwrap()
            .mode()
            & 0o777,
        0o700
    );
    let engine = engine_for(&tunnel);
    assert!(engine.is_remote());
    engine.ping().await.expect("ping por el túnel");
    let info = engine.info().await.expect("info");
    assert!(!info.version.is_empty());
    engine
        .list_containers(true)
        .await
        .expect("listar por el túnel");
    match engine.diagnose().await {
        ConnectionStatus::Connected { endpoint, .. } => assert_eq!(endpoint, "ssh://fixture"),
        other => panic!("{other:?}"),
    }

    // 3) Sin huérfanos: tras cerrar el túnel no queda ningún `ssh` de este fixture.
    let pids = tunnel.active_children();
    let sock = tunnel.socket_path().to_path_buf();
    drop(engine);
    tunnel.shutdown().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!sock.exists(), "el socket debe borrarse");
    for pid in pids {
        assert!(!pid_alive(pid), "ssh huérfano {pid}");
    }
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y DOCKINNG_LIVE_SSH=1"]
async fn host_key_desconocida_no_conecta() {
    if !gate() {
        return;
    }
    let _g = LOCK.lock().await;
    let s = Sshd::start("unknown");
    let tunnel = start_tunnel(&s, TunnelConfig::default()).await;
    let engine = engine_for(&tunnel);
    assert_eq!(failed_cause(&engine).await, ConnectionCause::HostKeyUnknown);
    // Nunca se escribió nada en known_hosts por conectar.
    assert!(!s.known_hosts().exists());
    tunnel.shutdown().await;
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y DOCKINNG_LIVE_SSH=1"]
async fn host_key_cambiada_se_detecta_y_no_se_acepta() {
    if !gate() {
        return;
    }
    let _g = LOCK.lock().await;
    let s = Sshd::start("changed");
    // known_hosts con OTRA clave para este servidor.
    let other = s.dir.join("otra");
    keygen(&other);
    let pubkey = std::fs::read_to_string(s.dir.join("otra.pub")).unwrap();
    let mut parts = pubkey.split_whitespace();
    let (kt, blob) = (parts.next().unwrap(), parts.next().unwrap());
    std::fs::write(s.known_hosts(), format!("[127.0.0.1]:{PORT} {kt} {blob}\n")).unwrap();
    let target = SshTarget::from_spec(&s.spec()).unwrap();
    let p = keyscan::probe(&target, &s.known_hosts()).await.unwrap();
    assert_eq!(p.state, HostKeyState::Changed);
    // Confiar automáticamente en una clave cambiada está prohibido.
    assert!(
        keyscan::trust(&target, &s.known_hosts(), &p.fingerprint_sha256)
            .await
            .is_err()
    );
    let before = std::fs::read_to_string(s.known_hosts()).unwrap();
    let tunnel = start_tunnel(&s, TunnelConfig::default()).await;
    let engine = engine_for(&tunnel);
    assert_eq!(failed_cause(&engine).await, ConnectionCause::HostKeyChanged);
    assert_eq!(std::fs::read_to_string(s.known_hosts()).unwrap(), before);
    tunnel.shutdown().await;
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y DOCKINNG_LIVE_SSH=1"]
async fn llave_equivocada_es_auth_failed() {
    if !gate() {
        return;
    }
    let _g = LOCK.lock().await;
    let s = Sshd::start("auth");
    trust(&s, &s.spec()).await;
    let bad = s.dir.join("noautorizada");
    keygen(&bad);
    let spec = s.spec_with(&bad, PORT);
    let target = SshTarget::from_spec(&spec).unwrap();
    let tunnel = Tunnel::start(
        &target,
        &s.known_hosts(),
        &s.tunnels_dir(),
        TunnelConfig::default(),
    )
    .await
    .unwrap();
    let engine = engine_for(&tunnel);
    assert_eq!(failed_cause(&engine).await, ConnectionCause::AuthFailed);
    tunnel.shutdown().await;
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y DOCKINNG_LIVE_SSH=1"]
async fn puerto_cerrado_es_unreachable() {
    if !gate() {
        return;
    }
    let _g = LOCK.lock().await;
    let s = Sshd::start("closed");
    // Puerto efímero libre (se suelta enseguida): nadie escucha.
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let spec = s.spec_with(&s.identity(), closed);
    let target = SshTarget::from_spec(&spec).unwrap();
    let tunnel = Tunnel::start(
        &target,
        &s.known_hosts(),
        &s.tunnels_dir(),
        TunnelConfig::default(),
    )
    .await
    .unwrap();
    let engine = engine_for(&tunnel);
    assert_eq!(failed_cause(&engine).await, ConnectionCause::Unreachable);
    tunnel.shutdown().await;
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y DOCKINNG_LIVE_SSH=1"]
async fn docker_ausente_en_el_remoto() {
    if !gate() {
        return;
    }
    let _g = LOCK.lock().await;
    let s = Sshd::start("nodocker");
    trust(&s, &s.spec()).await;
    let cfg = TunnelConfig {
        docker_bin: "dockinng-inexistente-docker".into(),
        ..TunnelConfig::default()
    };
    let tunnel = start_tunnel(&s, cfg).await;
    let engine = engine_for(&tunnel);
    assert_eq!(
        failed_cause(&engine).await,
        ConnectionCause::RemoteDockerMissing
    );
    tunnel.shutdown().await;
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y DOCKINNG_LIVE_SSH=1"]
async fn peer_con_otro_uid_es_rechazado() {
    if !gate() {
        return;
    }
    let _g = LOCK.lock().await;
    let s = Sshd::start("peer");
    trust(&s, &s.spec()).await;
    // Solo se admite un uid que NO es el nuestro: nuestra conexión debe cerrarse sin `ssh`.
    let mine = unsafe { libc::geteuid() };
    let cfg = TunnelConfig {
        allowed_uid: Some(mine.wrapping_add(1)),
        ..TunnelConfig::default()
    };
    let tunnel = start_tunnel(&s, cfg).await;
    let engine = engine_for(&tunnel);
    assert!(engine.ping().await.is_err());
    assert!(tunnel.active_children().is_empty(), "no debía lanzarse ssh");
    tunnel.shutdown().await;
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y DOCKINNG_LIVE_SSH=1"]
async fn contenedor_de_prueba_a_traves_del_tunel_y_cli_hereda_docker_host() {
    if !gate() {
        return;
    }
    use engine_core::CreateEngine;
    use engine_core::create::{CreateContainerSpec, RestartPolicy};
    use futures_util::StreamExt;
    let _g = LOCK.lock().await;
    let s = Sshd::start("ctr");
    trust(&s, &s.spec()).await;
    let tunnel = start_tunnel(&s, TunnelConfig::default()).await;
    let engine = engine_for(&tunnel);
    let name = format!("dockinng-test-remote-{}", uuid::Uuid::now_v7().simple());
    let spec = CreateContainerSpec {
        image: "alpine:latest".into(),
        name: Some(name.clone()),
        ports: vec![],
        volumes: vec![],
        env: vec![],
        network: None,
        restart: RestartPolicy::No,
        restart_max_retries: None,
        command: Some("echo hola-desde-el-tunel".into()),
        labels: [("dev.dockinng.test".to_string(), "1".to_string())].into(),
    };
    let result = async {
        let created = engine.create_container(&spec, true).await.expect("crear");
        assert!(
            engine
                .list_containers(true)
                .await
                .unwrap()
                .iter()
                .any(|c| c.id == created.id)
        );
        let detail = engine
            .inspect_container(&created.id)
            .await
            .expect("inspect");
        assert_eq!(
            detail.summary.names.first().map(String::as_str),
            Some(name.as_str())
        );
        // Logs (el contenedor imprime y termina).
        tokio::time::sleep(Duration::from_millis(800)).await;
        let mut logs = engine.logs(
            &created.id,
            LogsRequest {
                tail: Some(10),
                follow: false,
                since: None,
            },
        );
        let mut text = String::new();
        while let Some(Ok(l)) = logs.next().await {
            text.push_str(&l.message);
        }
        assert!(text.contains("hola-desde-el-tunel"), "logs: {text:?}");
        // Un subproceso `docker` con DOCKER_HOST del túnel ve el mismo daemon.
        let out = tokio::process::Command::new("docker")
            .args([
                "ps",
                "-a",
                "--filter",
                &format!("name={name}"),
                "--format",
                "{{.Names}}",
            ])
            .env("DOCKER_HOST", engine.endpoint().display())
            .output()
            .await
            .expect("docker ps");
        assert!(String::from_utf8_lossy(&out.stdout).contains(&name));
        created.id
    }
    .await;
    // Limpieza: solo el contenedor propio.
    assert!(name.starts_with("dockinng-test-remote-"));
    engine
        .remove_container(&result, true)
        .await
        .expect("borrar");
    tunnel.shutdown().await;
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y DOCKINNG_LIVE_SSH=1"]
async fn identidad_por_agente_desechable() {
    if !gate() {
        return;
    }
    let _g = LOCK.lock().await;
    let s = Sshd::start("agent");
    // Agente propio y desechable con la llave del fixture (nunca el agente del usuario).
    let sock = s.dir.join("agent.sock");
    let mut agent = std::process::Command::new("ssh-agent")
        .args(["-D", "-a"])
        .arg(&sock)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .stdout(std::process::Stdio::null())
        .spawn()
        .expect("ssh-agent");
    let start = std::time::Instant::now();
    while !sock.exists() {
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "ssh-agent no arrancó"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let added = std::process::Command::new("ssh-add")
        .arg(s.identity())
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("SSH_AUTH_SOCK", &sock)
        .output()
        .expect("ssh-add");
    assert!(added.status.success());
    let spec = engine_core::ConnSpec::Ssh {
        name: "agent".into(),
        host: "127.0.0.1".into(),
        port: u32::from(PORT),
        user: s.user.clone(),
        mode: engine_core::SshMode::Explicit,
        identity: engine_core::SshIdentity::Agent,
    };
    trust(&s, &spec).await;
    let target = SshTarget::from_spec(&spec).unwrap();
    let cfg = TunnelConfig {
        ssh_auth_sock: Some(sock.clone()),
        ..TunnelConfig::default()
    };
    let tunnel = Tunnel::start(&target, &s.known_hosts(), &s.tunnels_dir(), cfg)
        .await
        .unwrap();
    let engine = engine_for(&tunnel);
    let ping = engine.ping().await;
    tunnel.shutdown().await;
    let _ = agent.kill();
    let _ = agent.wait();
    ping.expect("ping por agente");
}
