use std::sync::Arc;

use compose::ComposeRunner;
use engine_core::{
    ActionService, CreateEngine, CreateService, EngineClient, ExecEngine, PullEngine, StackControl,
    StackDiscovery,
};
use engine_docker::DockerEngine;
use store::{KeyringSecrets, SecretStore, Store};
use transport::RemoteManager;

use crate::build_feed::BuildGuards;
use crate::exec_sessions::ExecSessions;
use crate::pull_feed::PullGuards;
use crate::stack_ops::StackService;
use crate::streams::StreamRegistry;

/// Estado compartido entre comandos.
pub struct AppState {
    pub engine: Arc<dyn EngineClient>,
    pub actions: Arc<ActionService>,
    pub streams: Arc<StreamRegistry>,
    pub exec: Arc<dyn ExecEngine>,
    pub pull: Arc<dyn PullEngine>,
    pub pulls: Arc<PullGuards>,
    pub create: Arc<CreateService>,
    pub stacks: Arc<StackService>,
    pub exec_sessions: Arc<ExecSessions>,
    /// Persistencia local (SQLite). `None` si el directorio de datos no está disponible o en
    /// tests: los comandos que la necesitan responden con error en vez de entrar en pánico.
    pub store: Option<Arc<Store>>,
    /// Por qué no se pudo abrir el almacén (esquema futuro, base corrupta, dueño, permisos...).
    pub store_error: Option<String>,
    /// Conexión remota activa (túnel SSH / TLS) y su limpieza.
    pub remote: Arc<RemoteManager>,
    /// Builds de imagen en curso.
    pub builds: Arc<BuildGuards>,
    /// Motor Docker concreto (para cambiar de destino en caliente). `None` con motores simulados.
    pub docker: Option<Arc<DockerEngine>>,
    /// Destino del motor local con el que arrancó la app (al volver a `local` se restaura;
    /// en tests apunta a un socket fijo en vez de resolver el entorno real).
    pub local_target: Option<engine_docker::Target>,
    /// Llavero de secretos de registros (real por defecto; en memoria en tests).
    pub secrets: Arc<dyn SecretStore>,
    /// Serializa los cambios de conexión: nunca dos a la vez.
    /// Escritura = cambio/edición de conexiones; lectura = acciones en vuelo (un cambio espera a
    /// que terminen y ninguna acción arranca sobre un motor a medio cambiar).
    pub switch_lock: tokio::sync::RwLock<()>,
}

impl AppState {
    /// Guarda para acciones que EJECUTAN cambios: toma el lado de lectura de `switch_lock` (así
    /// un cambio de conexión espera a que termine la acción en vuelo, que corre completa sobre
    /// el motor con el que se planificó) y comprueba que no hay un cambio en curso. Se debe
    /// mantener mientras dure la acción.
    pub async fn action_guard(
        &self,
    ) -> Result<tokio::sync::RwLockReadGuard<'_, ()>, engine_core::ApiError> {
        let guard = self.switch_lock.read().await;
        self.ensure_not_switching()?;
        Ok(guard)
    }

    /// Falla (Conflict reintentable) si hay un cambio de conexión en curso: los comandos de
    /// acción y creación no deben planificarse contra un motor que está a punto de cambiar.
    pub fn ensure_not_switching(&self) -> Result<(), engine_core::ApiError> {
        if self.streams.is_paused() {
            Err(crate::streams::switching_error())
        } else {
            Ok(())
        }
    }

    /// `DOCKER_HOST` y variables extra REALES del destino activo para subprocesos (`docker
    /// build`). `None` con motores simulados.
    pub fn subprocess_env(&self) -> Option<(String, Vec<(String, String)>)> {
        self.docker.as_ref().map(|d| d.subprocess_env())
    }

    /// Estado real: un único motor Docker sirve todos los contratos, y Compose usa el mismo
    /// endpoint (`DOCKER_HOST`) para hablar con el mismo daemon.
    pub fn new(engine: Arc<DockerEngine>) -> Self {
        // El endpoint se lee del motor en cada lanzamiento: tras `reconnect` puede cambiar.
        let ep_engine = engine.clone();
        let runner = ComposeRunner::with_endpoint_source(
            Arc::new(move || Some(ep_engine.endpoint().display())),
            Arc::new(compose::proc::TokioSpawn),
            compose::runner::Limits::default(),
            compose::files::StackStore::with_default_root()
                .unwrap_or_else(|_| compose::files::StackStore::unavailable()),
        );
        // Con un daemon remoto: los bind mounts se avisan (X3) y, con TLS, los subprocesos
        // reciben `DOCKER_TLS_VERIFY`/`DOCKER_CERT_PATH` del destino activo.
        let remote_engine = engine.clone();
        runner.set_remote_source(Arc::new(move || remote_engine.endpoint().is_remote()));
        let env_engine = engine.clone();
        runner.set_extra_env_source(Arc::new(move || env_engine.endpoint().docker_env()));
        let control: Arc<dyn StackControl> = Arc::new(runner);
        let docker = engine.clone();
        let mut state = Self::with_parts(
            engine.clone(),
            engine.clone(),
            engine.clone(),
            engine.clone(),
            engine,
            control,
        );
        state.local_target = Some(docker.target());
        state.docker = Some(docker);
        state
    }

    /// Ensamblado con piezas sueltas (tests con mocks).
    pub fn with_parts(
        engine: Arc<dyn EngineClient>,
        exec: Arc<dyn ExecEngine>,
        pull: Arc<dyn PullEngine>,
        creator: Arc<dyn CreateEngine>,
        discovery: Arc<dyn StackDiscovery>,
        control: Arc<dyn StackControl>,
    ) -> Self {
        Self {
            actions: Arc::new(ActionService::with_stacks(
                engine.clone(),
                Some(control.clone()),
            )),
            create: Arc::new(CreateService::new(engine.clone(), creator)),
            stacks: StackService::new(discovery.clone(), control),
            engine,
            streams: StreamRegistry::new(),
            exec,
            pull,
            pulls: PullGuards::new(),
            exec_sessions: ExecSessions::new(),
            store: None,
            store_error: None,
            remote: Arc::new(RemoteManager::new()),
            builds: BuildGuards::new(),
            docker: None,
            local_target: None,
            secrets: Arc::new(KeyringSecrets::default()),
            switch_lock: tokio::sync::RwLock::new(()),
        }
    }
}
