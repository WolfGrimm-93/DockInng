use thiserror::Error;

/// Errores del motor, independientes del cliente concreto.
#[derive(Debug, Error)]
pub enum EngineError {
    /// No se pudo conectar con el daemon (socket ausente, sin permisos, daemon apagado).
    #[error("no se pudo conectar con el motor: {0}")]
    Connection(String),
    /// El daemon respondió con un error (recurso inexistente, conflicto, etc.).
    #[error("error del motor: {0}")]
    Engine(String),
}
