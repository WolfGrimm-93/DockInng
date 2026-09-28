//! Diagnóstico de conexión con sockets Unix temporales: no necesita Docker.

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use engine_core::{
    ConnectionCause, ConnectionStatus, DiagStepId, EngineClient, EngineError, StepStatus,
};
use engine_docker::DockerEngine;

fn temp_socket(tag: &str) -> PathBuf {
    // `UnixListener::bind` has a small platform limit for socket paths.  Keep this
    // fixture independent of a possibly long `TMPDIR`/`XDG_RUNTIME_DIR`.
    let base = PathBuf::from("/tmp");
    let dir = base.join(format!("dkl-{}", uuid::Uuid::now_v7().simple()));
    std::fs::create_dir_all(&dir).expect("dir temporal");
    dir.join(format!("{tag}.sock"))
}

fn cleanup(p: &Path) {
    if let Some(dir) = p.parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

fn step(status: &ConnectionStatus, id: DiagStepId) -> StepStatus {
    match status {
        ConnectionStatus::Failed { steps, .. } => steps
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.status)
            .expect("paso"),
        ConnectionStatus::Connected { .. } => StepStatus::Ok,
    }
}

#[tokio::test]
async fn ruta_inexistente_es_socket_missing() {
    let path = temp_socket("nada");
    let e = DockerEngine::with_socket(path.to_str().expect("utf8"));
    match e.diagnose().await {
        s @ ConnectionStatus::Failed { .. } => {
            let ConnectionStatus::Failed {
                cause, ref steps, ..
            } = s
            else {
                unreachable!()
            };
            assert_eq!(cause, ConnectionCause::SocketMissing);
            assert_eq!(steps.len(), 3);
            assert_eq!(step(&s, DiagStepId::Socket), StepStatus::Fail);
            assert_eq!(step(&s, DiagStepId::Permissions), StepStatus::Skipped);
            assert_eq!(step(&s, DiagStepId::Daemon), StepStatus::Skipped);
        }
        other => panic!("esperaba Failed: {other:?}"),
    }
    // Un motor sin socket NO falla al construirse ni entra en panic; solo devuelve error.
    assert!(matches!(
        e.ping().await,
        Err(EngineError::Connection {
            cause: ConnectionCause::SocketMissing,
            ..
        })
    ));
    cleanup(&path);
}

#[tokio::test]
async fn listener_soltado_es_daemon_down() {
    let path = temp_socket("caido");
    drop(UnixListener::bind(&path).expect("bind"));
    let e = DockerEngine::with_socket(path.to_str().expect("utf8"));
    let s = e.diagnose().await;
    let ConnectionStatus::Failed { cause, .. } = &s else {
        panic!("esperaba Failed: {s:?}")
    };
    assert_eq!(*cause, ConnectionCause::DaemonDown);
    assert_eq!(step(&s, DiagStepId::Socket), StepStatus::Ok);
    assert_eq!(step(&s, DiagStepId::Permissions), StepStatus::Ok);
    assert_eq!(step(&s, DiagStepId::Daemon), StepStatus::Fail);
    assert!(matches!(
        e.list_containers(true).await,
        Err(EngineError::Connection {
            cause: ConnectionCause::DaemonDown,
            ..
        })
    ));
    cleanup(&path);
}

#[tokio::test]
async fn socket_sin_permisos_es_permission_denied() {
    let path = temp_socket("cerrado");
    let listener = UnixListener::bind(&path).expect("bind");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).expect("chmod");
    // Como root (o con capacidades) el chmod no impide conectar: se omite.
    if UnixStream::connect(&path).is_ok() {
        eprintln!("SKIP: el proceso ignora permisos de archivo (root)");
        cleanup(&path);
        return;
    }
    let e = DockerEngine::with_socket(path.to_str().expect("utf8"));
    let s = e.diagnose().await;
    let ConnectionStatus::Failed { cause, .. } = &s else {
        panic!("esperaba Failed: {s:?}")
    };
    assert_eq!(*cause, ConnectionCause::PermissionDenied);
    assert_eq!(step(&s, DiagStepId::Permissions), StepStatus::Fail);
    assert!(matches!(
        e.ping().await,
        Err(EngineError::Connection {
            cause: ConnectionCause::PermissionDenied,
            ..
        })
    ));
    drop(listener);
    cleanup(&path);
}

/// Servidor HTTP mínimo que imita `/_ping` y `/version`.
fn fake_daemon(path: &PathBuf, stop: Arc<AtomicBool>) -> std::thread::JoinHandle<()> {
    let listener = UnixListener::bind(path).expect("bind");
    listener.set_nonblocking(true).expect("nonblocking");
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut c, _)) => {
                    c.set_nonblocking(false).ok();
                    c.set_read_timeout(Some(Duration::from_secs(2))).ok();
                    let mut buf = [0u8; 4096];
                    let n = c.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let (ctype, body) = if req.contains("/version") {
                        (
                            "application/json",
                            r#"{"Version":"99.0.0","ApiVersion":"1.53","Os":"linux","Arch":"amd64"}"#,
                        )
                    } else {
                        ("text/plain", "OK")
                    };
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nApi-Version: 1.53\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = c.write_all(resp.as_bytes());
                }
                Err(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
    })
}

#[tokio::test]
async fn daemon_que_responde_es_connected_y_reconnect_lo_recupera() {
    let path = temp_socket("vivo");
    let e = DockerEngine::with_socket(path.to_str().expect("utf8"));
    // Primero sin socket: falla, sin panic.
    assert!(matches!(
        e.diagnose().await,
        ConnectionStatus::Failed { .. }
    ));
    // El daemon "aparece" después: el mismo motor se recupera.
    let stop = Arc::new(AtomicBool::new(false));
    let h = fake_daemon(&path, stop.clone());
    match e.reconnect().await {
        ConnectionStatus::Connected { endpoint, server } => {
            assert!(endpoint.starts_with("unix://"));
            assert_eq!(server.version, "99.0.0");
            assert_eq!(server.api_version, "1.53");
        }
        other => panic!("esperaba Connected: {other:?}"),
    }
    stop.store(true, Ordering::Relaxed);
    h.join().expect("hilo");
    cleanup(&path);
}
