//! Núcleo de dominio de DockInng: modelos, contrato del motor, política de confirmación
//! y flujo de acciones. No depende de ningún cliente Docker concreto ni de la interfaz.

pub mod actions;
pub mod api;
pub mod broker;
pub mod client;
pub mod connection;
pub mod error;
pub mod events;
pub mod logs;
pub mod model;
pub mod policy;
pub mod resources;
pub mod stats;
pub mod system;
pub mod validate;

#[cfg(any(test, feature = "testing"))]
pub mod testing;

pub use actions::{
    ActionError, ActionOutcome, ActionPlan, ActionRequest, ActionService, AffectedItem, FailedItem,
    ItemKind, ItemRef, PlanDecision, PlanDenyReason, PlanWarning,
};
pub use api::{ApiError, ApiErrorCode};
pub use client::{EngineClient, EngineStream};
pub use connection::{ConnectionCause, ConnectionStatus, DiagStep, DiagStepId, StepStatus};
pub use error::EngineError;
pub use events::{EngineEvent, EngineEventKind};
pub use logs::{DEFAULT_LOG_TAIL, LogLine, LogStream, LogsRequest, MAX_LOG_TAIL};
pub use model::{
    Container, ContainerDetail, ContainerState, EngineInfo, MountInfo, MountKind, NetworkEndpoint,
    PortMapping,
};
pub use policy::{
    Action, CONFIRM_WORD, ConfirmationPolicy, Decision, DenyReason, Interactivity, decide,
    decide_batch,
};
pub use resources::{Image, Network, Volume};
pub use stats::ContainerStats;
pub use system::{ContainerDisk, DiskCategory, DiskUsage, GpuInfo, HostResources, SystemUsage};
