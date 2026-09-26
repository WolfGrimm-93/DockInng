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
    /// SSH: el servidor no está en el `known_hosts` propio (primer contacto sin confiar).
    HostKeyUnknown,
    /// SSH: la clave del servidor cambió respecto a la de confianza.
    HostKeyChanged,
    /// SSH: el servidor rechazó la autenticación (llave, agente o usuario).
    AuthFailed,
    /// El host no responde (rechazo, tiempo agotado, DNS).
    Unreachable,
    /// SSH: el servidor no tiene `docker` en el PATH no interactivo.
    RemoteDockerMissing,
    /// TLS: certificados inválidos, CA equivocada o sin certificado de cliente.
    TlsInvalid,
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
