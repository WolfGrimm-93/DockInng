use serde::{Deserialize, Serialize};

use crate::model::EngineInfo;

/// Causa clasificada de un fallo de conexión (por errno real, no por texto).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionCause {
    SocketMissing,
    PermissionDenied,
    DaemonDown,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Ok,
    Fail,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagStepId {
    Socket,
    Permissions,
    Daemon,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagStep {
    pub id: DiagStepId,
    pub status: StepStatus,
    pub detail: String,
}

/// Estado de la conexión con el motor. Equivale a `dockinng doctor`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ConnectionStatus {
    Connected {
        endpoint: String,
        server: EngineInfo,
    },
    Failed {
        endpoint: String,
        cause: ConnectionCause,
        message: String,
        steps: Vec<DiagStep>,
    },
}
