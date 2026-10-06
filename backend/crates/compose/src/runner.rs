//! Ejecutor de `docker compose`: detección, comandos de lectura acotados y operaciones con
//! progreso en vivo, cancelación limpia (SIGTERM → 5 s → SIGKILL) y exclusión por proyecto.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use engine_core::{ApiError, ApiErrorCode};
use tokio::time::MissedTickBehavior;

use crate::args::{
    self, ComposeCmd, ConfigFiles, ProgressMode, ProjectSpec, docker_cli_command, version_command,
};
use crate::error::ComposeError;
use crate::files::ResolvedStack;
use crate::parse::{ConfigInfo, parse_config, parse_version};
use crate::proc::{ExitInfo, LineReader, Spawn, TokioSpawn, build_env, neutral_cwd, read_capped};
use crate::progress::{KnownService, Line, ProgressTracker, parse_line, parse_plain_line};
use crate::types::{
    ComposeFlavor, ComposeInfo, OpKind, StackOpFeed, StackOpKind, StackOrigin, StackOutcome,
    ValidationIssue,
};
use crate::validate::{MAX_MESSAGE_LEN, parse_issues, truncate};

pub use engine_core::{CancelSignal, StackSink};

/// Límites y tiempos (configurables para los tests).
#[derive(Debug, Clone)]
pub struct Limits {
    /// `config`, `version`, `ps`.
    pub read_timeout: Duration,
    pub up_timeout: Duration,
    pub pull_timeout: Duration,
    /// `down`, `stop`, `restart`, `start`.
    pub quick_timeout: Duration,
    pub term_grace: Duration,
    /// Tope de stdout de un comando de lectura.
    pub max_stdout: usize,
    /// Tope total de bytes de stderr de una operación.
    pub max_stderr_total: u64,
    pub flush_every: Duration,
    pub info_ttl: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            read_timeout: Duration::from_secs(20),
            up_timeout: Duration::from_secs(30 * 60),
            pull_timeout: Duration::from_secs(30 * 60),
            quick_timeout: Duration::from_secs(5 * 60),
            term_grace: Duration::from_secs(5),
            max_stdout: 4 * 1024 * 1024,
            max_stderr_total: 16 * 1024 * 1024,
            flush_every: Duration::from_millis(100),
            info_ttl: Duration::from_secs(60),
        }
    }
}

pub(crate) const MAX_PROGRESS_ITEMS: usize = 200;
const MAX_LOG_FEEDS: usize = 300;
const MAX_TEXT_BYTES: usize = 64 * 1024;

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Servicios declarados por stack: (marca de archivos, [(servicio, imagen)]).
pub(crate) type DeclaredCache = std::collections::HashMap<String, (String, Vec<(String, String)>)>;

pub(crate) struct Core {
    pub spawner: Arc<dyn Spawn>,
    /// Endpoint del daemon, leído en CADA lanzamiento (tras `reconnect` puede cambiar).
    pub endpoint: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// Tope de validaciones simultáneas (`config` sobre YAML no confiable).
    pub validate_sem: tokio::sync::Semaphore,
    pub limits: Limits,
    pub env_source: Mutex<Option<Vec<(std::ffi::OsString, std::ffi::OsString)>>>,
    pub info_cache: Mutex<Option<(Instant, ComposeInfo)>>,
    pub busy: Arc<Mutex<HashSet<String>>>,
    pub json_progress: AtomicBool,
    pub declared_cache: Mutex<DeclaredCache>,
    pub store: crate::files::StackStore,
    /// ¿El daemon es remoto? (X3: los bind mounts se resuelven en el FS remoto). Se lee en
    /// cada análisis porque el destino puede cambiar en caliente.
    pub remote_source: Mutex<Option<Arc<dyn Fn() -> bool + Send + Sync>>>,
    /// Variables extra por lanzamiento (TLS: `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`).
    pub extra_env_source: Mutex<Option<ExtraEnvSource>>,
}

/// Origen de variables de entorno extra para los subprocesos.
pub type ExtraEnvSource = Arc<dyn Fn() -> Vec<(String, String)> + Send + Sync>;

/// Ejecutor de Compose (barato de clonar).
#[derive(Clone)]
pub struct ComposeRunner {
    pub(crate) core: Arc<Core>,
}

/// Reserva de un proyecto: una sola operación a la vez por stack.
pub(crate) struct BusyGuard {
    set: Arc<Mutex<HashSet<String>>>,
    name: String,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        lock(&self.set).remove(&self.name);
    }
}

impl ComposeRunner {
    /// `endpoint`: el endpoint del daemon de DockInng; se fuerza como `DOCKER_HOST` del hijo.
    pub fn new(endpoint: impl Into<String>) -> Self {
        let store = crate::files::StackStore::with_default_root()
            .unwrap_or_else(|_| crate::files::StackStore::unavailable());
        Self::with_parts(
            Some(endpoint.into()),
            Arc::new(TokioSpawn),
            Limits::default(),
            store,
        )
    }

