//! Adaptador de `EngineClient` sobre la Docker Engine API usando `bollard`.

mod convert;
mod create;
mod diagnose;
mod error_map;
mod exec;
mod logs;
mod podman;
mod pull;
mod registry;
mod stacks;
mod stats;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bollard::Docker;
use bollard::container::LogOutput;
use bollard::query_parameters::{
    DataUsageOptions, EventsOptionsBuilder, ListContainersOptionsBuilder, ListImagesOptionsBuilder,
    ListNetworksOptions, ListVolumesOptions, LogsOptionsBuilder, RemoveContainerOptionsBuilder,
    RemoveImageOptionsBuilder, RemoveVolumeOptionsBuilder, StatsOptionsBuilder,
};
use engine_core::{
    ConnectionCause, ConnectionStatus, Container, ContainerDetail, ContainerStats, EngineClient,
    EngineError, EngineEvent, EngineInfo, EngineStream, Image, LogLine, LogStream, LogsRequest,
    Network, SystemUsage, Volume, validate,
};
use futures_util::{StreamExt, stream};

pub use error_map::{classify, from_status};
pub use logs::{LineAssembler, MAX_LINE_BYTES};
pub use podman::{PodmanCandidate, PodmanEnv, detect_podman, detect_podman_host};
pub use stats::StatsTracker;

/// Timeout de las llamadas cortas (solo hasta recibir cabeceras).
const SHORT_TIMEOUT: Duration = Duration::from_secs(15);
/// `stop`/`restart` pueden tardar hasta el `stop_timeout` del contenedor.
const LONG_TIMEOUT: Duration = Duration::from_secs(120);
/// Borrar un contenedor con mucho estado puede tardar.
const REMOVE_TIMEOUT: Duration = Duration::from_secs(60);
/// `df` puede ser lento con muchos volúmenes: si expira, el tamaño queda desconocido.
const DF_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_SOCKET: &str = "/var/run/docker.sock";

/// Volúmenes -> contenedores, redes -> contenedores, imagen -> nº de contenedores.
type UsageMaps = (
    HashMap<String, Vec<String>>,
    HashMap<String, Vec<String>>,
    HashMap<String, u32>,
);

/// Dónde está el daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
    /// Socket Unix local (ruta sin `unix://`).
    Unix(String),
    /// Cualquier otro `DOCKER_HOST` (tcp://, ...): lo resuelve bollard.
    Host(String),
    /// Socket Unix privado de un túnel SSH hacia un daemon remoto. `label` es el nombre
    /// legible para la UI (`ssh://usuario@host:puerto`).
    Tunnel { socket: String, label: String },
    /// Daemon remoto por TLS mutuo. Solo RUTAS de certificados; `cert_dir` es un directorio
    /// privado con enlaces `ca.pem`/`cert.pem`/`key.pem` para los subprocesos de Docker.
    Tls {
        addr: String,
        ca: String,
        cert: String,
        key: String,
        cert_dir: String,
        label: String,
    },
}

impl Endpoint {
    /// Valor utilizable como `DOCKER_HOST` por los subprocesos (Compose, build).
    pub fn display(&self) -> String {
        match self {
            Endpoint::Unix(p) | Endpoint::Tunnel { socket: p, .. } => format!("unix://{p}"),
            Endpoint::Host(h) => h.clone(),
            Endpoint::Tls { addr, .. } => addr.clone(),
        }
    }

    /// Nombre para mostrar al usuario (un túnel no debe enseñar la ruta de su socket).
    pub fn label(&self) -> String {
        match self {
            Endpoint::Tunnel { label, .. } | Endpoint::Tls { label, .. } => label.clone(),
            other => other.display(),
        }
    }

    /// Variables de entorno adicionales que necesitan los subprocesos de Docker.
    pub fn docker_env(&self) -> Vec<(String, String)> {
        match self {
            Endpoint::Tls { cert_dir, .. } => vec![
                ("DOCKER_TLS_VERIFY".into(), "1".into()),
                ("DOCKER_CERT_PATH".into(), cert_dir.clone()),
            ],
            _ => Vec::new(),
        }
    }

    /// ¿Apunta a un daemon en otra máquina?
    pub fn is_remote(&self) -> bool {
        matches!(self, Endpoint::Tunnel { .. } | Endpoint::Tls { .. })
    }
}

