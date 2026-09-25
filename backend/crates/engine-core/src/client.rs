use std::pin::Pin;

use async_trait::async_trait;
use futures_core::Stream;

use crate::{
    ConnectionStatus, Container, ContainerDetail, ContainerStats, EngineError, EngineEvent,
    EngineInfo, Image, LogLine, LogsRequest, Network, SystemUsage, Volume,
};

/// Stream boxed, `'static` y `Send`, para poder lanzarlo en una tarea.
pub type EngineStream<T> = Pin<Box<dyn Stream<Item = Result<T, EngineError>> + Send + 'static>>;

/// Contrato que cumple cualquier motor de contenedores (Docker, Podman, mocks de test).
/// La GUI y la CLI dependen de este trait, nunca de un cliente concreto.
#[async_trait]
pub trait EngineClient: Send + Sync {
    // --- conexión ---
    /// Comprueba que el daemon responde.
    async fn ping(&self) -> Result<(), EngineError>;
    async fn info(&self) -> Result<EngineInfo, EngineError>;
    /// Describe el estado de la conexión; nunca falla.
    async fn diagnose(&self) -> ConnectionStatus;
    /// Reintenta conectar y describe el resultado.
    async fn reconnect(&self) -> ConnectionStatus;

    // --- contenedores ---
    /// Con `all = false` solo los que están corriendo.
    async fn list_containers(&self, all: bool) -> Result<Vec<Container>, EngineError>;
    async fn inspect_container(&self, id: &str) -> Result<ContainerDetail, EngineError>;
    async fn start_container(&self, id: &str) -> Result<(), EngineError>;
    async fn stop_container(&self, id: &str) -> Result<(), EngineError>;
    async fn restart_container(&self, id: &str) -> Result<(), EngineError>;
    /// Nunca borra volúmenes (`v=false`).
    async fn remove_container(&self, id: &str, force: bool) -> Result<(), EngineError>;
    async fn stats_snapshot(&self, id: &str) -> Result<ContainerStats, EngineError>;

    // --- recursos ---
    async fn list_images(&self) -> Result<Vec<Image>, EngineError>;
    /// Sin force ni noprune.
    async fn remove_image(&self, reference: &str) -> Result<(), EngineError>;
    async fn list_volumes(&self) -> Result<Vec<Volume>, EngineError>;
    async fn inspect_volume(&self, name: &str) -> Result<Volume, EngineError>;
    async fn remove_volume(&self, name: &str) -> Result<(), EngineError>;
    async fn list_networks(&self) -> Result<Vec<Network>, EngineError>;
    async fn remove_network(&self, id: &str) -> Result<(), EngineError>;

    // --- sistema ---
    /// CPU/memoria del equipo y uso de disco de Docker. Si `df` falla o expira, `disk_known = false` (no es un error).
    async fn system_usage(&self) -> Result<SystemUsage, EngineError>;

    // --- streaming ---
    fn events(&self) -> EngineStream<EngineEvent>;
    fn logs(&self, id: &str, req: LogsRequest) -> EngineStream<LogLine>;
    fn stats(&self, id: &str) -> EngineStream<ContainerStats>;
}
