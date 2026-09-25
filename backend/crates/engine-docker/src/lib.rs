//! Adaptador de `EngineClient` sobre la Docker Engine API usando `bollard`.

mod convert;
mod diagnose;
mod error_map;
mod logs;
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
}

impl Endpoint {
    pub fn display(&self) -> String {
        match self {
            Endpoint::Unix(p) => format!("unix://{p}"),
            Endpoint::Host(h) => h.clone(),
        }
    }
}

/// Resuelve el endpoint: `DOCKER_HOST` -> `/var/run/docker.sock` -> socket rootless
/// `$XDG_RUNTIME_DIR/docker.sock`. Función pura (el entorno entra como parámetros).
pub fn resolve_endpoint(
    docker_host: Option<&str>,
    xdg_runtime_dir: Option<&str>,
    exists: impl Fn(&str) -> bool,
) -> Endpoint {
    if let Some(h) = docker_host.filter(|h| !h.is_empty()) {
        return match h.strip_prefix("unix://") {
            Some(p) => Endpoint::Unix(p.to_string()),
            None => Endpoint::Host(h.to_string()),
        };
    }
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
    endpoint: Mutex<Endpoint>,
    /// Si el socket viene fijado (tests), no se vuelve a resolver el entorno.
    fixed: bool,
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
        Self::build(Self::resolve_from_env(), false)
    }

    /// Fija un socket concreto (tests y diagnóstico).
    pub fn with_socket(path: &str) -> Self {
        Self::build(Endpoint::Unix(path.to_string()), true)
    }

    fn resolve_from_env() -> Endpoint {
        resolve_endpoint(
            std::env::var("DOCKER_HOST").ok().as_deref(),
            std::env::var("XDG_RUNTIME_DIR").ok().as_deref(),
            |p| std::path::Path::new(p).exists(),
        )
    }

    fn build(endpoint: Endpoint, fixed: bool) -> Self {
        Self {
            inner: Arc::new(Inner {
                docker: Mutex::new(None),
                endpoint: Mutex::new(endpoint),
                fixed,
                negotiated: AtomicBool::new(false),
            }),
        }
    }

    pub fn endpoint(&self) -> Endpoint {
        self.inner
            .endpoint
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn connect(&self) -> Result<Docker, EngineError> {
        let endpoint = self.endpoint();
        let docker = match &endpoint {
            Endpoint::Unix(p) => {
                Docker::connect_with_unix(p, SHORT_TIMEOUT.as_secs(), bollard::API_DEFAULT_VERSION)
            }
            Endpoint::Host(_) => {
                Docker::connect_with_defaults().map(|d| d.with_timeout(SHORT_TIMEOUT))
            }
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
        if !self.inner.fixed {
            *self
                .inner
                .endpoint
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Self::resolve_from_env();
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
        let display = endpoint.display();
        let (mut steps, sock_cause) = match &endpoint {
            Endpoint::Unix(p) => diagnose::check_unix_socket(p).await,
            Endpoint::Host(_) => (
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
    fn endpoint_prioridad_env_defecto_y_rootless() {
        let none = |_: &str| false;
        assert_eq!(
            resolve_endpoint(Some("unix:///x.sock"), None, none),
            Endpoint::Unix("/x.sock".into())
        );
        assert_eq!(
            resolve_endpoint(Some("tcp://h:2375"), None, |_| true),
            Endpoint::Host("tcp://h:2375".into())
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