/// Pista de fallo del transporte (p. ej. stderr clasificado de `ssh`): permite explicar por
/// qué cayó una conexión remota con una causa más precisa que el error de socket.
pub type FailureHint = Arc<dyn Fn() -> Option<(ConnectionCause, String)> + Send + Sync>;

/// Destino del motor: endpoint + si está fijado (no se re-resuelve el entorno) + pista.
#[derive(Clone)]
pub struct Target {
    endpoint: Endpoint,
    fixed: bool,
    hint: Option<FailureHint>,
}

impl Target {
    /// Motor local integrado: se resuelve del entorno (`DOCKER_HOST`, socket por defecto).
    pub fn local() -> Self {
        Self {
            endpoint: DockerEngine::resolve_from_env(),
            fixed: false,
            hint: None,
        }
    }

    /// Socket Unix local concreto (Podman, sockets personalizados).
    pub fn socket(path: &str) -> Self {
        Self {
            endpoint: Endpoint::Unix(path.to_string()),
            fixed: true,
            hint: None,
        }
    }

    /// Túnel SSH ya levantado.
    pub fn tunnel(socket: &str, label: &str, hint: Option<FailureHint>) -> Self {
        Self {
            endpoint: Endpoint::Tunnel {
                socket: socket.to_string(),
                label: label.to_string(),
            },
            fixed: true,
            hint,
        }
    }

    /// TLS mutuo con certificados por ruta.
    pub fn tls(endpoint: Endpoint) -> Self {
        Self {
            endpoint,
            fixed: true,
            hint: None,
        }
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }
}

/// Resuelve el endpoint: sockets Unix explícitos son válidos; `tcp://` solo se acepta cuando
/// llega por una conexión TLS explícita (`Target::tls`). Un `DOCKER_HOST=tcp://...` heredado no
/// puede demostrar cifrado/autenticación y se ignora para evitar una conexión en texto claro.
/// Después se prueban `/var/run/docker.sock` y el socket rootless.
pub fn resolve_endpoint(
    docker_host: Option<&str>,
    xdg_runtime_dir: Option<&str>,
    exists: impl Fn(&str) -> bool,
) -> Endpoint {
    if let Some(h) = docker_host.filter(|h| !h.is_empty()) {
        return match h.strip_prefix("unix://") {
            Some(p) => Endpoint::Unix(p.to_string()),
            None if h.starts_with("tcp://") => fallback_endpoint(xdg_runtime_dir, exists),
            None => Endpoint::Host(h.to_string()),
        };
    }
    fallback_endpoint(xdg_runtime_dir, exists)
}

fn fallback_endpoint(xdg_runtime_dir: Option<&str>, exists: impl Fn(&str) -> bool) -> Endpoint {
    if exists(DEFAULT_SOCKET) {
        return Endpoint::Unix(DEFAULT_SOCKET.into());
    }
    if let Some(dir) = xdg_runtime_dir.filter(|d| !d.is_empty()) {
        let rootless = format!("{dir}/docker.sock");
        if exists(&rootless) {
            return Endpoint::Unix(rootless);
        }
    }
    Endpoint::Unix(DEFAULT_SOCKET.into())
}

struct Inner {
    docker: Mutex<Option<Docker>>,
    /// Destino actual: se puede cambiar en caliente con `set_target` sin reconstruir nada
    /// (todos los servicios comparten este mismo motor).
    target: Mutex<Target>,
    negotiated: AtomicBool,
}

/// Motor Docker. Se construye sin fallar: si no hay socket, cada llamada reintenta conectar.
#[derive(Clone)]
pub struct DockerEngine {
    inner: Arc<Inner>,
}

impl Default for DockerEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl DockerEngine {
    /// Nunca falla ni entra en panic, aunque no exista el socket.
    pub fn new() -> Self {
        Self::build(Target::local())
    }

    /// Fija un socket concreto (tests y diagnóstico).
    pub fn with_socket(path: &str) -> Self {
        Self::build(Target::socket(path))
    }

    fn resolve_from_env() -> Endpoint {
        resolve_endpoint(
            std::env::var("DOCKER_HOST").ok().as_deref(),
            std::env::var("XDG_RUNTIME_DIR").ok().as_deref(),
            |p| std::path::Path::new(p).exists(),
        )
    }

