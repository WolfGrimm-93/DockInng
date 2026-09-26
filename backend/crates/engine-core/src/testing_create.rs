//! Mock de `CreateEngine`: registra las specs normalizadas que recibe.

use std::sync::{Mutex, MutexGuard};

use async_trait::async_trait;

use crate::create::{
    CreateContainerSpec, CreateEngine, CreateNetworkSpec, CreateResult, CreateVolumeSpec,
};
use crate::error::EngineError;
use crate::resources::{Network, Volume};
use crate::testing::MockEngine;

#[derive(Default)]
pub struct MockCreate {
    calls: Mutex<Vec<String>>,
    specs: Mutex<Vec<CreateContainerSpec>>,
    /// Error a devolver en `create_container` (una vez armado, en cada llamada).
    fail: Mutex<Option<EngineError>>,
}

impl MockCreate {
    fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
        m.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_fail(&self, e: Option<EngineError>) {
        *Self::lock(&self.fail) = e;
    }

    pub fn calls(&self) -> Vec<String> {
        Self::lock(&self.calls).clone()
    }

    pub fn specs(&self) -> Vec<CreateContainerSpec> {
        Self::lock(&self.specs).clone()
    }
}

#[async_trait]
impl CreateEngine for MockCreate {
    async fn create_container(
        &self,
        spec: &CreateContainerSpec,
        start: bool,
    ) -> Result<CreateResult, EngineError> {
        Self::lock(&self.calls).push(format!("create_container:{}:start={start}", spec.image));
        Self::lock(&self.specs).push(spec.clone());
        if let Some(e) = Self::lock(&self.fail).clone() {
            return Err(e);
        }
        Ok(CreateResult {
            id: "a".repeat(64),
            name: spec.name.clone().unwrap_or_else(|| "mock".into()),
            started: start,
            warnings: vec![],
            start_error: None,
        })
    }

    async fn create_volume(&self, spec: &CreateVolumeSpec) -> Result<Volume, EngineError> {
        Self::lock(&self.calls).push(format!("create_volume:{}", spec.name));
        Ok(MockEngine::volume(&spec.name, "t", &[]))
    }

    async fn create_network(&self, spec: &CreateNetworkSpec) -> Result<Network, EngineError> {
        Self::lock(&self.calls).push(format!("create_network:{}", spec.name));
        Ok(MockEngine::network("net-id", &spec.name, &[], false))
    }
}
