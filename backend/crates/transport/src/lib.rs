//! Transporte hacia motores remotos: túnel SSH (`ssh … docker system dial-stdio`) con
//! verificación estricta de la clave del servidor sobre un `known_hosts` propio, y TLS
//! mutuo con certificados de cliente. Sin servidores reales en los tests: fixtures locales.

pub mod classify;
pub mod env;
pub mod fsutil;
pub mod keyscan;
pub mod known_hosts;
pub mod manager;
pub mod proc;
pub mod ssh_args;
pub mod tls;
pub mod tunnel;

pub use classify::{Failure, classify_ssh_stderr};
pub use manager::{Hint, Prepared, RemoteManager};
pub use ssh_args::{SshTarget, ssh_dial_args};
pub use tls::{CertDir, TlsTarget};
pub use tunnel::{Tunnel, TunnelConfig};
