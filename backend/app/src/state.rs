use std::sync::Arc;

use compose::ComposeRunner;
use engine_core::{
    ActionService, CreateEngine, CreateService, EngineClient, ExecEngine, PullEngine, StackControl,
    StackDiscovery,
};
use engine_docker::DockerEngine;

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
}

impl AppState {
    /// Estado real: un único motor Docker sirve todos los contratos, y Compose usa el mismo
    /// endpoint (`DOCKER_HOST`) para hablar con el mismo daemon.
    pub fn new(engine: Arc<DockerEngine>) -> Self {
        // El endpoint se lee del motor en cada lanzamiento: tras `reconnect` puede cambiar.
        let ep_engine = engine.clone();
        let control: Arc<dyn StackControl> = Arc::new(ComposeRunner::with_endpoint_source(
            Arc::new(move || Some(ep_engine.endpoint().display())),
            Arc::new(compose::proc::TokioSpawn),
            compose::runner::Limits::default(),
            compose::files::StackStore::with_default_root()
                .unwrap_or_else(|_| compose::files::StackStore::unavailable()),
        ));
        Self::with_parts(
            engine.clone(),
            engine.clone(),
            engine.clone(),
            engine.clone(),
            engine,
            control,
        )
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
        }
    }
}