    pub fn with_parts(
        docker_host: Option<String>,
        spawner: Arc<dyn Spawn>,
        limits: Limits,
        store: crate::files::StackStore,
    ) -> Self {
        Self::with_endpoint_source(
            Arc::new(move || docker_host.clone()),
            spawner,
            limits,
            store,
        )
    }

    /// El endpoint se consulta en cada lanzamiento (p. ej. `engine.endpoint().display()`).
    pub fn with_endpoint_source(
        endpoint: Arc<dyn Fn() -> Option<String> + Send + Sync>,
        spawner: Arc<dyn Spawn>,
        limits: Limits,
        store: crate::files::StackStore,
    ) -> Self {
        Self {
            core: Arc::new(Core {
                spawner,
                endpoint,
                validate_sem: tokio::sync::Semaphore::new(2),
                limits,
                env_source: Mutex::new(None),
                info_cache: Mutex::new(None),
                busy: Arc::new(Mutex::new(HashSet::new())),
                json_progress: AtomicBool::new(true),
                declared_cache: Mutex::new(std::collections::HashMap::new()),
                store,
                remote_source: Mutex::new(None),
                extra_env_source: Mutex::new(None),
            }),
        }
    }

    pub fn store(&self) -> &crate::files::StackStore {
        &self.core.store
    }

    pub fn endpoint(&self) -> Option<String> {
        (self.core.endpoint)()
    }

    /// Indica si el daemon actual es remoto (aditivo: por defecto siempre local).
    pub fn set_remote_source(&self, f: Arc<dyn Fn() -> bool + Send + Sync>) {
        *lock(&self.core.remote_source) = Some(f);
    }

    /// Variables extra para cada subproceso (aditivo; p. ej. TLS de un daemon remoto).
    pub fn set_extra_env_source(&self, f: ExtraEnvSource) {
        *lock(&self.core.extra_env_source) = Some(f);
    }

    /// ¿El daemon es remoto ahora mismo?
    pub fn is_remote(&self) -> bool {
        self.core.is_remote()
    }

    /// Fija el entorno de origen (tests); por defecto se usa el del proceso.
    pub fn set_env_source(&self, vars: Vec<(std::ffi::OsString, std::ffi::OsString)>) {
        *lock(&self.core.env_source) = Some(vars);
    }
}

impl Core {
    pub(crate) fn is_remote(&self) -> bool {
        let f = lock(&self.remote_source).clone();
        f.is_some_and(|f| f())
    }

