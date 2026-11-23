//! Estado compartido de la aplicación axum.

use std::sync::Arc;

use engine_core::EngineClient;
use store::Store;

use crate::config::AuthMode;
use crate::login_limit::LoginGuard;
use crate::session::SessionStore;

#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<dyn EngineClient>,
    /// `None` en modo `single`: no hay usuarios que gestionar ni sesiones que verificar.
    pub store: Option<Arc<Store>>,
    pub sessions: Arc<SessionStore>,
    /// Freno a la fuerza bruta del login y tope de hashes Argon2 simultáneos.
    pub login_guard: Arc<LoginGuard>,
    pub auth_mode: AuthMode,
    pub insecure_cookies: bool,
}
