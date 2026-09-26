//! Ejecución acotada de herramientas OpenSSH (`ssh`, `ssh-keyscan`, `ssh-keygen`).

use std::ffi::OsString;
use std::process::Stdio;
use std::time::Duration;

use engine_core::EngineError;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::env::process_clean_env;

/// Tope de bytes leídos de cada salida.
pub const MAX_OUTPUT: usize = 64 * 1024;

/// Resultado de un comando acotado.
#[derive(Debug, Clone)]
pub struct Output {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Lee como mucho `MAX_OUTPUT` bytes y descarta el resto (evita un consumo ilimitado).
async fn read_capped<R: tokio::io::AsyncRead + Unpin>(mut r: R) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match r.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if buf.len() < MAX_OUTPUT {
                    let take = n.min(MAX_OUTPUT - buf.len());
                    buf.extend_from_slice(&chunk[..take]);
                }
            }
        }
    }
    buf
}

/// Lanza `bin` con entorno limpio y tiempo máximo; `kill_on_drop` evita procesos huérfanos.
pub async fn run_capture(
    bin: &str,
    args: &[OsString],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<Output, EngineError> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .env_clear()
        .envs(process_clean_env())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            EngineError::InvalidInput(format!("no se encontró `{bin}` en el PATH"))
        } else {
            EngineError::Internal(format!("no se pudo lanzar {bin}: {e}"))
        }
    })?;
    if let (Some(data), Some(mut w)) = (stdin, child.stdin.take()) {
        // El hijo puede cerrar stdin antes de leerlo todo: no es un error.
        let _ = w.write_all(data).await;
    }
    let out = child.stdout.take().map(read_capped);
    let err = child.stderr.take().map(read_capped);
    let work = async {
        let (o, e) = tokio::join!(
            async {
                match out {
                    Some(f) => f.await,
                    None => Vec::new(),
                }
            },
            async {
                match err {
                    Some(f) => f.await,
                    None => Vec::new(),
                }
            }
        );
        let status = child.wait().await;
        (o, e, status)
    };
    match tokio::time::timeout(timeout, work).await {
        Ok((o, e, status)) => Ok(Output {
            success: status.map(|s| s.success()).unwrap_or(false),
            stdout: String::from_utf8_lossy(&o).into_owned(),
            stderr: String::from_utf8_lossy(&e).into_owned(),
        }),
        // Al soltar `child` (kill_on_drop) el proceso muere.
        Err(_) => Err(EngineError::Timeout),
    }
}