    fn child_env(&self) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
        let src = lock(&self.env_source).clone();
        let host = (self.endpoint)();
        let mut env = match src {
            Some(v) => build_env(v, host.as_deref()),
            None => build_env(std::env::vars_os(), host.as_deref()),
        };
        // Las variables extra del destino (TLS) mandan sobre las heredadas del proceso; y con
        // un destino sin TLS se descartan las heredadas para no desviar la conexión.
        let extra = lock(&self.extra_env_source).clone().map(|f| f());
        if let Some(extra) = extra {
            env.retain(|(k, _)| k != "DOCKER_TLS_VERIFY" && k != "DOCKER_CERT_PATH");
            env.extend(extra.into_iter().map(|(k, v)| (k.into(), v.into())));
        }
        env
    }

    /// Ejecuta un comando de lectura acotado (tiempo y tamaño).
    pub(crate) async fn capture(
        &self,
        spec: &args::CommandSpec,
        cwd: &Path,
        stdin: Option<Vec<u8>>,
        timeout: Duration,
    ) -> Result<Captured, ComposeError> {
        let env = self.child_env();
        let mut sp = self
            .spawner
            .spawn(spec, &env, cwd, stdin)
            .await
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    ComposeError::Missing("no se encontró el binario `docker`".into())
                } else {
                    ComposeError::io("lanzar docker", &e)
                }
            })?;
        let cap = self.limits.max_stdout;
        let work = async {
            let out = read_capped(sp.stdout, cap);
            let err = read_capped(sp.stderr, 64 * 1024);
            let (o, e) = tokio::join!(out, err);
            let (o, over_o) = o.map_err(|e| ComposeError::io("leer stdout", &e))?;
            let (e, _) = e.map_err(|e| ComposeError::io("leer stderr", &e))?;
            Ok::<_, ComposeError>((o, e, over_o))
        };
        match tokio::time::timeout(timeout, work).await {
            Err(_) => {
                terminate(&mut *sp.child, self.limits.term_grace).await;
                Err(ComposeError::Timeout)
            }
            Ok(Err(e)) => {
                terminate(&mut *sp.child, self.limits.term_grace).await;
                Err(e)
            }
            Ok(Ok((_, _, true))) => {
                terminate(&mut *sp.child, self.limits.term_grace).await;
                Err(ComposeError::OutputTooLarge)
            }
            Ok(Ok((o, e, false))) => {
                let exit = match tokio::time::timeout(self.limits.term_grace, sp.child.wait()).await
                {
                    Ok(r) => r.map_err(|e| ComposeError::io("esperar proceso", &e))?,
                    Err(_) => {
                        terminate(&mut *sp.child, self.limits.term_grace).await;
                        return Err(ComposeError::Timeout);
                    }
                };
                Ok(Captured {
                    exit,
                    stdout: String::from_utf8_lossy(&o).into_owned(),
                    stderr: String::from_utf8_lossy(&e).into_owned(),
                })
            }
        }
    }

    /// Detección de Compose (caché `info_ttl`; `recheck` la ignora).
    pub(crate) async fn info(&self, recheck: bool) -> ComposeInfo {
        if !recheck
            && let Some((at, info)) = lock(&self.info_cache).as_ref()
            && at.elapsed() < self.limits.info_ttl
        {
            return info.clone();
        }
        let info = self.detect().await;
        *lock(&self.info_cache) = Some((Instant::now(), info.clone()));
        info
    }

    async fn detect(&self) -> ComposeInfo {
        let t = Duration::from_secs(10);
        let cwd = neutral_cwd();
        let docker_cli = matches!(
            self.capture(&docker_cli_command(), &cwd, None, t).await,
            Ok(c) if c.exit.success()
        );
        let missing = ComposeInfo {
            available: false,
            flavor: ComposeFlavor::Missing,
            version: None,
            supported: false,
            docker_cli,
        };
        for flavor in [ComposeFlavor::Plugin, ComposeFlavor::Standalone] {
            let spec = version_command(flavor);
            if let Ok(c) = self.capture(&spec, &cwd, None, t).await
                && c.exit.success()
                && let Some((version, supported)) = parse_version(&c.stdout)
            {
                return ComposeInfo {
                    available: true,
                    flavor,
                    version: Some(version),
                    supported,
                    docker_cli,
                };
            }
            if flavor == ComposeFlavor::Standalone {
                // Compose v1 no entiende `--format json`: `docker-compose --version`.
                let legacy = args::CommandSpec {
                    program: "docker-compose".into(),
                    args: vec!["--version".into()],
                };
                if let Ok(c) = self.capture(&legacy, &cwd, None, t).await
                    && c.exit.success()
                    && let Some((version, supported)) = parse_version(&c.stdout)
                {
                    return ComposeInfo {
                        available: true,
                        flavor,
                        version: Some(version),
                        supported,
                        docker_cli,
                    };
                }
            }
        }
        missing
    }

    /// Info exigiendo un Compose utilizable.
    pub(crate) async fn require_compose(&self) -> Result<ComposeInfo, ComposeError> {
        let info = self.info(false).await;
        if !info.available {
            return Err(ComposeError::Missing(
                "Docker Compose no está instalado (plugin `docker compose`)".into(),
            ));
        }
        if !info.supported {
            return Err(ComposeError::Missing(format!(
                "Docker Compose {} no está soportado (se requiere v2 o superior)",
                info.version.as_deref().unwrap_or("desconocido")
            )));
        }
        Ok(info)
    }

    /// `config --format json` y su interpretación; los fallos salen como `Invalid(issues)`.
    /// Pre-escaneo de `include:` remotos antes de ejecutar `config` sobre YAML no confiable.
    fn reject_remote_includes(
        &self,
        project: &ProjectSpec,
        stdin: Option<&[u8]>,
    ) -> Result<(), ComposeError> {
        let base = project
            .project_dir
            .clone()
            .unwrap_or_else(|| PathBuf::from("."));
        // Textos a revisar con el directorio desde el que Compose resuelve sus rutas locales.
        // El tercer campo nombra el archivo cuando es un `include` anidado (para el mensaje).
        let mut pending: Vec<(String, PathBuf, Option<String>)> = Vec::new();
        if let Some(b) = stdin {
            pending.push((String::from_utf8_lossy(b).into_owned(), base.clone(), None));
        }
        if let ConfigFiles::Paths(paths) = &project.files {
            for p in paths {
                let dir = p
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| base.clone());
                if let Some(t) = read_for_scan(p)? {
                    pending.push((t, dir, None));
                }
            }
        }
        // Los `include` locales también se siguen: Compose los resuelve desde cada archivo incluido.
        let mut visited = HashSet::new();
        let mut revisados = 0usize;
        while let Some((text, dir, origen)) = pending.pop() {
            revisados += 1;
            if revisados > MAX_INCLUDE_FILES {
                return Err(include_issue(None, INCLUDE_DEMASIADOS, None));
            }
            let scan = crate::validate::scan_includes(&text);
            if let Some(line) = scan.remote_line {
                return Err(include_issue(Some(line), INCLUDE_REMOTO, origen.as_deref()));
            }
            if scan.unverifiable {
                return Err(include_issue(
                    None,
                    INCLUDE_NO_VERIFICABLE,
                    origen.as_deref(),
                ));
            }
            for rel in scan.local_paths {
                // Si no existe, Compose informará el error al ejecutarse.
                let Ok(canon) = std::fs::canonicalize(dir.join(&rel)) else {
                    continue;
                };
                if !visited.insert(canon.clone()) {
                    continue;
                }
                let child_dir = canon
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| base.clone());
                // Nombre relativo al proyecto, para que el usuario sepa en qué archivo está.
                let nombre = canon
                    .strip_prefix(&base)
                    .unwrap_or(&canon)
                    .display()
                    .to_string();
                if let Some(t) = read_for_scan(&canon)? {
                    pending.push((t, child_dir, Some(nombre)));
                }
            }
        }
        Ok(())
    }

    /// Sandbox de `include`, `extends.file` y `env_file`: ninguna ruta local (ni en los archivos
    /// incluidos) puede salir del directorio del proyecto. Ver `crate::sandbox`.
    fn reject_local_escape(
        &self,
        project: &ProjectSpec,
        stdin: Option<&[u8]>,
    ) -> Result<(), ComposeError> {
        let dir = project.project_dir.as_deref();
        let escape = match (stdin, &project.files) {
            (Some(b), _) => crate::sandbox::find_local_escape(&String::from_utf8_lossy(b), dir),
            (None, ConfigFiles::Paths(paths)) => paths
                .iter()
                .find_map(|p| crate::sandbox::find_local_escape_in_file(p, dir)),
            _ => None,
        };
        let Some(e) = escape else { return Ok(()) };
        let message = if e.in_included {
            "referencia local de un archivo incluido fuera del directorio del proyecto no permitida"
        } else {
            "referencia local fuera del directorio del proyecto no permitida"
        };
        Err(ComposeError::Invalid(vec![ValidationIssue {
            line: Some(e.line),
            column: None,
            kind: engine_core::IssueKind::Schema,
            message: message.into(),
        }]))
    }

    pub(crate) async fn config(
        &self,
        flavor: ComposeFlavor,
        project: &ProjectSpec,
        cwd: &Path,
        stdin: Option<Vec<u8>>,
        secrets: &[String],
    ) -> Result<ConfigInfo, ComposeError> {
        self.reject_remote_includes(project, stdin.as_deref())?;
        self.reject_local_escape(project, stdin.as_deref())?;
        let spec = args::build(flavor, project, &ComposeCmd::ConfigJson, ProgressMode::None);
        let c = self
            .capture(&spec, cwd, stdin, self.limits.read_timeout)
            .await?;
        if !c.exit.success() {
            let msg = redact(&c.stderr, secrets);
            let mut issues = parse_issues(&msg);
            if issues.is_empty() {
                issues.push(ValidationIssue {
                    line: None,
                    column: None,
                    kind: engine_core::IssueKind::Other,
                    message: match c.exit.code {
                        Some(n) => format!("Compose devolvió el código {n}"),
                        None => "Compose terminó por una señal".into(),
                    },
                });
            }
            return Err(ComposeError::Invalid(issues));
        }
        parse_config(&c.stdout)
    }

    pub(crate) fn acquire(&self, name: &str) -> Result<BusyGuard, ComposeError> {
        let mut set = lock(&self.busy);
        if !set.insert(name.to_string()) {
            return Err(ComposeError::Conflict(
                "ya hay una operación en curso para este stack".into(),
            ));
        }
        Ok(BusyGuard {
            set: self.busy.clone(),
            name: name.to_string(),
        })
    }
}

