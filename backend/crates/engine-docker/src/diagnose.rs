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
    let probe = match connect {
        Err(_elapsed) => ConnectProbe::TimedOut,
        Ok(Ok(_)) => ConnectProbe::Connected,
        Ok(Err(e)) => ConnectProbe::Failed {
            cause: cause_from_io(&e),
            detail: e.to_string(),
        },
    };
    let (perm, cause) = permissions_outcome(probe);
    steps.push(perm);
    (steps, cause)
}

/// Resultado de intentar abrir el socket. Separado de la E/S para probar la decisión.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectProbe {
    TimedOut,
    Connected,
    Failed {
        cause: ConnectionCause,
        detail: String,
    },
}

/// Paso "permisos" y causa de fallo a partir de la prueba de conexión.
pub fn permissions_outcome(probe: ConnectProbe) -> (DiagStep, Option<ConnectionCause>) {
    let step = |status, detail: &str| DiagStep {
        id: DiagStepId::Permissions,
        status,
        detail: detail.into(),
    };
    match probe {
        ConnectProbe::TimedOut => (
            step(
                StepStatus::Skipped,
                "el socket no aceptó la conexión a tiempo",
            ),
            None,
        ),
        ConnectProbe::Connected => (step(StepStatus::Ok, "se puede abrir el socket"), None),
        ConnectProbe::Failed {
            cause: ConnectionCause::PermissionDenied,
            detail,
        } => (
            step(StepStatus::Fail, &detail),
            Some(ConnectionCause::PermissionDenied),
        ),
        // El socket es accesible aunque nadie escuche: el fallo es del daemon.
        ConnectProbe::Failed {
            cause: ConnectionCause::DaemonDown,
            ..
        } => (
            step(StepStatus::Ok, "hay permiso para abrir el socket"),
            None,
        ),
        ConnectProbe::Failed { detail, .. } => (step(StepStatus::Skipped, &detail), None),
    }
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

    fn fallo(cause: ConnectionCause) -> ConnectProbe {
        ConnectProbe::Failed {
            cause,
            detail: "detalle".into(),
        }
    }

    #[test]
    fn permiso_denegado_es_fallo_con_causa() {
        let (paso, causa) = permissions_outcome(fallo(ConnectionCause::PermissionDenied));
        assert_eq!(paso.status, StepStatus::Fail);
        assert_eq!(paso.detail, "detalle");
        assert_eq!(causa, Some(ConnectionCause::PermissionDenied));
    }

    #[test]
    fn daemon_caido_con_socket_accesible_es_ok_sin_causa_de_socket() {
        let (paso, causa) = permissions_outcome(fallo(ConnectionCause::DaemonDown));
        assert_eq!(paso.status, StepStatus::Ok);
        assert_eq!(causa, None);
    }

    #[test]
    fn otros_fallos_y_timeout_se_omiten_sin_causa() {
        let (paso, causa) = permissions_outcome(fallo(ConnectionCause::Other));
        assert_eq!((paso.status, causa), (StepStatus::Skipped, None));
        let (paso, causa) = permissions_outcome(ConnectProbe::TimedOut);
        assert_eq!(paso.status, StepStatus::Skipped);
        assert_eq!(causa, None);
    }

    #[test]
    fn conexion_correcta_es_ok() {
        let (paso, causa) = permissions_outcome(ConnectProbe::Connected);
        assert_eq!((paso.status, causa), (StepStatus::Ok, None));
    }

    #[test]
    fn error_de_io_se_clasifica_antes_de_decidir() {
        let e = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let (_, causa) = permissions_outcome(ConnectProbe::Failed {
            cause: cause_from_io(&e),
            detail: e.to_string(),
        });
        assert_eq!(causa, Some(ConnectionCause::PermissionDenied));
    }
}
