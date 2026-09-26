//! Núcleo de dominio de DockInng: modelos, contrato del motor, política de confirmación
//! y flujo de acciones. No depende de ningún cliente Docker concreto ni de la interfaz.

pub mod actions;
pub mod api;
pub mod broker;
pub mod client;
pub mod connection;
pub mod create;
pub mod error;
pub mod events;
pub mod exec;
pub mod logs;
pub mod model;
pub mod policy;
pub mod pull;
pub mod resources;
pub mod stacks;
pub mod stats;
pub mod system;
pub mod validate;

#[cfg(any(test, feature = "testing"))]
pub mod testing;
#[cfg(any(test, feature = "testing"))]
pub mod testing_create;
#[cfg(any(test, feature = "testing"))]
pub mod testing_exec;
#[cfg(any(test, feature = "testing"))]
pub mod testing_pull;
#[cfg(any(test, feature = "testing"))]
pub mod testing_stacks;

pub use actions::{
    ActionError, ActionOutcome, ActionPlan, ActionRequest, ActionService, AffectedItem, FailedItem,
    ItemKind, ItemRef, PlanDecision, PlanDenyReason, PlanWarning,
};
pub use api::{ApiError, ApiErrorCode};
pub use client::{EngineClient, EngineStream};
pub use connection::{ConnectionCause, ConnectionStatus, DiagStep, DiagStepId, StepStatus};
pub use create::{
    CreateContainerSpec, CreateEngine, CreateNetworkSpec, CreatePlan, CreateResult, CreateService,
    CreateVolumeSpec, CreateWarning, FieldError,
};
pub use error::EngineError;
pub use events::{EngineEvent, EngineEventKind};
pub use exec::{ExecControl, ExecEngine, ExecInfo, ExecRequest, ExecRisk, ExecSession};
pub use logs::{DEFAULT_LOG_TAIL, LogLine, LogStream, LogsRequest, MAX_LOG_TAIL};
pub use model::{
    Container, ContainerDetail, ContainerState, EngineInfo, MountInfo, MountKind, NetworkEndpoint,
    PortMapping,
};
pub use policy::{
    Action, CONFIRM_WORD, ConfirmationPolicy, Decision, DenyReason, Interactivity, decide,
    decide_batch,
};
pub use pull::{LayerPhase, LayerProgress, PullEngine, PullEvent, PullSnapshot, PullTracker};
pub use resources::{Image, Network, Volume};
pub use stacks::{
    CancelSignal, ComposeContainer, ComposeFlavor, ComposeInfo, IssueKind, ProgressItem,
    ProgressKind, ProgressStatus, ServicePhase, ServiceProgress, StackControl, StackDiscovery,
    StackFiles, StackOp, StackOpFeed, StackOpRun, StackOrigin, StackOutcome, StackRisk,
    StackService, StackSink, StackStatus, StackSummary, StackValidation, ValidationIssue,
};
pub use stats::ContainerStats;
pub use system::{ContainerDisk, DiskCategory, DiskUsage, GpuInfo, HostResources, SystemUsage};
