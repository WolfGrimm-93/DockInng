//! Mock de `PullEngine`: reproduce una lista fija de eventos (o un error).

use futures_util::stream;

use crate::client::EngineStream;
use crate::error::EngineError;
use crate::pull::{PullEngine, PullEvent};

pub struct MockPull {
    pub events: Vec<Result<PullEvent, EngineError>>,
}

impl PullEngine for MockPull {
    fn pull_image(&self, _reference: &str) -> EngineStream<PullEvent> {
        Box::pin(stream::iter(self.events.clone()))
    }
}
