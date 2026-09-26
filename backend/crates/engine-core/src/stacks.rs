//! Stacks de Compose: modelos serializables (contrato con la UI) y traits de extensión.
//! Los cuerpos reales viven en `engine-docker` (descubrimiento por labels) y en el crate
//! `compose` (ejecución por subproceso). Contrato congelado en el PASO 0; cambios
//! posteriores solo por el dueño del bloque de stacks.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::EngineError;
use crate::model::ContainerState;

/// Cómo se conoce un stack.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StackOrigin {
    /// Archivos propios de DockInng (`~/.local/share/dockinng/stacks/<nombre>`).
    Managed,
    /// Archivo compose externo vinculado por el usuario.
    Linked,
    /// Solo descubierto por las labels de sus contenedores.
    Discovered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StackStatus {
    Running,
    Partial,
    Stopped,
    /// Definido, sin contenedores.
    Declared,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StackService {
    pub name: String,
    pub image: String,
    pub state: ContainerState,
    /// "run/total".
    pub replicas: String,
    pub running: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StackSummary {
    pub name: String,
    pub origin: StackOrigin,
    /// Primer archivo de configuración; "" si se desconoce.
    pub path: String,
    pub config_files: Vec<String>,
    pub working_dir: Option<String>,
    pub editable: bool,
    pub status: StackStatus,
    pub containers: u32,
    pub running: u32,
    pub services: Vec<StackService>,
}

/// Contenedor con labels de Compose (resultado del descubrimiento por bollard).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComposeContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: ContainerState,
    pub status: String,
    pub project: String,
    pub service: String,
    pub working_dir: Option<String>,
    pub config_files: Vec<String>,
    pub environment_file: Option<String>,
    pub oneoff: bool,
    pub number: Option<u32>,
    pub health: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComposeFlavor {
    Plugin,
    Standalone,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComposeInfo {
    pub available: bool,
    pub flavor: ComposeFlavor,
    pub version: Option<String>,
    pub supported: bool,
    pub docker_cli: bool,
}

/// Archivos de un stack propio o vinculado.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StackFiles {
    pub name: String,
    pub origin: StackOrigin,
    pub yaml: String,
    pub env: String,
    pub path: String,
    pub env_path: String,
    pub editable: bool,
    pub config_files: Vec<String>,
    /// `mtime_ns:len` de ambos archivos; detecta ediciones concurrentes.
    pub revision: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueKind {
    Syntax,
    Schema,
    Interpolation,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationIssue {
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub kind: IssueKind,
    pub message: String,
}

/// Riesgos informativos de un stack (banner en la UI).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StackRisk {
    Privileged,
    HostNetwork,
    DockerSock,
    SensitiveBind {
        path: String,
    },
    PidHost,
    CapAddSysAdmin,
    /// El daemon es remoto: este bind mount se resolverá en el sistema de archivos REMOTO
    /// (las rutas relativas del compose ya se expandieron a rutas locales que allí no existen).
    RemoteBind {
        path: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StackValidation {
    pub ok: bool,
    pub issues: Vec<ValidationIssue>,
    pub services: Vec<String>,
    pub risks: Vec<StackRisk>,
}

/// Operación de ciclo de vida. `down` y el borrado NO están aquí: van por plan -> ticket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StackOp {
    Up { services: Option<Vec<String>> },
    Restart { services: Option<Vec<String>> },
    Stop { services: Option<Vec<String>> },
    Start { services: Option<Vec<String>> },
    Pull { services: Option<Vec<String>> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgressKind {
    Network,
    Container,
    Volume,
    Image,
    Service,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgressStatus {
    Working,
    Done,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProgressItem {
    pub id: String,
    pub kind: ProgressKind,
    pub name: String,
    pub status: ProgressStatus,
    pub text: String,
    pub details: Option<String>,
    pub current: Option<u64>,
    pub total: Option<u64>,
    pub percent: Option<f64>,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServicePhase {
    Waiting,
    Pulling,
    Creating,
    Started,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceProgress {
    pub name: String,
    /// 0..=100.
    pub percent: u8,
    pub phase: ServicePhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StackOutcome {
    Success,
    Failed,
    Canceled,
    Timeout,
}

/// Mensajes del canal de una operación de stack.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StackOpFeed {
    Started {
        op: String,
        stack: String,
        compose_version: String,
    },
    Progress {
        items: Vec<ProgressItem>,
        services: Vec<ServiceProgress>,
    },
    Log {
        text: String,
    },
    Ended {
        outcome: StackOutcome,
        exit_code: Option<i32>,
        error: Option<crate::api::ApiError>,
        issues: Vec<ValidationIssue>,
    },
}

/// Descubrimiento de contenedores de Compose por labels (sin subprocesos).
#[async_trait]
pub trait StackDiscovery: Send + Sync {
    async fn list_compose_containers(&self) -> Result<Vec<ComposeContainer>, EngineError>;
}

/// Receptor de los eventos de una operación de stack (el comando Tauri lo implementa con un `Channel`).
pub type StackSink = Arc<dyn Fn(StackOpFeed) + Send + Sync>;
/// Se completa cuando se pide cancelar la operación.
pub type CancelSignal = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Operación de stack ya validada y con el proyecto reservado; `run` la ejecuta emitiendo
/// `Started` ... `Ended` (siempre emite `Ended`).
#[async_trait]
pub trait StackOpRun: Send {
    async fn run(self: Box<Self>, sink: StackSink, cancel: CancelSignal);
}

/// Control de stacks: flujo plan -> ticket (bajar y borrar) y, además, el editor y las
/// operaciones de ciclo de vida. Los métodos con cuerpo por defecto devuelven `not_implemented`
/// para que los mocks de otros bloques no tengan que implementarlos.
#[async_trait]
pub trait StackControl: Send + Sync {
    /// `docker compose down -t 10` (nunca `-v`, `--rmi` ni `--remove-orphans`).
    async fn down(&self, project: &str) -> Result<(), EngineError>;
    /// Borra los archivos de un stack managed (irreversible).
    async fn delete_files(&self, name: &str) -> Result<(), EngineError>;
    /// Origen de un stack con archivos propios/vinculados; `None` si no existe.
    async fn origin_of(&self, name: &str) -> Result<Option<StackOrigin>, EngineError>;

    /// Detección de Compose (`recheck` ignora la caché).
    async fn compose_info(&self, _recheck: bool) -> ComposeInfo {
        ComposeInfo {
            available: false,
            flavor: ComposeFlavor::Missing,
            version: None,
            supported: false,
            docker_cli: false,
        }
    }
    /// Une los stacks propios/vinculados con los contenedores descubiertos por labels.
    async fn list_stacks(
        &self,
        _containers: Vec<ComposeContainer>,
    ) -> Result<Vec<StackSummary>, EngineError> {
        Err(EngineError::not_implemented("la lista de stacks"))
    }
    /// Archivos de un stack (los `discovered` solo en lectura y sin `.env`).
    async fn stack_read(
        &self,
        _name: &str,
        _containers: Vec<ComposeContainer>,
    ) -> Result<StackFiles, EngineError> {
        Err(EngineError::not_implemented("leer un stack"))
    }
    async fn stack_save(
        &self,
        _name: &str,
        _yaml: &str,
        _env: &str,
        _expected_revision: Option<&str>,
    ) -> Result<StackFiles, EngineError> {
        Err(EngineError::not_implemented("guardar un stack"))
    }
    async fn stack_validate(
        &self,
        _name: Option<&str>,
        _yaml: &str,
        _env: &str,
    ) -> Result<StackValidation, EngineError> {
        Err(EngineError::not_implemented("validar un stack"))
    }
    async fn stack_create(
        &self,
        _name: &str,
        _yaml: &str,
        _env: &str,
    ) -> Result<StackFiles, EngineError> {
        Err(EngineError::not_implemented("crear un stack"))
    }
    /// Vincula un compose externo; devuelve el nombre del stack. `containers` permite rechazar
    /// un `name:` que coincide con un proyecto existente de otros archivos.
    async fn stack_link(
        &self,
        _path: &str,
        _containers: Vec<ComposeContainer>,
    ) -> Result<String, EngineError> {
        Err(EngineError::not_implemented("vincular un stack"))
    }
    async fn stack_unlink(&self, _name: &str) -> Result<(), EngineError> {
        Err(EngineError::not_implemented("desvincular un stack"))
    }
    /// Valida y reserva una operación de ciclo de vida (`Conflict` si Compose falta o el stack
    /// está ocupado). El resultado se ejecuta con `StackOpRun::run`.
    async fn prepare_op(
        &self,
        _name: &str,
        _op: StackOp,
    ) -> Result<Box<dyn StackOpRun>, EngineError> {
        Err(EngineError::not_implemented("las operaciones de stack"))
    }
}