/// SIGTERM, espera `grace` y SIGKILL; no vuelve hasta que el proceso terminó (sin huérfanos).
async fn terminate(child: &mut dyn crate::proc::ChildHandle, grace: Duration) {
    child.term();
    if tokio::time::timeout(grace, child.wait()).await.is_err() {
        child.kill();
        let _ = child.wait().await;
    }
}

pub(crate) struct Captured {
    pub exit: ExitInfo,
    pub stdout: String,
    pub stderr: String,
}

/// Sustituye por `***` los valores del `.env` (≥ 4 caracteres) que aparezcan en un mensaje.
pub fn redact(message: &str, secrets: &[String]) -> String {
    let mut out = message.to_string();
    for s in secrets {
        if s.len() >= 4 {
            out = out.replace(s.as_str(), "***");
        }
    }
    out
}

/// Valores de un `.env` susceptibles de ser secretos (para `redact`).
pub fn env_secret_values(env: &str) -> Vec<String> {
    let mut v: Vec<String> = env
        .lines()
        .filter_map(|l| l.trim().split_once('='))
        .map(|(_, val)| val.trim().trim_matches(['"', '\'']).to_string())
        .filter(|s| s.len() >= 4)
        .collect();
    v.sort_by_key(|s| std::cmp::Reverse(s.len()));
    v.dedup();
    v
}

