//! Diagnóstico de conexión paso a paso (equivale a `dockinng doctor`).

use std::time::Duration;

use tokio::net::UnixStream;

use engine_core::{ConnectionCause, DiagStep, DiagStepId, EngineError, StepStatus};

use crate::error_map::cause_from_io;

/// Pasos "socket" y "permisos" sobre un socket Unix. Devuelve los pasos y si alguno falló.
/// Tope de la prueba de conexión: un socket colgado no debe bloquear el diagnóstico.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

pub async fn check_unix_socket(path: &str) -> (Vec<DiagStep>, Option<ConnectionCause>) {
    let mut steps = Vec::new();

    let socket = match std::fs::metadata(path) {
        Ok(_) => DiagStep {
            id: DiagStepId::Socket,
            status: StepStatus::Ok,
            detail: format!("existe {path}"),
        },
        Err(e) => DiagStep {
            id: DiagStepId::Socket,
            status: StepStatus::Fail,
            detail: format!("{path}: {e}"),
        },
    };
    let socket_failed = socket.status == StepStatus::Fail;
    steps.push(socket);
    if socket_failed {
        steps.push(DiagStep {
            id: DiagStepId::Permissions,
            status: StepStatus::Skipped,
            detail: String::new(),
        });
        return (steps, Some(ConnectionCause::SocketMissing));
    }

    // Conectar al socket basta para distinguir EACCES (sin permisos) de ECONNREFUSED (sin daemon).
    let connect = tokio::time::timeout(CONNECT_TIMEOUT, UnixStream::connect(path)).await;
    let (perm, cause) = match connect {
        Err(_elapsed) => (
            DiagStep {
                id: DiagStepId::Permissions,
                status: StepStatus::Skipped,
                detail: "el socket no aceptó la conexión a tiempo".into(),
            },
            None,
        ),
        Ok(Ok(_)) => (
            DiagStep {
                id: DiagStepId::Permissions,
                status: StepStatus::Ok,
                detail: "se puede abrir el socket".into(),
            },
            None,
        ),
        Ok(Err(e)) => match cause_from_io(&e) {
            ConnectionCause::PermissionDenied => (
                DiagStep {
                    id: DiagStepId::Permissions,
                    status: StepStatus::Fail,
                    detail: e.to_string(),
                },
                Some(ConnectionCause::PermissionDenied),
            ),
            // El socket es accesible aunque nadie escuche: el fallo es del daemon.
            ConnectionCause::DaemonDown => (
                DiagStep {
                    id: DiagStepId::Permissions,
                    status: StepStatus::Ok,
                    detail: "hay permiso para abrir el socket".into(),
                },
                None,
            ),
            _ => (
                DiagStep {
                    id: DiagStepId::Permissions,
                    status: StepStatus::Skipped,
                    detail: e.to_string(),
                },
                None,
            ),
        },
    };
    steps.push(perm);
    (steps, cause)
}

/// Pasos "socket" y "permisos" de un túnel SSH: el socket es local y privado; lo que importa
/// (host, autenticación, docker remoto) se diagnostica en el paso "daemon".
pub fn check_tunnel(socket: &str, label: &str) -> (Vec<DiagStep>, Option<ConnectionCause>) {
    let exists = std::fs::metadata(socket).is_ok();
    let steps = vec![
        DiagStep {
            id: DiagStepId::Socket,
            status: if exists {
                StepStatus::Ok
            } else {
                StepStatus::Fail
            },
            detail: if exists {
                format!("túnel activo hacia {label}")
            } else {
                format!("el túnel hacia {label} ya no existe")
            },
        },
        DiagStep {
            id: DiagStepId::Permissions,
            status: StepStatus::Skipped,
            detail: String::new(),
        },
    ];
    (steps, (!exists).then_some(ConnectionCause::Unreachable))
}

/// Paso "daemon" a partir del resultado de `ping`.
pub fn daemon_step(result: &Result<(), EngineError>, skipped: bool) -> DiagStep {
    if skipped {
        return DiagStep {
            id: DiagStepId::Daemon,
            status: StepStatus::Skipped,
            detail: String::new(),
        };
    }
    match result {
        Ok(()) => DiagStep {
            id: DiagStepId::Daemon,
            status: StepStatus::Ok,
            detail: "el daemon responde".into(),
        },
        Err(e) => DiagStep {
            id: DiagStepId::Daemon,
            status: StepStatus::Fail,
            detail: e.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixListener;
    use std::time::Instant;

    use super::*;

    fn temp_socket() -> std::path::PathBuf {
        // `UnixListener::bind` has a small platform limit for socket paths.  Keep this
        // fixture independent of a possibly long `TMPDIR`/`XDG_RUNTIME_DIR`.
        let base = std::path::PathBuf::from("/tmp");
        let dir = base.join(format!("dkt-{}", uuid::Uuid::now_v7().simple()));
        std::fs::create_dir_all(&dir).expect("dir");
        dir.join("s.sock")
    }

    /// Un socket con la cola de conexiones llena (nadie hace `accept`) no debe colgar el
    /// diagnóstico ni bloquear el hilo del runtime: termina dentro del tope.
    #[tokio::test(flavor = "current_thread")]
    async fn socket_sin_backlog_no_cuelga_el_diagnostico() {
        let path = temp_socket();
        let _listener = UnixListener::bind(&path).expect("bind");
        // Llena el backlog con clientes que nunca se aceptan.
        let mut held = Vec::new();
        for _ in 0..400 {
            match tokio::time::timeout(Duration::from_millis(50), UnixStream::connect(&path)).await
            {
                Ok(Ok(c)) => held.push(c),
                _ => break,
            }
        }
        let t0 = Instant::now();
        let (steps, cause) = check_unix_socket(path.to_str().expect("utf8")).await;
        assert!(t0.elapsed() < CONNECT_TIMEOUT + Duration::from_secs(1));
        assert_eq!(steps.len(), 2);
        // Ni "permiso denegado" ni fallo del socket: como mucho un paso omitido.
        assert!(cause.is_none());
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
