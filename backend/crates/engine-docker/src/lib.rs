//! Adaptador de `EngineClient` sobre la Docker Engine API usando `bollard`.

use async_trait::async_trait;
use bollard::Docker;
use bollard::query_parameters::{ListContainersOptionsBuilder, RemoveContainerOptionsBuilder};
use engine_core::{Container, ContainerState, EngineClient, EngineError, EngineInfo};

/// Label que Compose pone a cada contenedor con el nombre de su proyecto.
const COMPOSE_PROJECT_LABEL: &str = "com.docker.compose.project";

pub struct DockerEngine {
    docker: Docker,
}

impl DockerEngine {
    /// Conecta con los valores por defecto: respeta `DOCKER_HOST` y, si no está, usa el socket local.
    pub fn connect() -> Result<Self, EngineError> {
        let docker =
            Docker::connect_with_defaults().map_err(|e| EngineError::Connection(e.to_string()))?;
        Ok(Self { docker })
    }
}

/// Distingue "no hay conexión" de "el daemon respondió con error".
fn map_err(e: bollard::errors::Error) -> EngineError {
    use bollard::errors::Error::*;
    match e {
        DockerResponseServerError { message, .. } => EngineError::Engine(message),
        other => EngineError::Connection(other.to_string()),
    }
}

#[async_trait]
impl EngineClient for DockerEngine {
    async fn ping(&self) -> Result<(), EngineError> {
        self.docker.ping().await.map(|_| ()).map_err(map_err)
    }

    async fn info(&self) -> Result<EngineInfo, EngineError> {
        let v = self.docker.version().await.map_err(map_err)?;
        Ok(EngineInfo {
            version: v.version.unwrap_or_default(),
            api_version: v.api_version.unwrap_or_default(),
            os: v.os.unwrap_or_default(),
            arch: v.arch.unwrap_or_default(),
        })
    }

    async fn list_containers(&self, all: bool) -> Result<Vec<Container>, EngineError> {
        let options = ListContainersOptionsBuilder::default().all(all).build();
        let list = self
            .docker
            .list_containers(Some(options))
            .await
            .map_err(map_err)?;

        Ok(list
            .into_iter()
            .map(|c| Container {
                id: c.id.unwrap_or_default(),
                // La API devuelve los nombres con "/" al inicio.
                names: c
                    .names
                    .unwrap_or_default()
                    .into_iter()
                    .map(|n| n.trim_start_matches('/').to_string())
                    .collect(),
                image: c.image.unwrap_or_default(),
                state: c
                    .state
                    .map(|s| ContainerState::from_engine(s.as_ref()))
                    .unwrap_or(ContainerState::Unknown),
                status: c.status.unwrap_or_default(),
                compose_project: c.labels.and_then(|mut l| l.remove(COMPOSE_PROJECT_LABEL)),
            })
            .collect())
    }

    async fn start_container(&self, id: &str) -> Result<(), EngineError> {
        self.docker.start_container(id, None).await.map_err(map_err)
    }

    async fn stop_container(&self, id: &str) -> Result<(), EngineError> {
        self.docker.stop_container(id, None).await.map_err(map_err)
    }

    async fn remove_container(&self, id: &str, force: bool) -> Result<(), EngineError> {
        let options = RemoveContainerOptionsBuilder::default()
            .force(force)
            .build();
        self.docker
            .remove_container(id, Some(options))
            .await
            .map_err(map_err)
    }
}
