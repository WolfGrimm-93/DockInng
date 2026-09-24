use async_trait::async_trait;

use crate::{Container, EngineError, EngineInfo};

/// Contrato que cumple cualquier motor de contenedores (Docker, Podman, mocks de test).
/// La GUI y la CLI dependen de este trait, nunca de un cliente concreto.
#[async_trait]
pub trait EngineClient: Send + Sync {
    /// Comprueba que el daemon responde.
    async fn ping(&self) -> Result<(), EngineError>;
    async fn info(&self) -> Result<EngineInfo, EngineError>;
    /// Lista contenedores; con `all = false` solo los que están corriendo.
    async fn list_containers(&self, all: bool) -> Result<Vec<Container>, EngineError>;
    async fn start_container(&self, id: &str) -> Result<(), EngineError>;
    async fn stop_container(&self, id: &str) -> Result<(), EngineError>;
    async fn remove_container(&self, id: &str, force: bool) -> Result<(), EngineError>;
}
