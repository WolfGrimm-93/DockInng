//! Terminal real dentro de un contenedor (exec con TTY). Contrato del motor + utilidades puras.
//!
//! No hay comando, usuario ni entorno elegibles desde la UI: el motor abre siempre el mismo
//! shell (`bash` si existe, si no `sh`). El riesgo del contenedor viaja en `ExecInfo`.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::client::EngineStream;
use crate::error::EngineError;

/// Tamaño de terminal permitido (columnas y filas).
pub const MIN_TERM_SIZE: u16 = 1;
pub const MAX_TERM_SIZE: u16 = 500;
/// Máximo de bytes por llamada de escritura.
pub const MAX_WRITE_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecRequest {
    pub container: String,
    pub cols: u16,
    pub rows: u16,
}

/// Rasgos del contenedor que convierten un shell en algo más que "un shell en un contenedor".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecRisk {
    pub privileged: bool,
    pub docker_socket: bool,
    pub host_pid: bool,
    pub host_network: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecInfo {
    pub exec_id: String,
    /// "/bin/bash" o "/bin/sh".
    pub shell: String,
    pub risk: ExecRisk,
}

pub struct ExecSession {
    pub info: ExecInfo,
    /// Bytes crudos de la terminal (no necesariamente UTF-8 completo por fragmento).
    pub output: EngineStream<Vec<u8>>,
    pub control: Box<dyn ExecControl>,
}

#[async_trait]
pub trait ExecEngine: Send + Sync {
    async fn open_exec(&self, req: ExecRequest) -> Result<ExecSession, EngineError>;
}

#[async_trait]
pub trait ExecControl: Send {
    async fn write(&mut self, data: &[u8]) -> Result<(), EngineError>;
    async fn resize(&self, cols: u16, rows: u16) -> Result<(), EngineError>;
    /// Cierra la sesión y MATA el shell (un simple EOF no lo mata: fuga verificada).
    /// Devuelve el código de salida si el proceso ya había terminado.
    async fn close(self: Box<Self>) -> Result<Option<i64>, EngineError>;
    /// Código de salida del proceso si ya terminó.
    async fn exit_code(&self) -> Option<i64>;
}

/// Ajusta columnas/filas al rango permitido.
pub fn clamp_size(cols: u16, rows: u16) -> (u16, u16) {
    (
        cols.clamp(MIN_TERM_SIZE, MAX_TERM_SIZE),
        rows.clamp(MIN_TERM_SIZE, MAX_TERM_SIZE),
    )
}

/// Extrae el PID que ve el propio contenedor de una línea `NSpid:\t250637\t58` de
/// `/proc/<pid>/status` (el último valor es el del namespace más interno).
pub fn parse_nspid(status: &str) -> Option<u32> {
    let line = status.lines().find_map(|l| l.strip_prefix("NSpid:"))?;
    let last = line.split_whitespace().last()?;
    // Solo dígitos: el valor acaba interpolado en un comando.
    if last.is_empty() || !last.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let pid: u32 = last.parse().ok()?;
    (pid > 1).then_some(pid)
}

/// Calcula el riesgo a partir del JSON de `inspect` (`raw` de `ContainerDetail`).
pub fn risk_from_inspect(raw: &serde_json::Value) -> ExecRisk {
    let host = raw
        .get("HostConfig")
        .or_else(|| raw.get("host_config"))
        .cloned()
        .unwrap_or_default();
    let get = |a: &str, b: &str| host.get(a).or_else(|| host.get(b));
    let privileged = get("Privileged", "privileged")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let host_pid = get("PidMode", "pid_mode")
        .and_then(|v| v.as_str())
        .is_some_and(|m| m == "host");
    let host_network = get("NetworkMode", "network_mode")
        .and_then(|v| v.as_str())
        .is_some_and(|m| m == "host");
    let is_sock = |p: &str| p.ends_with("docker.sock") || p.ends_with("podman.sock");
    let mut docker_socket = false;
    if let Some(mounts) = raw
        .get("Mounts")
        .or_else(|| raw.get("mounts"))
        .and_then(|m| m.as_array())
    {
        for m in mounts {
            for key in ["Source", "source", "Destination", "destination"] {
                if m.get(key).and_then(|v| v.as_str()).is_some_and(is_sock) {
                    docker_socket = true;
                }
            }
        }
    }
    if let Some(binds) = get("Binds", "binds").and_then(|b| b.as_array()) {
        docker_socket |= binds.iter().any(|b| {
            b.as_str()
                .is_some_and(|s| s.split(':').take(2).any(is_sock))
        });
    }
    if let Some(mounts) = get("Mounts", "mounts").and_then(|m| m.as_array()) {
        docker_socket |= mounts.iter().any(|m| {
            ["Source", "source", "Target", "target"]
                .iter()
                .any(|k| m.get(*k).and_then(|v| v.as_str()).is_some_and(is_sock))
        });
    }
    ExecRisk {
        privileged,
        docker_socket,
        host_pid,
        host_network,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nspid_toma_el_ultimo_valor() {
        let s = "Name:\tsh\nNSpid:\t250637\t58\nNSsid:\t1\n";
        assert_eq!(parse_nspid(s), Some(58));
    }

    #[test]
    fn nspid_rechaza_basura_y_pid_uno() {
        assert_eq!(parse_nspid("Name:\tsh\n"), None);
        assert_eq!(parse_nspid("NSpid:\t12\t1\n"), None);
        assert_eq!(parse_nspid("NSpid:\t12\t5;rm\n"), None);
        assert_eq!(parse_nspid("NSpid:\n"), None);
        assert_eq!(parse_nspid("NSpid:\t-3\n"), None);
    }

    #[test]
    fn tamano_se_ajusta_al_rango() {
        assert_eq!(clamp_size(0, 65535), (1, 500));
        assert_eq!(clamp_size(80, 24), (80, 24));
        assert_eq!(clamp_size(501, 500), (500, 500));
    }

    #[test]
    fn riesgo_desde_inspect() {
        let raw = serde_json::json!({
            "HostConfig": {"Privileged": true, "PidMode": "host", "NetworkMode": "host"},
            "Mounts": [{"Source": "/var/run/docker.sock", "Destination": "/var/run/docker.sock"}]
        });
        assert_eq!(
            risk_from_inspect(&raw),
            ExecRisk {
                privileged: true,
                docker_socket: true,
                host_pid: true,
                host_network: true
            }
        );
        let calm = serde_json::json!({"HostConfig": {"NetworkMode": "bridge", "PidMode": ""}});
        assert_eq!(risk_from_inspect(&calm), ExecRisk::default());
        assert_eq!(
            risk_from_inspect(&serde_json::Value::Null),
            ExecRisk::default()
        );
    }

    #[test]
    fn riesgo_con_claves_snake_case_del_modelo_de_bollard() {
        // `ContainerDetail.raw` viene del modelo tipado de bollard (snake_case).
        let raw = serde_json::json!({
            "host_config": {"privileged": false, "binds": ["/var/run/docker.sock:/var/run/docker.sock:ro"]},
        });
        assert!(risk_from_inspect(&raw).docker_socket);
        let raw = serde_json::json!({
            "host_config": {"mounts": [{"type": "bind", "source": "/run/docker.sock", "target": "/x"}]},
        });
        assert!(risk_from_inspect(&raw).docker_socket);
    }
}
