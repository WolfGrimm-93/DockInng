use serde::{Deserialize, Serialize};

/// Estado de un contenedor, según la Engine API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContainerState {
    Created,
    Running,
    Paused,
    Restarting,
    Removing,
    Stopping,
    Exited,
    Dead,
    Unknown,
}

impl ContainerState {
    /// Convierte el texto que devuelve el daemon (`running`, `exited`, ...).
    pub fn from_engine(value: &str) -> Self {
        match value {
            "created" => Self::Created,
            "running" => Self::Running,
            "paused" => Self::Paused,
            "restarting" => Self::Restarting,
            "removing" => Self::Removing,
            "stopping" => Self::Stopping,
            "exited" => Self::Exited,
            "dead" => Self::Dead,
            _ => Self::Unknown,
        }
    }

    /// Estados en los que borrar sin `force` fallaría en el daemon.
    pub fn is_live(self) -> bool {
        matches!(
            self,
            Self::Running | Self::Paused | Self::Restarting | Self::Stopping
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortMapping {
    pub ip: Option<String>,
    pub private_port: u16,
    pub public_port: Option<u16>,
    /// tcp | udp | sctp
    pub protocol: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MountKind {
    Volume,
    Bind,
    Tmpfs,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MountInfo {
    pub kind: MountKind,
    pub name: Option<String>,
    pub source: String,
    pub destination: String,
    pub read_write: bool,
}

/// Vista resumida de un contenedor (equivale a una fila de `docker ps`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Container {
    /// Id completo (64 hex).
    pub id: String,
    /// Sin "/" inicial.
    pub names: Vec<String>,
    pub image: String,
    /// `sha256:...`, para contar imágenes en uso.
    pub image_id: String,
    pub state: ContainerState,
    /// Texto legible del daemon, ej. "Up 3 hours".
    pub status: String,
    /// Epoch en segundos.
    pub created: i64,
    pub compose_project: Option<String>,
    pub compose_service: Option<String>,
    pub ports: Vec<PortMapping>,
    pub mounts: Vec<MountInfo>,
    pub networks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NetworkEndpoint {
    pub name: String,
    pub ip_address: Option<String>,
    pub gateway: Option<String>,
}

/// Detalle de un contenedor (pantalla de detalle + pestaña "Inspeccionar").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContainerDetail {
    pub summary: Container,
    /// RFC3339.
    pub created_at: String,
    pub ip_address: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub exit_code: Option<i64>,
    pub pid: Option<i64>,
    pub oom_killed: bool,
    pub restart_count: i64,
    pub error: Option<String>,
    pub tty: bool,
    pub restart_policy: Option<String>,
    pub memory_limit_bytes: Option<u64>,
    pub cpu_limit: Option<f64>,
    pub networks: Vec<NetworkEndpoint>,
    /// JSON del modelo tipado de bollard; puede diferir de `docker inspect`.
    pub raw: serde_json::Value,
}

/// Información básica del motor conectado.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineInfo {
    pub version: String,
    pub api_version: String,
    pub os: String,
    pub arch: String,
}