// ---------------------------------------------------------------------------------------------
// Operaciones con progreso
// ---------------------------------------------------------------------------------------------

/// Operación preparada: recursos validados y proyecto reservado. Se ejecuta con `run`.
pub struct PreparedOp {
    pub(crate) core: Arc<Core>,
    pub(crate) stack: String,
    pub(crate) kind: OpKind,
    pub(crate) services: Vec<String>,
    pub(crate) project: ProjectSpec,
    pub(crate) secrets: Vec<String>,
    pub(crate) info: ComposeInfo,
    pub(crate) _guard: BusyGuard,
}

struct Attempt {
    exit: Option<ExitInfo>,
    /// `Some(msg)` si llegó `{"error":true[,"message"]}`.
    final_error: Option<Option<String>>,
    texts: Vec<String>,
    saw_json: bool,
    timed_out: bool,
    canceled: bool,
    overflow: bool,
    spawn_failed: Option<String>,
}

fn looks_like_unsupported_progress(texts: &[String]) -> bool {
    texts.iter().any(|t| {
        let l = t.to_lowercase();
        l.contains("unknown flag: --progress")
            || l.contains("invalid argument \"json\"")
            || l.contains("unknown progress")
            || l.contains("--progress")
                && (l.contains("unknown") || l.contains("invalid") || l.contains("must be"))
    })
}

impl PreparedOp {
    fn timeout(&self) -> Duration {
        let l = &self.core.limits;
        match self.kind {
            OpKind::Lifecycle(StackOpKind::Up) => l.up_timeout,
            OpKind::Lifecycle(StackOpKind::Pull) => l.pull_timeout,
            _ => l.quick_timeout,
        }
    }

    /// Ejecuta la operación emitiendo `Started` … `Ended`. Siempre emite `Ended`.
    pub async fn execute(self, sink: StackSink, mut cancel: CancelSignal) {
        let ended = self.run_inner(&sink, &mut cancel).await;
        sink(ended);
    }

