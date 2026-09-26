//! Construcción de imágenes con el subproceso `docker build`.
//!
//! Motivos frente a `bollard::build_image`: paridad con la CLI (BuildKit, heredocs, secrets),
//! hereda el destino (`DOCKER_HOST`: túnel SSH/TLS incluido) y la cancelación mata el grupo
//! de procesos, igual que Compose. El progreso se interpreta en "mejor esfuerzo": la UI
//! siempre recibe además las líneas crudas.

pub mod argv;
pub mod service;

pub use argv::build_argv;
pub use service::{BuildService, BuildSink, BuildTarget, PreparedBuild, RunResult, child_env};
