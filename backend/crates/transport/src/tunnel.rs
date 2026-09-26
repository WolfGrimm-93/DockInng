//! Túnel local hacia el daemon remoto: un listener Unix PRIVADO y, por cada conexión
//! aceptada, un `ssh … -- <host> docker system dial-stdio` cuyo stdin/stdout se conecta al
//! socket. Así `bollard` (y `docker compose`/`docker build` vía `DOCKER_HOST`) hablan con el
//! daemon remoto sin cambios, incluidas las conexiones secuestradas de exec/attach.
//!
//! Frontera de seguridad local: directorio 0700 + socket 0600 + verificación del uid del
//! par (`SO_PEERCRED`). Como con el socket local de Docker, otro proceso del MISMO usuario
//! puede hablar con el daemon remoto.

use std::collections::HashSet;
use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use engine_core::EngineError;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::process::Command;
use tokio::sync::{Semaphore, watch};
use tokio::task::{JoinHandle, JoinSet};

use crate::classify::{Failure, classify_ssh_stderr, sanitize_detail};
use crate::env::process_clean_env;
use crate::fsutil::ensure_private_dir;
use crate::ssh_args::{SshTarget, ssh_dial_args};

/// Longitud máxima segura de la ruta de un socket Unix (`sun_path` = 108 con el NUL).
const MAX_SOCKET_PATH: usize = 100;
/// Tope de conexiones simultáneas por túnel.
pub const MAX_CONNECTIONS: usize = 32;
/// Bytes de stderr de `ssh` que se conservan para clasificar.
const STDERR_CAP: usize = 4096;
/// Espera a que `ssh` termine tras cerrar sus tuberías, antes de matarlo.
const CHILD_GRACE: Duration = Duration::from_secs(2);
/// Tras el EOF del cliente, espera a que el remoto termine de responder.
const HALF_CLOSE_GRACE: Duration = Duration::from_secs(3);

/// Parámetros del túnel.
#[derive(Debug, Clone)]
pub struct TunnelConfig {
    pub ssh_bin: String,
    /// Ejecutable remoto (`docker`); solo tests lo cambian.
    pub docker_bin: String,
    pub max_connections: usize,
    /// Uid permitido para conectarse al socket; por defecto el efectivo del proceso.
    pub allowed_uid: Option<u32>,
    /// Socket del agente SSH a usar en lugar de `SSH_AUTH_SOCK` del proceso (tests).
    pub ssh_auth_sock: Option<PathBuf>,
}

impl Default for TunnelConfig {
    fn default() -> Self {
        Self {
            ssh_bin: "ssh".into(),
            docker_bin: "docker".into(),
            max_connections: MAX_CONNECTIONS,
            allowed_uid: None,
            ssh_auth_sock: None,
        }
    }
}

/// ¿Puede este uid hablar con el túnel? Función pura (la usan los tests).
pub fn peer_allowed(peer_uid: u32, allowed_uid: u32) -> bool {
    peer_uid == allowed_uid
}

#[derive(Default)]
struct Shared {
    /// Pids de los `ssh` vivos (para verificar que no quedan huérfanos).
    pids: Mutex<HashSet<u32>>,
    /// Último fallo clasificado de un intento de conexión.
    failure: Mutex<Option<Failure>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Túnel activo. Al soltarlo se cierra el listener y se matan los `ssh`.
pub struct Tunnel {
    socket_path: PathBuf,
    shared: Arc<Shared>,
    shutdown: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
}

impl Tunnel {
    /// Crea el listener y lanza la tarea de aceptación. `tunnels_dir` es el directorio base
    /// (se crea 0700); el socket vive en `<tunnels_dir>/<uuid v7>.sock`.
    pub async fn start(
        target: &SshTarget,
        known_hosts: &Path,
        tunnels_dir: &Path,
        cfg: TunnelConfig,
    ) -> Result<Self, EngineError> {
        // Argumentos validados UNA vez: si algo es inválido, falla antes de abrir el socket.
        let args = Arc::new(ssh_dial_args(target, known_hosts, &cfg.docker_bin)?);
        // Un socket Unix admite ~108 bytes de ruta: si el directorio pedido es demasiado
        // largo (p. ej. `$XDG_RUNTIME_DIR` inusual) se usa el respaldo corto en /tmp.
        let file = format!("{}.sock", uuid::Uuid::now_v7());
        let mut dir = tunnels_dir.to_path_buf();
        if dir.join(&file).as_os_str().len() >= MAX_SOCKET_PATH {
            dir = crate::fsutil::fallback_tunnels_dir();
        }
        ensure_private_dir(&dir)?;
        let socket_path = dir.join(file);
        let listener = UnixListener::bind(&socket_path).map_err(|e| {
            EngineError::Internal(format!("no se pudo abrir el socket del túnel: {e}"))
        })?;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| EngineError::Internal(format!("permisos del socket del túnel: {e}")))?;
        let shared = Arc::new(Shared::default());
        let (tx, rx) = watch::channel(false);
        let uid = cfg
            .allowed_uid
            .unwrap_or_else(|| unsafe { libc::geteuid() });
        let task = tokio::spawn(accept_loop(listener, args, shared.clone(), rx, cfg, uid));
        Ok(Self {
            socket_path,
            shared,
            shutdown: tx,
            task: Some(task),
        })
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// Último fallo de conexión clasificado (stderr de `ssh`).
    pub fn last_failure(&self) -> Option<Failure> {
        lock(&self.shared.failure).clone()
    }