    async fn run_inner(&self, sink: &StackSink, cancel: &mut CancelSignal) -> StackOpFeed {
        let core = &self.core;
        let flavor = self.info.flavor;
        let cwd = self.project.project_dir.clone().unwrap_or_else(neutral_cwd);
        sink(StackOpFeed::Started {
            op: self.kind.as_str().to_string(),
            stack: self.stack.clone(),
            compose_version: self.info.version.clone().unwrap_or_default(),
        });

        // 0) Pre-escaneo común a todas las operaciones: `restart`, `stop`, `pull`… también cargan
        // el modelo de Compose (con sus `include`/`env_file`), aunque no se ejecute `config`.
        if let Err(e) = core
            .reject_remote_includes(&self.project, None)
            .and_then(|()| core.reject_local_escape(&self.project, None))
        {
            let issues = match &e {
                ComposeError::Invalid(i) => i.clone(),
                _ => vec![],
            };
            return ended(StackOutcome::Failed, None, Some(ApiError::from(&e)), issues);
        }

        // 1) `config`: falla rápido con líneas y da los servicios (y valida los pedidos).
        let track = matches!(self.kind, OpKind::Lifecycle(StackOpKind::Up));
        let need_config = track || !self.services.is_empty();
        let mut known: Vec<KnownService> = Vec::new();
        if need_config {
            let cfg_fut = core.config(flavor, &self.project, &cwd, None, &self.secrets);
            let cfg = tokio::select! {
                r = cfg_fut => r,
                _ = &mut *cancel => {
                    return ended(StackOutcome::Canceled, None, None, vec![]);
                }
            };
            match cfg {
                Ok(c) => {
                    for s in &self.services {
                        if !c.services.iter().any(|x| &x.name == s) {
                            return ended(
                                StackOutcome::Failed,
                                None,
                                Some(ApiError::new(
                                    ApiErrorCode::InvalidInput,
                                    format!("el servicio `{s}` no existe en este stack"),
                                )),
                                vec![],
                            );
                        }
                    }
                    known = c
                        .services
                        .into_iter()
                        .map(|s| KnownService {
                            name: s.name,
                            image: s.image,
                        })
                        .collect();
                }
                Err(e) => {
                    let issues = match &e {
                        ComposeError::Invalid(i) => i.clone(),
                        _ => vec![],
                    };
                    return ended(StackOutcome::Failed, None, Some(ApiError::from(&e)), issues);
                }
            }
        }

        // 2) Ejecución con progreso (json; si Compose no lo admite, una repetición en `plain`).
        let mut tracker = ProgressTracker::new(&self.project.name, known, track);
        let mut canceled = false;
        let mut mode = if core.json_progress.load(Ordering::Relaxed) {
            ProgressMode::Json
        } else {
            ProgressMode::Plain
        };
        let mut log_feeds = 0usize;
        let attempt = loop {
            let a = self
                .attempt(
                    mode,
                    &cwd,
                    &mut tracker,
                    sink,
                    cancel,
                    &mut canceled,
                    &mut log_feeds,
                )
                .await;
            let unsupported = mode == ProgressMode::Json
                && !a.canceled
                && !a.timed_out
                && a.spawn_failed.is_none()
                && !a.exit.is_some_and(|e| e.success())
                && !a.saw_json
                && looks_like_unsupported_progress(&a.texts);
            if unsupported {
                core.json_progress.store(false, Ordering::Relaxed);
                sink(StackOpFeed::Log {
                    text: "Esta versión de Compose no admite `--progress json`; se usa el modo de texto."
                        .into(),
                });
                mode = ProgressMode::Plain;
                continue;
            }
            break a;
        };
        flush(&mut tracker, sink);

        // 3) Resultado.
        let exit_code = attempt.exit.and_then(|e| e.code);
        if let Some(msg) = attempt.spawn_failed {
            let e = ComposeError::Failed { message: msg };
            return ended(StackOutcome::Failed, None, Some(ApiError::from(&e)), vec![]);
        }
        if attempt.canceled {
            return ended(StackOutcome::Canceled, exit_code, None, vec![]);
        }
        if attempt.timed_out {
            return ended(
                StackOutcome::Timeout,
                exit_code,
                Some(ApiError::new(
                    ApiErrorCode::Timeout,
                    "la operación tardó demasiado y se canceló",
                )),
                vec![],
            );
        }
        if attempt.overflow {
            let e = ComposeError::Failed {
                message: "Compose produjo demasiada salida y se detuvo".into(),
            };
            return ended(
                StackOutcome::Failed,
                exit_code,
                Some(ApiError::from(&e)),
                vec![],
            );
        }
        if attempt.exit.is_some_and(|e| e.success()) {
            return ended(StackOutcome::Success, exit_code, None, vec![]);
        }
        // Fallo: mensaje final > primer ítem con error > últimas líneas de texto.
        let raw = attempt
            .final_error
            .clone()
            .flatten()
            .or_else(|| tracker.first_error().map(|i| i.text.clone()))
            .or_else(|| {
                let t = attempt.texts.join("\n");
                (!t.trim().is_empty()).then_some(t)
            })
            .unwrap_or_else(|| match exit_code {
                Some(n) => format!("Compose terminó con el código {n}"),
                None => "Compose terminó de forma inesperada".to_string(),
            });
        let message = truncate(&redact(&raw, &self.secrets), MAX_MESSAGE_LEN);
        let issues: Vec<ValidationIssue> = parse_issues(&message)
            .into_iter()
            .filter(|i| i.kind != engine_core::IssueKind::Other)
            .collect();
        let code = if issues.is_empty() {
            ApiErrorCode::ComposeFailed
        } else {
            ApiErrorCode::InvalidCompose
        };
        ended(
            StackOutcome::Failed,
            exit_code,
            Some(ApiError::new(code, message)),
            issues,
        )
    }

