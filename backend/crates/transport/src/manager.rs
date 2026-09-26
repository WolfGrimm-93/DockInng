//! Gestor de la conexión remota activa: levanta el túnel SSH o prepara el material TLS,
//! y garantiza que solo hay UNA conexión remota viva (al activar otra, se cierra la anterior).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use engine_core::{ConnSpec, ConnectionCause, EngineError};
use tokio::sync::Mutex;

use crate::classify::Failure;
use crate::fsutil::{default_tunnels_dir, purge_stale_sockets};
use crate::ssh_args::SshTarget;
use crate::tls::{CertDir, TlsTarget, default_certs_dir};
use crate::tunnel::{Tunnel, TunnelConfig};

/// Pista de fallo (causa y mensaje) que consulta el motor al diagnosticar.
pub type Hint = Arc<dyn Fn() -> Option<(ConnectionCause, String)> + Send + Sync>;

/// Conexión remota lista para conectar (aún no activa).
pub enum Prepared {
    Ssh { tunnel: Tunnel, label: String },
    Tls { target: TlsTarget, certs: CertDir },
}

impl Prepared {
    /// Etiqueta legible (`ssh://usuario@host:puerto`, `tls://host:puerto`).
    pub fn label(&self) -> String {
        match self {
            Prepared::Ssh { label, .. } => label.clone(),
            Prepared::Tls { target, .. } => target.label(),
        }
    }

    /// Socket local del túnel (solo SSH).
    pub fn socket_path(&self) -> Option<&Path> {
        match self {
            Prepared::Ssh { tunnel, .. } => Some(tunnel.socket_path()),
            Prepared::Tls { .. } => None,
        }
    }

    /// Destino y directorio de certificados (solo TLS).
    pub fn tls(&self) -> Option<(&TlsTarget, &CertDir)> {
        match self {
            Prepared::Tls { target, certs } => Some((target, certs)),
            Prepared::Ssh { .. } => None,
        }
    }

    /// Pista de fallos del transporte (solo SSH).
    pub fn hint(&self) -> Option<Hint> {
        match self {
            Prepared::Ssh { tunnel, .. } => Some(tunnel.failure_hint()),
            Prepared::Tls { .. } => None,
        }
    }

    /// Último fallo clasificado del túnel, si lo hay.
    pub fn last_failure(&self) -> Option<Failure> {
        match self {
            Prepared::Ssh { tunnel, .. } => tunnel.last_failure(),
            Prepared::Tls { .. } => None,
        }
    }

    /// Cierra lo preparado (un intento que no llegó a activarse).
    pub async fn abandon(self) {
        if let Prepared::Ssh { tunnel, .. } = self {
            tunnel.shutdown().await;
        }
    }
}

/// Lo que mantiene viva la conexión activa.
enum Active {
    Ssh(Tunnel),
    Tls(#[allow(dead_code)] CertDir),
}

struct Current {
    id: String,
    active: Active,
}

/// Gestor único de la conexión remota.
pub struct RemoteManager {
    tunnels_dir: PathBuf,
    certs_dir: PathBuf,
    cfg: TunnelConfig,
    current: Mutex<Option<Current>>,
}

impl Default for RemoteManager {
    fn default() -> Self {
        Self::new()
    }
}

impl RemoteManager {
    pub fn new() -> Self {
        Self::with_dirs(
            default_tunnels_dir(),
            default_certs_dir(),
            TunnelConfig::default(),
        )
    }

    pub fn with_dirs(tunnels_dir: PathBuf, certs_dir: PathBuf, cfg: TunnelConfig) -> Self {
        Self {
            tunnels_dir,
            certs_dir,
            cfg,
            current: Mutex::new(None),
        }
    }

    /// Al arrancar: elimina sockets de túneles huérfanos de ejecuciones anteriores.
    pub fn purge_stale(&self) -> usize {
        purge_stale_sockets(&self.tunnels_dir)
    }