    fn build(target: Target) -> Self {
        Self {
            inner: Arc::new(Inner {
                docker: Mutex::new(None),
                target: Mutex::new(target),
                negotiated: AtomicBool::new(false),
            }),
        }
    }

    fn target_lock(&self) -> std::sync::MutexGuard<'_, Target> {
        self.inner.target.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn endpoint(&self) -> Endpoint {
        self.target_lock().endpoint.clone()
    }

    /// Cambia el destino en caliente y devuelve el anterior (para revertir si la conexión
    /// nueva falla). Descarta el cliente cacheado; los `Arc` que comparten este motor siguen
    /// siendo válidos. Quien lo llame debe abortar antes las suscripciones en curso.
    pub fn set_target(&self, target: Target) -> Target {
        let previous = std::mem::replace(&mut *self.target_lock(), target);
        *self.inner.docker.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.inner.negotiated.store(false, Ordering::Relaxed);
        previous
    }

    /// Endpoint REAL para subprocesos (`docker build`, Compose): el valor de `DOCKER_HOST`
    /// (socket del túnel o `tcp://` con TLS) y las variables extra (`DOCKER_TLS_VERIFY`,
    /// `DOCKER_CERT_PATH`). Nunca la etiqueta de la UI (`ssh://...`), que haría que el CLI de
    /// docker abriera su propio ssh saltándose el modelo de seguridad.
    pub fn subprocess_env(&self) -> (String, Vec<(String, String)>) {
        let ep = self.endpoint();
        (ep.display(), ep.docker_env())
    }

    /// Destino actual (para restaurarlo con `set_target`).
    pub fn target(&self) -> Target {
        self.target_lock().clone()
    }

    fn failure_hint(&self) -> Option<(ConnectionCause, String)> {
        let hint = self.target_lock().hint.clone();
        hint.and_then(|h| h())
    }

    fn connect(&self) -> Result<Docker, EngineError> {
        let endpoint = self.endpoint();
        let docker = match &endpoint {
            Endpoint::Unix(p) | Endpoint::Tunnel { socket: p, .. } => {
                Docker::connect_with_unix(p, SHORT_TIMEOUT.as_secs(), bollard::API_DEFAULT_VERSION)
            }
            Endpoint::Host(_) => {
                Docker::connect_with_defaults().map(|d| d.with_timeout(SHORT_TIMEOUT))
            }
            Endpoint::Tls {
                addr,
                ca,
                cert,
                key,
                ..
            } => Docker::connect_with_ssl(
                addr,
                std::path::Path::new(key),
                std::path::Path::new(cert),
                std::path::Path::new(ca),
                SHORT_TIMEOUT.as_secs(),
                bollard::API_DEFAULT_VERSION,
            ),
        };
        docker.map_err(|e| error_map::classify(&e))
    }

    /// Cliente listo para usar: conecta la primera vez (y reintenta mientras falle).
    async fn client(&self) -> Result<Docker, EngineError> {
        let cached = self
            .inner
            .docker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let docker = match cached {
            Some(d) => d,
            None => {
                let d = self.connect()?;
                *self.inner.docker.lock().unwrap_or_else(|e| e.into_inner()) = Some(d.clone());
                d
            }
        };
        // Negocia la versión de API una vez (los clones comparten el contador de versión).
        if !self.inner.negotiated.load(Ordering::Relaxed)
            && docker.clone().negotiate_version().await.is_ok()
        {
            self.inner.negotiated.store(true, Ordering::Relaxed);
        }
        Ok(docker)
    }

    /// Descarta el cliente y vuelve a resolver el endpoint (el socket pudo aparecer luego).
    fn reset(&self) {
        *self.inner.docker.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.inner.negotiated.store(false, Ordering::Relaxed);
        let mut target = self.target_lock();
        if !target.fixed {
            target.endpoint = Self::resolve_from_env();
        }
    }

