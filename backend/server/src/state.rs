//! Estado compartido de la aplicación axum.

use std::sync::Arc;

use engine_core::EngineClient;
use store::Store;

use crate::config::AuthMode;
use crate::session::SessionStore;

#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<dyn EngineClient>,
    /// `None` en modo `single`: no hay usuarios que gestionar ni sesiones que verificar.
    pub store: Option<Arc<Store>>,
    pub sessions: Arc<SessionStore>,
    pub auth_mode: AuthMode,
    pub insecure_cookies: bool,
}
