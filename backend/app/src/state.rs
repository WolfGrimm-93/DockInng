use std::sync::Arc;

use engine_core::{ActionService, EngineClient};

use crate::streams::StreamRegistry;

/// Estado compartido entre comandos.
pub struct AppState {
    pub engine: Arc<dyn EngineClient>,
    pub actions: Arc<ActionService>,
    pub streams: Arc<StreamRegistry>,
}

impl AppState {
    pub fn new(engine: Arc<dyn EngineClient>) -> Self {
        Self {
            actions: Arc::new(ActionService::new(engine.clone())),
            engine,
            streams: StreamRegistry::new(),
        }
    }
}