    /// Prepara una conexión (levanta el túnel o valida/enlaza los certificados) sin activarla.
    pub async fn prepare(
        &self,
        spec: &ConnSpec,
        known_hosts: &Path,
    ) -> Result<Prepared, EngineError> {
        match spec {
            ConnSpec::Ssh { .. } => {
                let target = SshTarget::from_spec(spec)?;
                let label = ssh_label(&target);
                let tunnel =
                    Tunnel::start(&target, known_hosts, &self.tunnels_dir, self.cfg.clone())
                        .await?;
                Ok(Prepared::Ssh { tunnel, label })
            }
            ConnSpec::Tls { .. } => {
                let target = TlsTarget::from_spec(spec)?;
                let certs = CertDir::create(&self.certs_dir, &target)?;
                Ok(Prepared::Tls { target, certs })
            }
        }
    }

    /// Activa la conexión `id`: la anterior (si la había) se cierra.
    pub async fn activate(&self, id: &str, prepared: Prepared) {
        let active = match prepared {
            Prepared::Ssh { tunnel, .. } => Active::Ssh(tunnel),
            Prepared::Tls { certs, .. } => Active::Tls(certs),
        };
        let previous = self.current.lock().await.replace(Current {
            id: id.to_string(),
            active,
        });
        if let Some(Current {
            active: Active::Ssh(t),
            ..
        }) = previous
        {
            t.shutdown().await;
        }
    }

    /// Cierra la conexión remota activa (se vuelve a local o se sale de la app).
    pub async fn deactivate(&self) {
        let previous = self.current.lock().await.take();
        if let Some(Current {
            active: Active::Ssh(t),
            ..
        }) = previous
        {
            t.shutdown().await;
        }
    }

    /// Id de la conexión remota activa.
    pub async fn active_id(&self) -> Option<String> {
        self.current.lock().await.as_ref().map(|c| c.id.clone())
    }

    /// Último fallo del túnel activo (para explicar una caída posterior).
    pub async fn active_failure(&self) -> Option<Failure> {
        match self.current.lock().await.as_ref() {
            Some(Current {
                active: Active::Ssh(t),
                ..
            }) => t.last_failure(),
            _ => None,
        }
    }
}

/// `ssh://usuario@host:puerto` (sin usuario/puerto cuando vienen del alias).
fn ssh_label(t: &SshTarget) -> String {
    let user = t
        .user
        .as_deref()
        .map(|u| format!("{u}@"))
        .unwrap_or_default();
    let port = t.port.map(|p| format!(":{p}")).unwrap_or_default();
    format!("ssh://{user}{}{port}", t.host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::{SshIdentity, SshMode};

    #[test]
    fn etiqueta_ssh() {
        let t = SshTarget {
            host: "h.example".into(),
            port: Some(2222),
            user: Some("deploy".into()),
            mode: SshMode::Explicit,
            identity: SshIdentity::Agent,
        };
        assert_eq!(ssh_label(&t), "ssh://deploy@h.example:2222");
        let alias = SshTarget {
            host: "web".into(),
            port: None,
            user: None,
            mode: SshMode::Alias,
            identity: SshIdentity::Agent,
        };
        assert_eq!(ssh_label(&alias), "ssh://web");
    }

    #[tokio::test]
    async fn prepara_tls_sin_archivos_falla_y_no_deja_nada() {
        let m = RemoteManager::with_dirs(
            "/tmp/dktest-mgr-t".into(),
            "/tmp/dktest-mgr-c".into(),
            TunnelConfig::default(),
        );
        let spec = ConnSpec::Tls {
            name: "t".into(),
            host: "h".into(),
            port: 2376,
            ca_path: "/nonexistent/ca.pem".into(),
            cert_path: "/nonexistent/cert.pem".into(),
            key_path: "/nonexistent/key.pem".into(),
        };
        assert!(m.prepare(&spec, Path::new("/tmp/kh")).await.is_err());
        assert!(m.active_id().await.is_none());
    }
}
