//! Contexto de ejecución de los comandos: motor, servicios y modo de salida.

use std::sync::Arc;

use compose::ComposeRunner;
use compose::files::StackStore;
use compose::proc::TokioSpawn;
use compose::runner::Limits;
use engine_core::{ActionService, Interactivity, StackControl};
use engine_docker::DockerEngine;

pub struct Ctx {
    pub engine: Arc<DockerEngine>,
    pub json: bool,
    pub interactivity: Interactivity,
}

impl Ctx {
    pub fn new(json: bool) -> Self {
        Self {
            // El motor se construye sin fallar; los errores de conexión salen en cada llamada.
            engine: Arc::new(DockerEngine::new()),
            json,
            interactivity: crate::confirm::interactivity(),
        }
    }

    /// Acciones sin control de stacks (contenedores, imágenes, volúmenes, redes, limpieza).
    pub fn actions(&self) -> ActionService {
        ActionService::new(self.engine.clone())
    }

    /// Ejecutor de Compose: hereda el endpoint del motor (`DOCKER_HOST` del hijo).
    pub fn runner(&self) -> Arc<ComposeRunner> {
        let ep = self.engine.clone();
        Arc::new(ComposeRunner::with_endpoint_source(
            Arc::new(move || Some(ep.endpoint().display())),
            Arc::new(TokioSpawn),
            Limits::default(),
            StackStore::with_default_root().unwrap_or_else(|_| StackStore::unavailable()),
        ))
    }

    /// Acciones con control de stacks (`stacks down`).
    pub fn actions_with_stacks(&self) -> ActionService {
        let control: Arc<dyn StackControl> = self.runner();
        ActionService::with_stacks(self.engine.clone(), Some(control))
    }

    /// Destino del daemon para los subprocesos (`docker build`): el mismo motor que usa la CLI.
    pub fn build_target(&self) -> builder::BuildTarget {
        let (docker_host, env) = self.engine.subprocess_env();
        builder::BuildTarget {
            docker_host: Some(docker_host),
            env,
        }
    }
}

/// Convierte un error de la API en el texto que ve la persona.
pub fn api_msg(e: impl Into<engine_core::ApiError>) -> String {
    e.into().message
}

/// Se completa al pulsar Ctrl-C (cancelación limpia de operaciones largas).
pub async fn ctrl_c() {
    let _ = tokio::signal::ctrl_c().await;
}