    #[allow(clippy::too_many_arguments)]
    async fn attempt(
        &self,
        mode: ProgressMode,
        cwd: &Path,
        tracker: &mut ProgressTracker,
        sink: &StackSink,
        cancel: &mut CancelSignal,
        canceled: &mut bool,
        log_feeds: &mut usize,
    ) -> Attempt {
        let core = &self.core;
        let cmd = match self.kind {
            OpKind::Down => ComposeCmd::Down,
            OpKind::Lifecycle(k) => ComposeCmd::Op {
                kind: k,
                services: self.services.clone(),
            },
        };
        let spec = args::build(self.info.flavor, &self.project, &cmd, mode);
        let mut a = Attempt {
            exit: None,
            final_error: None,
            texts: Vec::new(),
            saw_json: false,
            timed_out: false,
            canceled: *canceled,
            overflow: false,
            spawn_failed: None,
        };
        let env = core.child_env();
        let mut sp = match core.spawner.spawn(&spec, &env, cwd, None).await {
            Ok(s) => s,
            Err(e) => {
                a.spawn_failed = Some(if e.kind() == std::io::ErrorKind::NotFound {
                    "no se encontró el binario `docker`".into()
                } else {
                    format!("no se pudo lanzar Compose ({:?})", e.kind())
                });
                return a;
            }
        };
        // stdout: se drena (Compose no debe escribir ahí en estas operaciones) con tope.
        let stdout = sp.stdout;
        let drain = tokio::spawn(async move {
            let _ = read_capped(stdout, 1024 * 1024).await;
        });
        let mut lines = LineReader::new(sp.stderr);
        let mut tick = tokio::time::interval(core.limits.flush_every);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let deadline = tokio::time::sleep(self.timeout());
        tokio::pin!(deadline);
        let mut kill_at: Option<tokio::time::Instant> = None;
        let mut killed = false;
        let mut text_bytes = 0usize;
        let far = tokio::time::Instant::now() + Duration::from_secs(86_400 * 365);

        loop {
            tokio::select! {
                biased;
                _ = &mut *cancel, if !*canceled => {
                    *canceled = true;
                    a.canceled = true;
                    sp.child.term();
                    kill_at = Some(tokio::time::Instant::now() + core.limits.term_grace);
                }
                _ = &mut deadline, if !a.timed_out && !a.canceled => {
                    a.timed_out = true;
                    sp.child.term();
                    kill_at = Some(tokio::time::Instant::now() + core.limits.term_grace);
                }
                _ = tokio::time::sleep_until(kill_at.unwrap_or(far)), if kill_at.is_some() && !killed => {
                    killed = true;
                    sp.child.kill();
                }
                _ = tick.tick() => flush(tracker, sink),
                r = lines.next() => {
                    match r {
                        Ok(Some(line)) => {
                            if lines.total > core.limits.max_stderr_total && !a.overflow {
                                a.overflow = true;
                                sp.child.term();
                                kill_at = Some(tokio::time::Instant::now() + core.limits.term_grace);
                            }
                            if a.overflow { continue; }
                            let parsed = if mode == ProgressMode::Plain { parse_plain_line(&line) } else { parse_line(&line) };
                            match parsed {
                                Line::Item(mut item) => {
                                    a.saw_json = true;
                                    item.text = redact(&item.text, &self.secrets);
                                    item.details = item.details.map(|d| redact(&d, &self.secrets));
                                    item.id = redact(&item.id, &self.secrets);
                                    item.name = redact(&item.name, &self.secrets);
                                    tracker.ingest(item);
                                }
                                Line::Error { message } => { a.saw_json = true; a.final_error = Some(message); }
                                Line::Text(t) => {
                                    if t.is_empty() { continue; }
                                    if text_bytes < MAX_TEXT_BYTES {
                                        text_bytes += t.len();
                                        a.texts.push(t.clone());
                                    }
                                    if *log_feeds < MAX_LOG_FEEDS {
                                        *log_feeds += 1;
                                        sink(StackOpFeed::Log { text: redact(&t, &self.secrets) });
                                    }
                                }
                            }
                        }
                        Ok(None) | Err(_) => break,
                    }
                }
            }
        }
        // EOF de stderr: esperar la salida del proceso (con tope: si no sale, se remata).
        let wait = async {
            match tokio::time::timeout(
                core.limits.term_grace.max(Duration::from_secs(1)),
                sp.child.wait(),
            )
            .await
            {
                Ok(r) => r.ok(),
                Err(_) => {
                    sp.child.kill();
                    sp.child.wait().await.ok()
                }
            }
        };
        a.exit = wait.await;
        drain.abort();
        a
    }
}

fn flush(tracker: &mut ProgressTracker, sink: &StackSink) {
    while tracker.has_changes() {
        let items = tracker.drain_changed(MAX_PROGRESS_ITEMS);
        sink(StackOpFeed::Progress {
            items,
            services: tracker.services_snapshot(),
        });
    }
}

fn ended(
    outcome: StackOutcome,
    exit_code: Option<i32>,
    error: Option<ApiError>,
    issues: Vec<ValidationIssue>,
) -> StackOpFeed {
    StackOpFeed::Ended {
        outcome,
        exit_code,
        error,
        issues,
    }
}

/// Proyecto de Compose a partir de un stack resuelto (managed/linked).
pub(crate) fn project_of(r: &ResolvedStack) -> ProjectSpec {
    ProjectSpec {
        name: r.name.clone(),
        project_dir: Some(r.project_dir.clone()),
        files: ConfigFiles::Paths(r.config_files.clone()),
        // Vinculado sin `.env` válido: `/dev/null` evita que Compose autocargue un `.env` que
        // pudo cambiar a symlink después de vincular.
        env_file: match (&r.env_file, r.origin) {
            (None, StackOrigin::Linked) => Some(PathBuf::from("/dev/null")),
            (e, _) => e.clone(),
        },
    }
}

#[async_trait::async_trait]
impl engine_core::StackOpRun for PreparedOp {
    async fn run(self: Box<Self>, sink: StackSink, cancel: CancelSignal) {
        (*self).execute(sink, cancel).await;
    }
}

/// Tope de archivos YAML revisados por el pre-escaneo de `include` (evita recorrer sin fin).
const MAX_INCLUDE_FILES: usize = 64;
const INCLUDE_REMOTO: &str =
    "`include` remoto (git, OCI o http) no permitido: usa archivos locales";
const INCLUDE_NO_VERIFICABLE: &str = "`include` no verificable: el YAML no se puede leer o su `include` tiene una forma no soportada; usa rutas locales en un YAML válido";
const INCLUDE_DEMASIADOS: &str = "demasiados archivos `include` para verificarlos";

