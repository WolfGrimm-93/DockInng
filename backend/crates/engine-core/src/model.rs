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
            "exited" => Self::Exited,
            "dead" => Self::Dead,
            _ => Self::Unknown,
        }
    }
}

/// Vista resumida de un contenedor (equivale a una fila de `docker ps`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Container {
    pub id: String,
    pub names: Vec<String>,
    pub image: String,
    pub state: ContainerState,
    /// Texto legible del daemon, ej. "Up 3 hours".
    pub status: String,
    /// Proyecto de Compose al que pertenece (label `com.docker.compose.project`).
    pub compose_project: Option<String>,
}

/// Información básica del motor conectado.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineInfo {
    pub version: String,
    pub api_version: String,
    pub os: String,
    pub arch: String,
}
