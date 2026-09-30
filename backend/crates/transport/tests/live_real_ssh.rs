//! Prueba viva contra un host SSH real ya documentado por el usuario.
//!
//! No crea ni modifica contenedores o servicios: solo ejecuta `docker system dial-stdio`
//! mediante el alias SSH, y hace `ping`, `info` y listado de contenedores (lecturas).
//!
//! Ejecución explícita:
//! `DOCKINNG_LIVE_TESTS=1 DOCKINNG_LIVE_REAL_SSH=1 cargo test -p transport --test live_real_ssh -- --ignored --nocapture --test-threads=1`
//!
//! El alias se puede cambiar con `DOCKINNG_LIVE_SSH_ALIAS`; por defecto es `debian-dev`.
//! La identidad es el agente SSH configurado por el usuario: esta prueba nunca lee, copia ni
//! imprime una llave privada.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use engine_core::{ConnSpec, EngineClient, HostKeyState, SshIdentity, SshMode};
use engine_docker::{DockerEngine, Target};
use tokio::net::UnixStream;
use transport::keyscan;
use transport::ssh_args::SshTarget;
use transport::{Tunnel, TunnelConfig};

fn gate() -> Option<String> {
    if std::env::var("DOCKINNG_LIVE_TESTS").as_deref() != Ok("1")
        || std::env::var("DOCKINNG_LIVE_REAL_SSH").as_deref() != Ok("1")
    {
        eprintln!("saltado: exige DOCKINNG_LIVE_TESTS=1 y DOCKINNG_LIVE_REAL_SSH=1");
        return None;
    }
    Some(std::env::var("DOCKINNG_LIVE_SSH_ALIAS").unwrap_or_else(|_| "debian-dev".into()))
}

fn temp_path(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "dockinng-live-real-ssh-{tag}-{}.known_hosts",
        uuid::Uuid::now_v7().simple()
    ))
}

fn spec(alias: String) -> ConnSpec {
    ConnSpec::Ssh {
        name: "live-real-ssh".into(),
        host: alias,
        port: 0,
        user: String::new(),
        mode: SshMode::Alias,
        identity: SshIdentity::Agent,
    }
}

async fn wait_for_children(tunnel: &Tunnel, expected: bool) {
    let start = Instant::now();
    loop {
        if (!tunnel.active_children().is_empty()) == expected {
            return;
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "el túnel no alcanzó el estado esperado de proceso SSH"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1, DOCKINNG_LIVE_REAL_SSH=1 y el alias SSH real"]
async fn ssh_real_audita_path_banner_latencia_y_reconexion_segura() {
    let Some(alias) = gate() else { return };
    let known_hosts = temp_path("audit");
    let tunnels_dir = known_hosts.with_extension("tunnels");
    let spec = spec(alias);
    let target = SshTarget::from_spec(&spec).expect("especificación SSH");

    // Sondeo y TOFU viven exclusivamente en un archivo temporal de DockInng.
    let probe = keyscan::probe(&target, &known_hosts)
        .await
        .expect("sondeo de clave del host real");
    assert_eq!(probe.state, HostKeyState::Unknown);
    assert!(probe.fingerprint_sha256.starts_with("SHA256:"));
    assert!(!known_hosts.exists(), "probe no debe escribir confianza");
    keyscan::trust(&target, &known_hosts, &probe.fingerprint_sha256)
        .await
        .expect("confianza explícita de la huella observada");

    let tunnel = Tunnel::start(&target, &known_hosts, &tunnels_dir, TunnelConfig::default())
        .await
        .expect("túnel SSH real");
    let engine = Arc::new(DockerEngine::new());
    engine.set_target(Target::tunnel(
        &tunnel.socket_path().to_string_lossy(),
        &format!("ssh://{}", target.host),
        Some(tunnel.failure_hint()),
    ));

    // `docker system dial-stdio` evita un shell interactivo: el ping prueba que un banner
    // de login no contamina el protocolo y que el PATH remoto encuentra Docker.
    let started = Instant::now();
    tokio::time::timeout(Duration::from_secs(20), engine.ping())
        .await
        .expect("ping dentro del límite de latencia")
        .expect("ping por SSH real");
    let first_ping = started.elapsed();
    let started = Instant::now();
    let info = tokio::time::timeout(Duration::from_secs(20), engine.info())
        .await
        .expect("info dentro del límite de latencia")
        .expect("info por SSH real");
    let info_latency = started.elapsed();
    assert!(!info.version.is_empty());
    tokio::time::timeout(Duration::from_secs(20), engine.list_containers(true))
        .await
        .expect("listado dentro del límite de latencia")
        .expect("listado de solo lectura por SSH real");

    // El túnel es por conexión HTTP: cerrar un cliente a mitad de camino debe matar solo su
    // `ssh`, y la siguiente operación debe crear otro proceso y recuperarse sin acción remota.
    let client = UnixStream::connect(tunnel.socket_path())
        .await
        .expect("cliente local del túnel");
    wait_for_children(&tunnel, true).await;
    drop(client);
    wait_for_children(&tunnel, false).await;
    let started = Instant::now();
    tokio::time::timeout(Duration::from_secs(20), engine.ping())
        .await
        .expect("reconexión dentro del límite de latencia")
        .expect("reconexión SSH real tras corte del cliente");
    let reconnect_latency = started.elapsed();
    drop(engine);
    wait_for_children(&tunnel, false).await;

    eprintln!(
        "ssh_real alias={} first_ping_ms={} info_ms={} reconnect_ms={} active_children_after_reconnect={}",
        target.host,
        first_ping.as_millis(),
        info_latency.as_millis(),
        reconnect_latency.as_millis(),
        tunnel.active_children().len()
    );

    tunnel.shutdown().await;
    let _ = std::fs::remove_file(&known_hosts);
    let _ = std::fs::remove_dir_all(&tunnels_dir);
}
