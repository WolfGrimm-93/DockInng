//! Contexto de ejecución de los comandos: motor, servicios y modo de salida.

use std::sync::Arc;

use compose::ComposeRunner;
use compose::files::StackStore;
use compose::proc::TokioSpawn;
use compose::runner::Limits;
use engine_core::{ActionService, ConnectionProfile, Interactivity, StackControl};
use engine_docker::{DockerEngine, Endpoint, Target};
use store::Store;
use transport::{Prepared, RemoteManager};

pub struct Ctx {
    pub engine: Arc<DockerEngine>,
    pub json: bool,
    pub interactivity: Interactivity,
    pub(crate) remote: RemoteManager,
}

impl Ctx {
    pub fn new(json: bool) -> Self {
        Self {
            // El motor se construye sin fallar; los errores de conexión salen en cada llamada.
            engine: Arc::new(DockerEngine::new()),
            json,
            interactivity: crate::confirm::interactivity(),
            remote: RemoteManager::new(),
        }
    }

    /// Activa un perfil remoto para esta ejecución y mantiene vivo su transporte.
    pub async fn select_remote(
        &self,
        store: &Store,
        profile: &ConnectionProfile,
    ) -> Result<(), String> {
        let prepared = self
            .remote
            .prepare(&profile.spec, &store.known_hosts_path())
            .await
            .map_err(|e| e.to_string())?;
        let target = match &prepared {
            Prepared::Ssh { tunnel, label } => Target::tunnel(
                &tunnel.socket_path().to_string_lossy(),
                label,
                Some(tunnel.failure_hint()),
            ),
            Prepared::Tls { target, certs } => Target::tls(Endpoint::Tls {
                addr: target.addr(),
                ca: target.ca.to_string_lossy().into_owned(),
                cert: target.cert.to_string_lossy().into_owned(),
                key: target.key.to_string_lossy().into_owned(),
                cert_dir: certs.path().to_string_lossy().into_owned(),
                label: target.label(),
            }),
        };
        self.remote.activate(&profile.id, prepared).await;
        self.engine.set_target(target);
        store
            .connection_touch(&profile.id)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Fuerza el motor local para una selección explícita de `local`.
    pub fn select_local(&self) {
        self.engine.set_target(Target::local());
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