    /// Función que devuelve el último fallo (causa y mensaje) sin retener el túnel: se la
    /// entrega al motor para que explique una conexión caída.
    pub fn failure_hint(
        &self,
    ) -> Arc<dyn Fn() -> Option<(engine_core::ConnectionCause, String)> + Send + Sync> {
        let shared = self.shared.clone();
        Arc::new(move || lock(&shared.failure).clone().map(|f| (f.cause, f.message)))
    }

    pub fn clear_failure(&self) {
        *lock(&self.shared.failure) = None;
    }

    /// Pids de los `ssh` que siguen vivos.
    pub fn active_children(&self) -> Vec<u32> {
        let mut v: Vec<u32> = lock(&self.shared.pids).iter().copied().collect();
        v.sort_unstable();
        v
    }

    /// Cierra el listener, mata los `ssh` y borra el socket.
    pub async fn shutdown(mut self) {
        let _ = self.shutdown.send(true);
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
        }
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        // Ruta de emergencia (p. ej. pánico o salida de la app): sin `await`.
        let _ = self.shutdown.send(true);
        if let Some(t) = self.task.take() {
            t.abort();
        }
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

async fn accept_loop(
    listener: UnixListener,
    args: Arc<Vec<OsString>>,
    shared: Arc<Shared>,
    mut shutdown: watch::Receiver<bool>,
    cfg: TunnelConfig,
    allowed_uid: u32,
) {
    let permits = Arc::new(Semaphore::new(cfg.max_connections.max(1)));
    let cfg = Arc::new(cfg);
    let mut conns: JoinSet<()> = JoinSet::new();
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            Some(_) = conns.join_next(), if !conns.is_empty() => {}
            acc = listener.accept() => {
                let Ok((stream, _)) = acc else {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                };
                // Par no autorizado o tope alcanzado: se cierra sin lanzar `ssh`.
                let ok_peer = stream
                    .peer_cred()
                    .is_ok_and(|c| peer_allowed(c.uid(), allowed_uid));
                let Ok(permit) = permits.clone().try_acquire_owned() else { continue };
                if !ok_peer {
                    continue;
                }
                let (args, shared, cfg) = (args.clone(), shared.clone(), cfg.clone());
                conns.spawn(async move {
                    let _permit = permit;
                    handle_connection(stream, &args, &shared, &cfg).await;
                });
            }
        }
    }
    // Cancela las conexiones en curso: sus futuros sueltan los `ssh` (kill_on_drop).
    conns.shutdown().await;
}

/// Lee stderr hasta EOF conservando solo los primeros `STDERR_CAP` bytes.
async fn drain_stderr(mut r: tokio::process::ChildStderr) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match r.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if buf.len() < STDERR_CAP {
                    let take = n.min(STDERR_CAP - buf.len());
                    buf.extend_from_slice(&chunk[..take]);
                }
            }
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

async fn handle_connection(
    client: UnixStream,
    args: &[OsString],
    shared: &Arc<Shared>,
    cfg: &TunnelConfig,
) {
    let mut env = process_clean_env();
    if let Some(sock) = &cfg.ssh_auth_sock {
        env.retain(|(k, _)| k != "SSH_AUTH_SOCK");
        env.push(("SSH_AUTH_SOCK".into(), sock.clone().into_os_string()));
    }
    let spawned = Command::new(&cfg.ssh_bin)
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            *lock(&shared.failure) = Some(Failure {
                cause: engine_core::ConnectionCause::Other,
                message: format!("no se pudo lanzar ssh: {e}"),
            });
            return;
        }
    };
    let pid = child.id();
    if let Some(p) = pid {
        lock(&shared.pids).insert(p);
    }
    let (Some(mut stdin), Some(mut stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return;
    };
    let err_task = tokio::spawn(drain_stderr(stderr));
    let (mut cr, mut cw) = client.into_split();
    let mut to_client: u64 = 0;
    {
        // cliente -> ssh (al EOF se cierra stdin de ssh soltándolo).
        let a = async {
            let _ = tokio::io::copy(&mut cr, &mut stdin).await;
            drop(stdin);
        };
        // ssh -> cliente (al EOF se cierra la escritura del cliente).
        let b = async {
            let n = tokio::io::copy(&mut stdout, &mut cw).await.unwrap_or(0);
            let _ = cw.shutdown().await;
            n
        };
        tokio::pin!(a, b);
        tokio::select! {
            n = &mut b => to_client = n,
            _ = &mut a => {
                if let Ok(n) = tokio::time::timeout(HALF_CLOSE_GRACE, &mut b).await {
                    to_client = n;
                }
            }
        }
    }
    // Fin de la conexión: `ssh` debe terminar solo; si no, se mata.
    let status = match tokio::time::timeout(CHILD_GRACE, child.wait()).await {
        Ok(s) => s.ok(),
        Err(_) => {
            let _ = child.kill().await;
            None
        }
    };
    let stderr_text = tokio::time::timeout(CHILD_GRACE, err_task)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    if let Some(p) = pid {
        lock(&shared.pids).remove(&p);
    }
    // Se registra el fallo ANTES de soltar el socket del cliente (`cw`/`cr` se sueltan al
    // salir): así quien vio caer la conexión ya encuentra la causa.
    if to_client == 0 && !stderr_text.trim().is_empty() {
        let failure = classify_ssh_stderr(&stderr_text).unwrap_or_else(|| Failure {
            cause: engine_core::ConnectionCause::Other,
            message: format!("falló la conexión SSH ({})", sanitize_detail(&stderr_text)),
        });
        *lock(&shared.failure) = Some(failure);
    } else if to_client == 0 && status.is_some_and(|s| !s.success()) {
        *lock(&shared.failure) = Some(Failure {
            cause: engine_core::ConnectionCause::Other,
            message: "ssh terminó sin datos".into(),
        });
    }
}