    /// Mapa nombre de recurso -> nombres de contenedores que lo usan.
    fn usage_maps(containers: &[Container]) -> UsageMaps {
        let (mut vols, mut nets, mut imgs) = (
            HashMap::<String, Vec<String>>::new(),
            HashMap::<String, Vec<String>>::new(),
            HashMap::<String, u32>::new(),
        );
        for c in containers {
            let name = c.names.first().cloned().unwrap_or_else(|| c.id.clone());
            for m in &c.mounts {
                if let (engine_core::MountKind::Volume, Some(n)) = (m.kind, &m.name) {
                    let v = vols.entry(n.clone()).or_default();
                    if !v.contains(&name) {
                        v.push(name.clone());
                    }
                }
            }
            for n in &c.networks {
                nets.entry(n.clone()).or_default().push(name.clone());
            }
            *imgs.entry(c.image_id.clone()).or_default() += 1;
        }
        (vols, nets, imgs)
    }
}

fn map<T>(r: Result<T, bollard::errors::Error>) -> Result<T, EngineError> {
    r.map_err(|e| error_map::classify(&e))
}

#[async_trait]
impl EngineClient for DockerEngine {
    fn is_remote(&self) -> bool {
        self.target_lock().endpoint.is_remote()
    }

    async fn ping(&self) -> Result<(), EngineError> {
        let d = self.client().await?;
        map(d.ping().await).map(|_| ())
    }

    async fn info(&self) -> Result<EngineInfo, EngineError> {
        let d = self.client().await?;
        let v = map(d.version().await)?;
        Ok(EngineInfo {
            version: v.version.unwrap_or_default(),
            api_version: v.api_version.unwrap_or_default(),
            os: v.os.unwrap_or_default(),
            arch: v.arch.unwrap_or_default(),
        })
    }

    async fn system_usage(&self) -> Result<SystemUsage, EngineError> {
        let d = self.client().await?;
        let info = map(d.info().await)?;
        let host = engine_core::HostResources {
            cpu_count: info.ncpu.unwrap_or(0).max(0) as u32,
            mem_total_bytes: info.mem_total.unwrap_or(0).max(0) as u64,
        };
        // `df` falla o expira => disco desconocido (`disk_known = false`), no es un error: el resto sigue valiendo.
        let (disk, container_disk, disk_known) =
            match tokio::time::timeout(DF_TIMEOUT, d.df(None::<DataUsageOptions>)).await {
                Ok(Ok(r)) => convert::disk_from_df(&r),
                _ => (engine_core::DiskUsage::default(), Vec::new(), false),
            };
        Ok(SystemUsage {
            host,
            disk,
            container_disk,
            disk_known,
        })
    }

    async fn diagnose(&self) -> ConnectionStatus {
        let endpoint = self.endpoint();
        // Lo que ve el usuario: un túnel muestra su destino (`ssh://...`), no la ruta del socket.
        let display = endpoint.label();
        let (mut steps, sock_cause) = match &endpoint {
            Endpoint::Unix(p) => diagnose::check_unix_socket(p).await,
            Endpoint::Tunnel { socket, .. } => diagnose::check_tunnel(socket, &display),
            Endpoint::Host(_) | Endpoint::Tls { .. } => (
                vec![
                    engine_core::DiagStep {
                        id: engine_core::DiagStepId::Socket,
                        status: engine_core::StepStatus::Skipped,
                        detail: display.clone(),
                    },
                    engine_core::DiagStep {
                        id: engine_core::DiagStepId::Permissions,
                        status: engine_core::StepStatus::Skipped,
                        detail: String::new(),
                    },
                ],
                None,
            ),
        };
        let earlier_failed = sock_cause.is_some();
        // Si el socket ya falló, ni se intenta hablar con el daemon (evita esperas inútiles).
        // `info` implica que el daemon responde: una sola llamada basta.
        let info = if earlier_failed {
            None
        } else {
            Some(self.info().await)
        };
        let ping: Result<(), EngineError> = match &info {
            Some(Ok(_)) | None => Ok(()),
            Some(Err(e)) => Err(e.clone()),
        };
        steps.push(diagnose::daemon_step(&ping, earlier_failed));
        if let Some(Ok(server)) = info {
            return ConnectionStatus::Connected {
                endpoint: display,
                server,
            };
        }
        let (cause, message) = match (sock_cause, ping) {
            (Some(c), _) => {
                let detail = steps
                    .iter()
                    .find(|s| s.status == engine_core::StepStatus::Fail)
                    .map(|s| s.detail.clone())
                    .unwrap_or_default();
                (c, detail)
            }
            (None, Err(EngineError::Connection { cause, message })) => (cause, message),
            (None, Err(e)) => (ConnectionCause::Other, e.to_string()),
            (None, Ok(())) => (ConnectionCause::Other, "respuesta inesperada".into()),
        };
        // En remoto, el transporte (stderr de ssh) sabe mejor que el socket por qué falló.
        let (cause, message) = match endpoint.is_remote().then(|| self.failure_hint()).flatten() {
            Some((c, m)) => (c, m),
            None => (cause, message),
        };
        ConnectionStatus::Failed {
            endpoint: display,
            cause,
            message,
            steps,
        }
    }

