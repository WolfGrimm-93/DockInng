//! Núcleo de dominio de DockInng: modelos, contrato del motor y política de confirmación.
//! No depende de ningún cliente Docker concreto ni de la interfaz (GUI/CLI).

pub mod client;
pub mod error;
pub mod model;
pub mod policy;

pub use client::EngineClient;
pub use error::EngineError;
pub use model::{Container, ContainerState, EngineInfo};
pub use policy::{Action, ConfirmationPolicy, Decision, DenyReason, Interactivity};
