//! Integración con Docker Compose: detección, parsers de salida real, gestor de stacks propios,
//! lanzador de subprocesos seguro y progreso `--progress json`.

pub mod args;
pub mod control;
pub mod error;
pub mod fakes;
pub mod files;
pub mod parse;
pub mod proc;
pub mod progress;
pub mod risks;
pub mod runner;
pub mod summary;
pub mod types;
pub mod validate;

pub use error::ComposeError;
pub use runner::ComposeRunner;