    async fn reconnect(&self) -> ConnectionStatus {
        self.reset();
        self.diagnose().await
    }

    async fn list_containers(&self, all: bool) -> Result<Vec<Container>, EngineError> {
        let d = self.client().await?;
        let options = ListContainersOptionsBuilder::default().all(all).build();
        let list = map(d.list_containers(Some(options)).await)?;
        Ok(list
            .into_iter()
            .map(convert::container_from_summary)
            .collect())
    }

    async fn inspect_container(&self, id: &str) -> Result<ContainerDetail, EngineError> {
        validate::container_id(id)?;
        let d = self.client().await?;
        let inspect = map(d.inspect_container(id, None).await)?;
        let full_id = inspect.id.clone().unwrap_or_default();
        // La fila de la lista da el resumen exacto (puertos, estado, etiquetas).
        let filters = HashMap::from([("id".to_string(), vec![full_id.clone()])]);
        let options = ListContainersOptionsBuilder::default()
            .all(true)
            .filters(&filters)
            .build();
        let row = map(d.list_containers(Some(options)).await)?
            .into_iter()
            .find(|c| c.id.as_deref() == Some(full_id.as_str()))
            .ok_or_else(|| EngineError::NotFound(id.to_string()))?;
        Ok(convert::detail_from_inspect(
            convert::container_from_summary(row),
            inspect,
        ))
    }

    async fn start_container(&self, id: &str) -> Result<(), EngineError> {
        validate::container_id(id)?;
        let d = self.client().await?;
        map(d.start_container(id, None).await)
    }

    async fn stop_container(&self, id: &str) -> Result<(), EngineError> {
        validate::container_id(id)?;
        let d = self.client().await?.with_timeout(LONG_TIMEOUT);
        map(d.stop_container(id, None).await)
    }

    async fn restart_container(&self, id: &str) -> Result<(), EngineError> {
        validate::container_id(id)?;
        let d = self.client().await?.with_timeout(LONG_TIMEOUT);
        map(d.restart_container(id, None).await)
    }

    async fn remove_container(&self, id: &str, force: bool) -> Result<(), EngineError> {
        validate::container_id(id)?;
        // Un borrado lento (contenedor grande) no debe reportar error mientras sigue en curso.
        let d = self.client().await?.with_timeout(REMOVE_TIMEOUT);
        // `v=false` explícito: los volúmenes con nombre nunca se borran con el contenedor.
        let options = RemoveContainerOptionsBuilder::default()
            .v(false)
            .force(force)
            .link(false)
            .build();
        map(d.remove_container(id, Some(options)).await)
    }

    async fn stats_snapshot(&self, id: &str) -> Result<ContainerStats, EngineError> {
        validate::container_id(id)?;
        let d = self.client().await?;
        // stream=false trae `precpu_stats`; `one_shot` no lo llena.
        let options = StatsOptionsBuilder::default()
            .stream(false)
            .one_shot(false)
            .build();
        let mut s = Box::pin(d.stats(id, Some(options)));
        match s.next().await {
            Some(r) => Ok(StatsTracker::new().sample(&map(r)?, Instant::now())),
            None => Err(EngineError::Protocol(
                "el daemon no devolvió estadísticas".into(),
            )),
        }
    }

