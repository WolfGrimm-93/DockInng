//! Tipos de stacks: se reutilizan los del núcleo (`engine_core::stacks`, contrato con la UI);
//! aquí solo el tipo auxiliar de operación.

pub use engine_core::{
    ComposeContainer, ComposeFlavor, ComposeInfo, IssueKind, ProgressItem, ProgressKind,
    ProgressStatus, ServicePhase, ServiceProgress, StackFiles, StackOp, StackOpFeed, StackOrigin,
    StackOutcome, StackRisk, StackService, StackStatus, StackSummary, StackValidation,
    ValidationIssue,
};

/// Verbo de una operación de ciclo de vida (sin servicios).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StackOpKind {
    Up,
    Restart,
    Stop,
    Start,
    Pull,
}

impl StackOpKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Restart => "restart",
            Self::Stop => "stop",
            Self::Start => "start",
            Self::Pull => "pull",
        }
    }
}

/// Separa la operación de la UI en (verbo, servicios pedidos).
pub fn split_op(op: &StackOp) -> (StackOpKind, Vec<String>) {
    let (kind, svc) = match op {
        StackOp::Up { services } => (StackOpKind::Up, services),
        StackOp::Restart { services } => (StackOpKind::Restart, services),
        StackOp::Stop { services } => (StackOpKind::Stop, services),
        StackOp::Start { services } => (StackOpKind::Start, services),
        StackOp::Pull { services } => (StackOpKind::Pull, services),
    };
    (kind, svc.clone().unwrap_or_default())
}

/// Lo que ejecuta el runner: una operación de ciclo de vida o `down`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OpKind {
    Lifecycle(StackOpKind),
    Down,
}

impl OpKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lifecycle(k) => k.as_str(),
            Self::Down => "down",
        }
    }
}