/// Lee un YAML para escanear sus `include`. `None` si no existe (lo informará Compose).
/// Falla cerrado si es demasiado grande o no se puede leer como texto.
fn read_for_scan(p: &Path) -> Result<Option<String>, ComposeError> {
    let Ok(meta) = std::fs::metadata(p) else {
        return Ok(None);
    };
    if meta.len() > crate::files::MAX_YAML_BYTES as u64 {
        return Err(include_issue(None, INCLUDE_NO_VERIFICABLE, None));
    }
    std::fs::read_to_string(p)
        .map(Some)
        .map_err(|_| include_issue(None, INCLUDE_NO_VERIFICABLE, None))
}

/// Problema de `include`. Si el `include` está en un archivo anidado, se nombra ese archivo.
fn include_issue(line: Option<u32>, message: &str, origen: Option<&str>) -> ComposeError {
    let message = match origen {
        Some(nombre) => format!("{message} (en {nombre})"),
        None => message.to_string(),
    };
    ComposeError::Invalid(vec![ValidationIssue {
        line,
        column: None,
        kind: engine_core::IssueKind::Schema,
        message,
    }])
}

#[cfg(test)]
mod tests_remote {
    use std::ffi::OsString;

    use super::*;

    fn runner() -> ComposeRunner {
        ComposeRunner::with_parts(
            Some("tcp://127.0.0.1:2376".into()),
            Arc::new(TokioSpawn),
            Limits::default(),
            crate::files::StackStore::unavailable(),
        )
    }

    fn get(env: &[(OsString, OsString)], k: &str) -> Option<String> {
        env.iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.to_string_lossy().into_owned())
    }

    fn inherited() -> Vec<(OsString, OsString)> {
        vec![
            ("PATH".into(), "/usr/bin".into()),
            ("DOCKER_TLS_VERIFY".into(), "0".into()),
            ("DOCKER_CERT_PATH".into(), "/heredado".into()),
        ]
    }

    #[test]
    fn remoto_es_falso_por_defecto_y_sigue_a_su_fuente() {
        let r = runner();
        assert!(!r.is_remote());
        let flag = Arc::new(AtomicBool::new(false));
        let f = flag.clone();
        r.set_remote_source(Arc::new(move || {
            f.load(std::sync::atomic::Ordering::Relaxed)
        }));
        assert!(!r.is_remote());
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(r.is_remote());
    }

    #[test]
    fn rutas_locales_que_escapan_se_rechazan_antes_de_compose() {
        let dir =
            std::env::temp_dir().join(format!("dockinng-runner-sandbox-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = std::fs::canonicalize(&dir).unwrap();
        let project = ProjectSpec {
            name: "p".into(),
            project_dir: Some(root),
            files: ConfigFiles::Stdin,
            env_file: None,
        };
        let core = &runner().core;
        let err = core
            .reject_local_escape(&project, Some(b"include:\n  - ../x.yaml\n"))
            .unwrap_err();
        assert!(
            matches!(&err, ComposeError::Invalid(v) if v[0].line == Some(2)),
            "{err:?}"
        );
        assert!(
            core.reject_local_escape(&project, Some(b"include:\n  - ./x.yaml\n"))
                .is_ok()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn el_entorno_extra_manda_sobre_el_heredado() {
        let r = runner();
        r.set_env_source(inherited());
        // Sin fuente extra: se conserva lo heredado (comportamiento previo).
        let env = r.core.child_env();
        assert_eq!(get(&env, "DOCKER_TLS_VERIFY").as_deref(), Some("0"));
        assert_eq!(
            get(&env, "DOCKER_HOST").as_deref(),
            Some("tcp://127.0.0.1:2376")
        );
        // Con TLS del destino: mandan las del destino.
        r.set_extra_env_source(Arc::new(|| {
            vec![
                ("DOCKER_TLS_VERIFY".into(), "1".into()),
                ("DOCKER_CERT_PATH".into(), "/run/dockinng/certs/x".into()),
            ]
        }));
        let env = r.core.child_env();
        assert_eq!(get(&env, "DOCKER_TLS_VERIFY").as_deref(), Some("1"));
        assert_eq!(
            get(&env, "DOCKER_CERT_PATH").as_deref(),
            Some("/run/dockinng/certs/x")
        );
        assert_eq!(
            env.iter().filter(|(k, _)| k == "DOCKER_TLS_VERIFY").count(),
            1
        );
        // Destino sin TLS (fuente vacía): las heredadas no deben desviar la conexión.
        r.set_extra_env_source(Arc::new(Vec::new));
        let env = r.core.child_env();
        assert_eq!(get(&env, "DOCKER_TLS_VERIFY"), None);
        assert_eq!(get(&env, "DOCKER_CERT_PATH"), None);
    }
}