    async fn list_images(&self) -> Result<Vec<Image>, EngineError> {
        let d = self.client().await?;
        let options = ListImagesOptionsBuilder::default().all(false).build();
        let (images, containers) =
            tokio::join!(d.list_images(Some(options)), self.list_containers(true));
        let images = map(images)?;
        // Si no se puede saber qué contenedores usan cada imagen, NO se inventa `containers=0`
        // (un prune las incluiría todas): el error se propaga y el plan aborta.
        let counts = Self::usage_maps(&containers?).2;
        Ok(images
            .into_iter()
            .flat_map(|i| convert::images_from_summary(i, &counts))
            .collect())
    }

    async fn remove_image(&self, reference: &str) -> Result<(), EngineError> {
        validate::image_reference(reference)?;
        let d = self.client().await?;
        let options = RemoveImageOptionsBuilder::default()
            .force(false)
            .noprune(false)
            .build();
        map(d.remove_image(reference, Some(options), None).await).map(|_| ())
    }

    async fn list_volumes(&self) -> Result<Vec<Volume>, EngineError> {
        let d = self.client().await?;
        let df = async {
            // `df` falla o expira => tamaños desconocidos, no es un error.
            match tokio::time::timeout(DF_TIMEOUT, d.df(None::<DataUsageOptions>)).await {
                Ok(Ok(r)) => r
                    .volume_usage
                    .and_then(|u| u.items)
                    .map(|items| convert::volume_sizes_from_df(&items))
                    .unwrap_or_default(),
                _ => HashMap::new(),
            }
        };
        let (vols, containers, sizes) = tokio::join!(
            d.list_volumes(None::<ListVolumesOptions>),
            self.list_containers(true),
            df
        );
        let vols = map(vols)?.volumes.unwrap_or_default();
        // Sin el uso real no se devuelve `used_by=[]`: se propaga el error.
        let used = Self::usage_maps(&containers?).0;
        let mut out: Vec<Volume> = vols
            .into_iter()
            .map(|v| convert::volume_from(v, &sizes, &used))
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn inspect_volume(&self, name: &str) -> Result<Volume, EngineError> {
        validate::volume_name(name)?;
        let d = self.client().await?;
        let v = map(d.inspect_volume(name).await)?;
        let used = Self::usage_maps(&self.list_containers(true).await?).0;
        Ok(convert::volume_from(v, &HashMap::new(), &used))
    }

    async fn remove_volume(&self, name: &str) -> Result<(), EngineError> {
        validate::volume_name(name)?;
        let d = self.client().await?;
        // Sin force: Docker rechaza el volumen en uso.
        let options = RemoveVolumeOptionsBuilder::default().force(false).build();
        map(d.remove_volume(name, Some(options)).await)
    }

    async fn list_networks(&self) -> Result<Vec<Network>, EngineError> {
        let d = self.client().await?;
        let (nets, containers) = tokio::join!(
            d.list_networks(None::<ListNetworksOptions>),
            self.list_containers(true)
        );
        let nets = map(nets)?;
        // Sin el uso real no se devuelve `connected=[]`: se propaga el error.
        let connected = Self::usage_maps(&containers?).1;
        let mut out: Vec<Network> = nets
            .into_iter()
            .map(|n| convert::network_from(n, &connected))
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn remove_network(&self, id: &str) -> Result<(), EngineError> {
        validate::container_id(id)?;
        let d = self.client().await?;
        map(d.remove_network(id).await)
    }

    fn events(&self) -> EngineStream<EngineEvent> {
        let this = self.clone();
        Box::pin(
            stream::once(async move { this.client().await }).flat_map(|client| match client {
                Err(e) => stream::once(async move { Err(e) }).boxed(),
                Ok(d) => {
                    let filters = HashMap::from([(
                        "type".to_string(),
                        vec!["container", "image", "volume", "network"]
                            .into_iter()
                            .map(String::from)
                            .collect::<Vec<_>>(),
                    )]);
                    // Sin `since`: solo eventos nuevos.
                    let options = EventsOptionsBuilder::default().filters(&filters).build();
                    d.events(Some(options))
                        .filter_map(|r| async move {
                            match r {
                                Ok(m) => convert::event_from(m).map(Ok),
                                Err(e) => Some(Err(error_map::classify(&e))),
                            }
                        })
                        .boxed()
                }
            }),
        )
    }

    fn logs(&self, id: &str, req: LogsRequest) -> EngineStream<LogLine> {
        let this = self.clone();
        let id = id.to_string();
        Box::pin(
            stream::once(async move {
                validate::container_id(&id)?;
                Ok((this.client().await?, id))
            })
            .flat_map(
                move |setup: Result<(Docker, String), EngineError>| match setup {
                    Err(e) => stream::once(async move { Err(e) }).boxed(),
                    Ok((d, id)) => {
                        // Siempre stdout+stderr (el default de bollard es ninguno) y timestamps.
                        let mut b = LogsOptionsBuilder::default()
                            .stdout(true)
                            .stderr(true)
                            .timestamps(true)
                            .follow(req.follow)
                            .tail(&req.effective_tail().to_string());
                        if let Some(s) = req.since {
                            b = b.since(s);
                        }
                        let mut asm = LineAssembler::new();
                        d.logs(&id, Some(b.build()))
                            .map(Some)
                            .chain(stream::once(async { None }))
                            .flat_map(move |item| {
                                let out: Vec<Result<LogLine, EngineError>> = match item {
                                    None => asm.finish().into_iter().map(Ok).collect(),
                                    Some(Err(e)) => vec![Err(error_map::classify(&e))],
                                    Some(Ok(frame)) => {
                                        let (s, m) = match &frame {
                                            LogOutput::StdOut { message } => {
                                                (LogStream::Stdout, message)
                                            }
                                            LogOutput::StdErr { message } => {
                                                (LogStream::Stderr, message)
                                            }
                                            LogOutput::Console { message } => {
                                                (LogStream::Console, message)
                                            }
                                            LogOutput::StdIn { .. } => return stream::iter(vec![]),
                                        };
                                        asm.push(s, m).into_iter().map(Ok).collect()
                                    }
                                };
                                stream::iter(out)
                            })
                            .boxed()
                    }
                },
            ),
        )
    }

    fn stats(&self, id: &str) -> EngineStream<ContainerStats> {
        let this = self.clone();
        let id = id.to_string();
        Box::pin(
            stream::once(async move {
                validate::container_id(&id)?;
                Ok((this.client().await?, id))
            })
            .flat_map(|setup: Result<(Docker, String), EngineError>| match setup {
                Err(e) => stream::once(async move { Err(e) }).boxed(),
                Ok((d, id)) => {
                    let options = StatsOptionsBuilder::default()
                        .stream(true)
                        .one_shot(false)
                        .build();
                    let mut tracker = StatsTracker::new();
                    d.stats(&id, Some(options))
                        .map(move |r| match r {
                            Ok(s) => Ok(tracker.sample(&s, Instant::now())),
                            Err(e) => Err(error_map::classify(&e)),
                        })
                        .boxed()
                }
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_remoto_display_etiqueta_y_entorno() {
        let tunnel = Endpoint::Tunnel {
            socket: "/run/user/1000/dockinng/tunnels/a.sock".into(),
            label: "ssh://deploy@h:22".into(),
        };
        // Los subprocesos usan el socket del túnel; la UI muestra el destino, no la ruta.
        assert_eq!(
            tunnel.display(),
            "unix:///run/user/1000/dockinng/tunnels/a.sock"
        );
        assert_eq!(tunnel.label(), "ssh://deploy@h:22");
        assert!(tunnel.is_remote() && tunnel.docker_env().is_empty());
        let tls = Endpoint::Tls {
            addr: "tcp://h:2376".into(),
            ca: "/c/ca.pem".into(),
            cert: "/c/cert.pem".into(),
            key: "/c/key.pem".into(),
            cert_dir: "/run/x".into(),
            label: "tls://h:2376".into(),
        };
        assert_eq!(tls.display(), "tcp://h:2376");
        assert_eq!(
            tls.docker_env(),
            vec![
                ("DOCKER_TLS_VERIFY".to_string(), "1".to_string()),
                ("DOCKER_CERT_PATH".to_string(), "/run/x".to_string())
            ]
        );
        let local = Endpoint::Unix("/var/run/docker.sock".into());
        assert!(!local.is_remote() && local.docker_env().is_empty());
        assert_eq!(local.label(), local.display());
    }

    #[test]
    fn subprocess_env_del_tunel_es_el_socket_y_no_la_etiqueta() {
        let e = DockerEngine::with_socket("/nonexistent/local.sock");
        e.set_target(Target::tunnel("/run/x/t.sock", "ssh://u@h:22", None));
        let (host, env) = e.subprocess_env();
        assert_eq!(host, "unix:///run/x/t.sock");
        assert!(env.is_empty());
        e.set_target(Target::tls(Endpoint::Tls {
            addr: "tcp://h:2376".into(),
            ca: "/c".into(),
            cert: "/d".into(),
            key: "/k".into(),
            cert_dir: "/run/certs".into(),
            label: "tls://h:2376".into(),
        }));
        let (host, env) = e.subprocess_env();
        assert_eq!(host, "tcp://h:2376");
        assert!(env.contains(&("DOCKER_CERT_PATH".to_string(), "/run/certs".to_string())));
        assert!(env.contains(&("DOCKER_TLS_VERIFY".to_string(), "1".to_string())));
    }

    #[test]
    fn set_target_cambia_en_caliente_y_permite_restaurar() {
        let e = DockerEngine::with_socket("/nonexistent/local.sock");
        assert!(!EngineClient::is_remote(&e));
        let clone = e.clone();
        let previous = e.set_target(Target::tunnel("/nonexistent/t.sock", "ssh://x", None));
        // Todas las copias del motor comparten el destino nuevo.
        assert!(EngineClient::is_remote(&clone));
        assert_eq!(clone.endpoint().label(), "ssh://x");
        // Restaurar el destino anterior.
        e.set_target(previous);
        assert!(!EngineClient::is_remote(&clone));
        assert_eq!(
            clone.endpoint(),
            Endpoint::Unix("/nonexistent/local.sock".into())
        );
        // Un destino fijado no se re-resuelve del entorno al reconectar.
        e.reset();
        assert_eq!(
            e.endpoint(),
            Endpoint::Unix("/nonexistent/local.sock".into())
        );
    }

    #[tokio::test]
    async fn diagnostico_de_tunel_usa_la_pista_del_transporte() {
        let hint: FailureHint = Arc::new(|| {
            Some((
                ConnectionCause::AuthFailed,
                "el servidor rechazó la autenticación".into(),
            ))
        });
        let e = DockerEngine::with_socket("/nonexistent/local.sock");
        // Túnel cuyo socket no existe: el paso «socket» falla y la pista decide la causa.
        e.set_target(Target::tunnel("/nonexistent/t.sock", "ssh://x", Some(hint)));
        match e.diagnose().await {
            ConnectionStatus::Failed {
                endpoint,
                cause,
                message,
                ..
            } => {
                assert_eq!(endpoint, "ssh://x");
                assert_eq!(cause, ConnectionCause::AuthFailed);
                assert!(message.contains("autenticación"));
            }
            other => panic!("{other:?}"),
        }
        // Sin pista, la causa sale del socket del túnel ausente.
        e.set_target(Target::tunnel("/nonexistent/t.sock", "ssh://x", None));
        match e.diagnose().await {
            ConnectionStatus::Failed { cause, .. } => {
                assert_eq!(cause, ConnectionCause::Unreachable)
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn endpoint_prioridad_env_defecto_y_rootless() {
        let none = |_: &str| false;
        assert_eq!(
            resolve_endpoint(Some("unix:///x.sock"), None, none),
            Endpoint::Unix("/x.sock".into())
        );
        assert_eq!(
            resolve_endpoint(Some("tcp://h:2375"), None, |_| true),
            Endpoint::Unix(DEFAULT_SOCKET.into())
        );
        assert_eq!(
            resolve_endpoint(None, Some("/run/user/1000"), |p| p == DEFAULT_SOCKET),
            Endpoint::Unix(DEFAULT_SOCKET.into())
        );
        assert_eq!(
            resolve_endpoint(None, Some("/run/user/1000"), |p| p
                == "/run/user/1000/docker.sock"),
            Endpoint::Unix("/run/user/1000/docker.sock".into())
        );
        // Nada existe: se apunta al socket por defecto para reportar SocketMissing.
        assert_eq!(
            resolve_endpoint(None, Some("/run/user/1000"), none),
            Endpoint::Unix(DEFAULT_SOCKET.into())
        );
        assert_eq!(
            resolve_endpoint(Some(""), None, none),
            Endpoint::Unix(DEFAULT_SOCKET.into())
        );
    }
}
