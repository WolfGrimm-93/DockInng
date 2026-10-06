//! Servicio de construcción: valida, planifica (ticket si el contexto es sensible) y ejecuta
//! `docker build` como subproceso, con salida por lotes y cancelación limpia.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use compose::args::CommandSpec;
use compose::proc::{LineReader, Spawn, TokioSpawn, build_env};
use engine_core::actions::PlanDecision;
use engine_core::broker::{Broker, RedeemError, SystemClock, TICKET_TTL};
use engine_core::build::{
    BUILD_RING_LINES, BuildFeed, BuildLine, BuildOutcome, BuildPlan, BuildProgress, BuildSpec,
    BuildStream, BuildWarning, MAX_BUILD_LINE, parse_progress, secret_like_args, validate_spec,
};
use engine_core::policy::{Action, Decision, Interactivity, decide};
use engine_core::{ApiError, ApiErrorCode};

/// Cada cuánto se vacía el lote de líneas hacia la UI.
const FLUSH_EVERY: Duration = Duration::from_millis(100);
/// Líneas por lote como máximo.
const FLUSH_LINES: usize = 64;
/// Tras SIGTERM, cuánto se espera antes de SIGKILL al cancelar.
const TERM_GRACE: Duration = Duration::from_secs(10);

/// Destino de los eventos. `false` = ya no hay nadie escuchando: se cancela el build.
pub trait BuildSink: Send + Sync {
    fn send(&self, feed: BuildFeed) -> bool;
}

/// Destino del daemon para el subproceso, decidido por el LLAMADOR (motor activo): el builder
/// nunca hereda `DOCKER_HOST`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH` ni `DOCKER_CONTEXT` del
/// entorno ambiente de la persona.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BuildTarget {
    /// `unix:///ruta` (local o socket de un túnel SSH) o `tcp://host:puerto` (TLS).
    pub docker_host: Option<String>,
    /// Solo `DOCKER_TLS_VERIFY` y `DOCKER_CERT_PATH` (lo demás se ignora).
    pub env: Vec<(String, String)>,
}

/// Variables de Docker que se descartan del entorno ambiente.
const AMBIENT_DOCKER_VARS: [&str; 4] = [
    "DOCKER_HOST",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "DOCKER_CONTEXT",
];
/// Únicas variables de destino que un llamador puede fijar además de `DOCKER_HOST`.
const TARGET_ENV_ALLOWED: [&str; 2] = ["DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"];

/// Entorno del hijo (función pura): lista blanca del entorno ambiente SIN variables de destino
/// de Docker, más el destino explícito, la salida plana de BuildKit y los VALORES de los
/// `--build-arg` (van por entorno para que no aparezcan en la lista de procesos).
pub fn child_env<I>(
    vars: I,
    target: &BuildTarget,
    build_args: &[(String, String)],
) -> Vec<(OsString, OsString)>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    let mut env: Vec<(OsString, OsString)> = build_env(vars, None)
        .into_iter()
        .filter(|(k, _)| !AMBIENT_DOCKER_VARS.iter().any(|a| k == a))
        .collect();
    if let Some(h) = &target.docker_host {
        env.push(("DOCKER_HOST".into(), h.into()));
    }
    for (k, v) in &target.env {
        if TARGET_ENV_ALLOWED.contains(&k.as_str()) {
            env.push((k.into(), v.into()));
        }
    }
    env.push(("BUILDKIT_PROGRESS".into(), "plain".into()));
    for (k, v) in build_args {
        // Un nombre reservado nunca llega aquí (`validate_spec`); la comprobación evita que
        // un valor pise una variable ya fijada.
        if !env
            .iter()
            .any(|(e, _)| e.as_os_str() == std::ffi::OsStr::new(k))
        {
            env.push((k.into(), v.into()));
        }
    }
    env
}

/// Especificación ya validada y con rutas canónicas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedBuild {
    /// Contexto canónico (existe y es un directorio).
    pub context: PathBuf,
    /// Dockerfile canónico dentro del contexto, si se indicó uno.
    pub dockerfile: Option<PathBuf>,
    /// Especificación con `context_dir` canonizado (es lo que liga el ticket).
    pub spec: BuildSpec,
    /// Contexto sensible: hay que confirmar.
    pub sensitive: bool,
    pub warnings: Vec<BuildWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunResult {
    pub outcome: BuildOutcome,
    pub image_id: Option<String>,
    pub error: Option<ApiError>,
}

/// Libera el "un build a la vez" al soltarse.
struct ActiveGuard(Arc<AtomicBool>);

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub struct BuildService {
    spawn: Arc<dyn Spawn>,
    /// El ticket liga la especificación Y el destino del daemon para el que se emitió.
    broker: Broker<(BuildSpec, Option<String>)>,
    active: Arc<AtomicBool>,
    home: Option<String>,
}

impl Default for BuildService {
    fn default() -> Self {
        Self::new()
    }
}

fn invalid(msg: impl Into<String>) -> ApiError {
    // Mismo código y mensaje que el resto de entradas inválidas del núcleo.
    ApiError::from(engine_core::EngineError::invalid(msg))
}

impl BuildService {
    pub fn new() -> Self {
        Self::with_spawn(Arc::new(TokioSpawn), std::env::var("HOME").ok())
    }

    pub fn with_spawn(spawn: Arc<dyn Spawn>, home: Option<String>) -> Self {
        Self {
            spawn,
            broker: Broker::new(Arc::new(SystemClock::new())),
            active: Arc::new(AtomicBool::new(false)),
            home,
        }
    }

    /// Hay un build ejecutándose ahora mismo.
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    /// Valida la especificación y canoniza las rutas (toca el sistema de archivos, no el motor).
    pub fn prepare(&self, spec: &BuildSpec) -> Result<PreparedBuild, ApiError> {
        validate_spec(spec).map_err(ApiError::from)?;
        let context = std::fs::canonicalize(&spec.context_dir)
            .map_err(|_| invalid("el directorio de contexto no existe o no es accesible"))?;
        if !context.is_dir() {
            return Err(invalid(
                "el contexto de construcción debe ser un directorio",
            ));
        }
        let dockerfile = match &spec.dockerfile {
            Some(rel) => {
                let p = std::fs::canonicalize(context.join(rel))
                    .map_err(|_| invalid("el Dockerfile no existe dentro del contexto"))?;
                // Un enlace simbólico no puede sacar el Dockerfile del contexto.
                if !p.starts_with(&context) || !p.is_file() {
                    return Err(invalid(
                        "el Dockerfile debe ser un archivo dentro del contexto",
                    ));
                }
                Some(p)
            }
            None => None,
        };
        let ctx_str = context
            .to_str()
            .ok_or_else(|| invalid("la ruta del contexto no es UTF-8"))?
            .to_string();
        let sensitive = compose::risks::is_sensitive_bind(&ctx_str, self.home.as_deref());
        let mut warnings = Vec::new();
        if sensitive {
            warnings.push(BuildWarning::SensitiveContext {
                path: ctx_str.clone(),
            });
        }
        for name in secret_like_args(spec) {
            warnings.push(BuildWarning::SecretLikeArg { name });
        }
        let mut canon = spec.clone();
        canon.context_dir = ctx_str;
        Ok(PreparedBuild {
            context,
            dockerfile,
            spec: canon,
            sensitive,
            warnings,
        })
    }

    /// Plan para la GUI (interactivo, sin `--yes`).
    pub fn plan(&self, spec: &BuildSpec, target: &BuildTarget) -> Result<BuildPlan, ApiError> {
        self.plan_with(spec, target, Interactivity::Interactive, false)
    }

    /// Invalida todos los tickets pendientes (al cambiar de conexión).
    pub fn invalidate_all(&self) {
        self.broker.clear();
    }

    /// Plan con la interactividad real del llamador (CLI). Con `Deny` no hay ticket.
    pub fn plan_with(
        &self,
        spec: &BuildSpec,
        target: &BuildTarget,
        interactivity: Interactivity,
        assume_yes: bool,
    ) -> Result<BuildPlan, ApiError> {
        let prepared = self.prepare(spec)?;
        if !prepared.sensitive {
            return Ok(BuildPlan {
                warnings: prepared.warnings,
                decision: PlanDecision::Allow,
                ticket: None,
                expires_in_secs: 0,
            });
        }
        let effective = decide(&Action::BuildSensitiveContext, interactivity, assume_yes);
        let ticket = if matches!(effective, Decision::Deny(_)) {
            None
        } else {
            // El ticket lleva la exigencia máxima; `assume_yes` solo relaja la decisión mostrada.
            let strict = decide(
                &Action::BuildSensitiveContext,
                Interactivity::Interactive,
                false,
            );
            Some(
                self.broker
                    .issue((prepared.spec.clone(), target.docker_host.clone()), strict)
                    .map_err(|_| {
                        ApiError::new(ApiErrorCode::Conflict, "demasiados planes pendientes")
                    })?,
            )
        };
        Ok(BuildPlan {
            warnings: prepared.warnings,
            decision: PlanDecision::from(&effective),
            ticket,
            expires_in_secs: TICKET_TTL.as_secs() as u32,
        })
    }

    /// Ejecuta el build. Un contexto sensible exige un ticket vigente emitido para esta misma
    /// especificación. `cancel` completado = SIGTERM al grupo, gracia y SIGKILL; el resultado
    /// es `Canceled`. Emite siempre un `Ended` (salvo que el destino haya desaparecido).
    pub async fn run(
        &self,
        spec: &BuildSpec,
        ticket: Option<&str>,
        target: &BuildTarget,
        sink: &dyn BuildSink,
        cancel: impl Future<Output = ()>,
    ) -> Result<RunResult, ApiError> {
        let prepared = self.prepare(spec)?;
        // Primero el cupo: un rechazo por "ya hay un build" no debe gastar el ticket.
        if self.active.swap(true, Ordering::SeqCst) {
            return Err(ApiError::new(
                ApiErrorCode::Conflict,
                "ya hay una construcción en curso",
            ));
        }
        let _guard = ActiveGuard(self.active.clone());
        if prepared.sensitive {
            let t = ticket.ok_or_else(|| {
                ApiError::new(
                    ApiErrorCode::TicketInvalid,
                    "el contexto es sensible: hay que confirmar antes de construir",
                )
            })?;
            // Igual que en la creación: la confirmación la aporta la propia llamada `build`
            // (sin campo `confirmed` en este comando). Pendiente de decisión (ver informe).
            let (payload, _) = self.broker.redeem(t, None, true).map_err(|e| match e {
                RedeemError::Expired => {
                    ApiError::new(ApiErrorCode::TicketExpired, "el ticket expiró")
                }
                _ => ApiError::new(
                    ApiErrorCode::TicketInvalid,
                    "el ticket no existe o ya se usó",
                ),
            })?;
            // El ticket vale para esta especificación y ESTE destino: si la conexión activa
            // cambió desde el plan, hay que reconfirmar.
            if payload != (prepared.spec.clone(), target.docker_host.clone()) {
                return Err(ApiError::new(
                    ApiErrorCode::TicketInvalid,
                    "el ticket no corresponde a esta construcción o a la conexión activa",
                ));
            }
        }
        let result = self.execute(&prepared, target, sink, cancel).await;
        sink.send(BuildFeed::Ended {
            outcome: result.outcome,
            image_id: result.image_id.clone(),
            error: result.error.clone(),
        });
        Ok(result)
    }

    async fn execute(
        &self,
        p: &PreparedBuild,
        target: &BuildTarget,
        sink: &dyn BuildSink,
        cancel: impl Future<Output = ()>,
    ) -> RunResult {
        let fail = |msg: String| RunResult {
            outcome: BuildOutcome::Failed,
            image_id: None,
            error: Some(ApiError::new(ApiErrorCode::Internal, msg)),
        };
        // Directorio privado (0700) para el archivo con el id de la imagen.
        let tmp = std::env::temp_dir().join(format!("dockinng-build-{}", uuid::Uuid::now_v7()));
        {
            use std::os::unix::fs::DirBuilderExt;
            if let Err(e) = std::fs::DirBuilder::new().mode(0o700).create(&tmp) {
                return fail(format!("no se pudo crear el directorio temporal: {e}"));
            }
        }
        let iid = tmp.join("iid");
        let result = self.run_process(p, target, &iid, sink, cancel).await;
        let _ = std::fs::remove_dir_all(&tmp);
        result
    }

    async fn run_process(
        &self,
        p: &PreparedBuild,
        target: &BuildTarget,
        iid: &Path,
        sink: &dyn BuildSink,
        cancel: impl Future<Output = ()>,
    ) -> RunResult {
        let spec = CommandSpec {
            program: "docker".into(),
            args: crate::argv::build_argv(&p.spec, &p.context, p.dockerfile.as_deref(), iid),
        };
        let env = child_env(std::env::vars_os(), target, &p.spec.build_args);
        let mut spawned = match self.spawn.spawn(&spec, &env, &p.context, None).await {
            Ok(s) => s,
            Err(e) => {
                let msg = if e.kind() == std::io::ErrorKind::NotFound {
                    "no se encontró el comando `docker` en el PATH".to_string()
                } else {
                    format!("no se pudo lanzar docker build: {e}")
                };
                return RunResult {
                    outcome: BuildOutcome::Failed,
                    image_id: None,
                    error: Some(ApiError::new(ApiErrorCode::NotFound, msg)),
                };
            }
        };
        // Los valores de los ARG no se reenvían a la UI aunque el build los imprima.
        let secrets: Vec<&str> = p
            .spec
            .build_args
            .iter()
            .map(|(_, v)| v.as_str())
            .filter(|v| v.len() >= 3)
            .collect();
        let mut out = LineReader::new(spawned.stdout);
        let mut err = LineReader::new(spawned.stderr);
        let (mut out_done, mut err_done) = (false, false);
        let mut batch: Vec<BuildLine> = Vec::new();
        let mut ring: VecDeque<String> = VecDeque::new();
        let mut detected_id: Option<String> = None;
        let mut last_step: Option<(u32, u32)> = None;
        let mut flush_at = tokio::time::Instant::now() + FLUSH_EVERY;
        let mut canceled = false;
        let mut listener_gone = false;
        tokio::pin!(cancel);

        // `LineReader::next` es seguro ante cancelación (el estado vive en la estructura).
        while !(out_done && err_done) {
            let (stream, line) = tokio::select! {
                r = out.next(), if !out_done => match r {
                    Ok(Some(l)) => (BuildStream::Stdout, l),
                    _ => { out_done = true; continue; }
                },
                r = err.next(), if !err_done => match r {
                    Ok(Some(l)) => (BuildStream::Stderr, l),
                    _ => { err_done = true; continue; }
                },
                _ = tokio::time::sleep_until(flush_at) => {
                    if !flush(&mut batch, sink) { listener_gone = true; break; }
                    flush_at = tokio::time::Instant::now() + FLUSH_EVERY;
                    continue;
                },
                _ = &mut cancel => { canceled = true; break; }
            };
            let mut text = line;
            if text.len() > MAX_BUILD_LINE {
                text.truncate(floor_char_boundary(&text, MAX_BUILD_LINE));
            }
            for s in &secrets {
                if text.contains(s) {
                    text = text.replace(s, "***");
                }
            }
            match parse_progress(&text) {
                Some(BuildProgress::Step { n, total }) if last_step != Some((n, total)) => {
                    last_step = Some((n, total));
                    // El paso va después de las líneas ya acumuladas para no reordenar.
                    if !flush(&mut batch, sink) || !sink.send(BuildFeed::Step { n, total }) {
                        listener_gone = true;
                        break;
                    }
                }
                Some(BuildProgress::ImageId(id)) => detected_id = Some(id),
                _ => {}
            }
            if ring.len() >= BUILD_RING_LINES {
                ring.pop_front();
            }
            if stream == BuildStream::Stderr {
                ring.push_back(text.clone());
            }
            batch.push(BuildLine { text, stream });
            if batch.len() >= FLUSH_LINES {
                if !flush(&mut batch, sink) {
                    listener_gone = true;
                    break;
                }
                flush_at = tokio::time::Instant::now() + FLUSH_EVERY;
            }
        }

        if canceled || listener_gone {
            spawned.child.term();
            let waited = tokio::time::timeout(TERM_GRACE, spawned.child.wait()).await;
            if waited.is_err() {
                spawned.child.kill();
                let _ = spawned.child.wait().await;
            }
            flush(&mut batch, sink);
            return RunResult {
                outcome: BuildOutcome::Canceled,
                image_id: None,
                error: None,
            };
        }
        flush(&mut batch, sink);
        let exit = match spawned.child.wait().await {
            Ok(e) => e,
            Err(e) => {
                return RunResult {
                    outcome: BuildOutcome::Failed,
                    image_id: None,
                    error: Some(ApiError::new(
                        ApiErrorCode::Internal,
                        format!("no se pudo esperar a docker build: {e}"),
                    )),
                };
            }
        };
        if exit.success() {
            // El archivo iidfile es la fuente fiable; el parser es solo el respaldo.
            let from_file = std::fs::read_to_string(iid)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && s.len() <= 200);
            return RunResult {
                outcome: BuildOutcome::Ok,
                image_id: from_file.or(detected_id),
                error: None,
            };
        }
        let tail: Vec<&str> = ring.iter().rev().take(5).map(String::as_str).collect();
        let mut msg = match (exit.code, exit.signal) {
            (Some(c), _) => format!("docker build terminó con código {c}"),
            (None, Some(s)) => format!("docker build terminó por la señal {s}"),
            _ => "docker build terminó de forma anómala".to_string(),
        };
        if !tail.is_empty() {
            msg.push_str(": ");
            let joined: Vec<String> = tail
                .iter()
                .rev()
                .map(|l| l.chars().take(300).collect())
                .collect();
            msg.push_str(&joined.join(" | "));
        }
        RunResult {
            outcome: BuildOutcome::Failed,
            image_id: None,
            error: Some(ApiError::new(ApiErrorCode::Engine, msg)),
        }
    }
}

/// Envía el lote acumulado. `false` = el destino desapareció.
fn flush(batch: &mut Vec<BuildLine>, sink: &dyn BuildSink) -> bool {
    if batch.is_empty() {
        return true;
    }
    sink.send(BuildFeed::Lines {
        lines: std::mem::take(batch),
    })
}

fn floor_char_boundary(s: &str, max: usize) -> usize {
    let mut i = max.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use compose::proc::{ChildHandle, ExitInfo, Spawned};

    use super::*;

    /// Lanzador falso: entrega salida fija y un código de salida; recuerda los argumentos.
    struct FakeSpawn {
        stdout: String,
        stderr: String,
        code: i32,
        seen: Mutex<Vec<CommandSpec>>,
        envs: Mutex<Vec<Vec<(OsString, OsString)>>>,
        /// Si es `true` el hijo "no termina" hasta recibir SIGTERM.
        hang: bool,
        termed: Arc<AtomicBool>,
    }

    impl FakeSpawn {
        fn new(stdout: &str, stderr: &str, code: i32) -> Arc<Self> {
            Arc::new(Self {
                stdout: stdout.into(),
                stderr: stderr.into(),
                code,
                seen: Mutex::new(vec![]),
                envs: Mutex::new(vec![]),
                hang: false,
                termed: Arc::new(AtomicBool::new(false)),
            })
        }
    }

    struct FakeChild {
        code: i32,
        hang: bool,
        termed: Arc<AtomicBool>,
    }

    #[async_trait]
    impl ChildHandle for FakeChild {
        async fn wait(&mut self) -> io::Result<ExitInfo> {
            while self.hang && !self.termed.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            Ok(ExitInfo {
                code: Some(self.code),
                signal: None,
            })
        }
        fn term(&mut self) {
            self.termed.store(true, Ordering::SeqCst);
        }
        fn kill(&mut self) {}
    }

    #[async_trait]
    impl Spawn for FakeSpawn {
        async fn spawn(
            &self,
            spec: &CommandSpec,
            env: &[(OsString, OsString)],
            _cwd: &Path,
            _stdin: Option<Vec<u8>>,
        ) -> io::Result<Spawned> {
            self.seen.lock().unwrap().push(spec.clone());
            self.envs.lock().unwrap().push(env.to_vec());
            let (out, err): (compose::proc::BoxRead, compose::proc::BoxRead) = if self.hang {
                // Lectores que nunca terminan: el build "sigue corriendo".
                (Box::new(PendingRead), Box::new(PendingRead))
            } else {
                (
                    Box::new(io::Cursor::new(self.stdout.clone().into_bytes())),
                    Box::new(io::Cursor::new(self.stderr.clone().into_bytes())),
                )
            };
            Ok(Spawned {
                stdout: out,
                stderr: err,
                child: Box::new(FakeChild {
                    code: self.code,
                    hang: self.hang,
                    termed: self.termed.clone(),
                }),
            })
        }
    }

    /// Lector que nunca entrega datos ni termina.
    struct PendingRead;

    impl tokio::io::AsyncRead for PendingRead {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            _buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            std::task::Poll::Pending
        }
    }

    #[derive(Default)]
    struct Collect(Mutex<Vec<BuildFeed>>);

    impl BuildSink for Collect {
        fn send(&self, feed: BuildFeed) -> bool {
            self.0.lock().unwrap().push(feed);
            true
        }
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dockinng-test-{tag}-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn spec(dir: &Path) -> BuildSpec {
        BuildSpec {
            context_dir: dir.display().to_string(),
            dockerfile: None,
            tag: Some("dockinng-test-build:1".into()),
            build_args: vec![("TOKEN".into(), "supersecreto".into())],
            target: None,
            no_cache: false,
            pull: false,
        }
    }

    #[tokio::test]
    async fn build_ok_emite_pasos_lineas_y_oculta_args() {
        let dir = tmpdir("b1");
        let fake = FakeSpawn::new(
            "Step 1/2 : FROM scratch\nStep 2/2 : RUN echo supersecreto\nSuccessfully built abcdef123456\n",
            "",
            0,
        );
        let svc = BuildService::with_spawn(fake.clone(), Some("/home/x".into()));
        let sink = Collect::default();
        let r = svc
            .run(
                &spec(&dir),
                None,
                &BuildTarget {
                    docker_host: Some("unix:///x".into()),
                    env: vec![],
                },
                &sink,
                std::future::pending(),
            )
            .await
            .expect("run");
        assert_eq!(r.outcome, BuildOutcome::Ok);
        assert_eq!(r.image_id.as_deref(), Some("abcdef123456"));
        let feeds = sink.0.lock().unwrap().clone();
        assert!(feeds.contains(&BuildFeed::Step { n: 1, total: 2 }));
        assert!(feeds.contains(&BuildFeed::Step { n: 2, total: 2 }));
        let all: String = feeds
            .iter()
            .filter_map(|f| match f {
                BuildFeed::Lines { lines } => Some(
                    lines
                        .iter()
                        .map(|l| l.text.clone())
                        .collect::<Vec<_>>()
                        .join("\n"),
                ),
                _ => None,
            })
            .collect();
        assert!(!all.contains("supersecreto"), "{all}");
        assert!(all.contains("RUN echo ***"));
        assert!(matches!(
            feeds.last(),
            Some(BuildFeed::Ended {
                outcome: BuildOutcome::Ok,
                ..
            })
        ));
        // Argumentos: etiqueta de rastreo presente.
        let argv = fake.seen.lock().unwrap()[0].display();
        assert!(argv.contains("--label dev.dockinng.built=1"), "{argv}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn build_fallido_incluye_cola_de_stderr() {
        let dir = tmpdir("b2");
        let fake = FakeSpawn::new("", "linea uno\nfallo grave\n", 1);
        let svc = BuildService::with_spawn(fake, None);
        let sink = Collect::default();
        let r = svc
            .run(
                &spec(&dir),
                None,
                &BuildTarget::default(),
                &sink,
                std::future::pending(),
            )
            .await
            .expect("run");
        assert_eq!(r.outcome, BuildOutcome::Failed);
        let m = r.error.expect("error").message;
        assert!(m.contains("código 1") && m.contains("fallo grave"), "{m}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancelar_manda_sigterm_y_termina_como_canceled() {
        let dir = tmpdir("b3");
        let mut f = FakeSpawn::new("", "", 143);
        Arc::get_mut(&mut f).unwrap().hang = true;
        let termed = f.termed.clone();
        let svc = BuildService::with_spawn(f, None);
        let sink = Collect::default();
        let r = svc
            .run(
                &spec(&dir),
                None,
                &BuildTarget::default(),
                &sink,
                tokio::time::sleep(Duration::from_millis(50)),
            )
            .await
            .expect("run");
        assert_eq!(r.outcome, BuildOutcome::Canceled);
        assert!(termed.load(Ordering::SeqCst));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn un_build_a_la_vez() {
        let dir = tmpdir("b4");
        let mut f = FakeSpawn::new("", "", 0);
        Arc::get_mut(&mut f).unwrap().hang = true;
        let svc = Arc::new(BuildService::with_spawn(f, None));
        let s2 = svc.clone();
        let d2 = spec(&dir);
        let first = tokio::spawn(async move {
            let sink = Collect::default();
            s2.run(
                &d2,
                None,
                &BuildTarget::default(),
                &sink,
                tokio::time::sleep(Duration::from_millis(300)),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        let sink = Collect::default();
        let second = svc
            .run(
                &spec(&dir),
                None,
                &BuildTarget::default(),
                &sink,
                std::future::pending(),
            )
            .await;
        assert_eq!(second.unwrap_err().code, ApiErrorCode::Conflict);
        let _ = first.await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn contexto_inexistente_o_dockerfile_fuera_se_rechaza() {
        let svc = BuildService::with_spawn(FakeSpawn::new("", "", 0), None);
        let mut s = spec(Path::new("/no/existe/dockinng-test"));
        assert!(svc.prepare(&s).is_err());
        let dir = tmpdir("b5");
        let outside = tmpdir("b5-out");
        std::fs::write(outside.join("Dockerfile"), "FROM scratch\n").unwrap();
        std::os::unix::fs::symlink(outside.join("Dockerfile"), dir.join("Enlace")).unwrap();
        s = spec(&dir);
        s.dockerfile = Some("Enlace".into());
        assert!(svc.prepare(&s).is_err(), "el enlace escapa del contexto");
        s.dockerfile = Some("../x".into());
        assert!(svc.prepare(&s).is_err());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[tokio::test]
    async fn contexto_sensible_exige_ticket_ligado_a_la_especificacion() {
        // HOME simulado = el propio directorio de prueba: el contexto es "$HOME".
        let home = tmpdir("b6");
        let home_s = std::fs::canonicalize(&home).unwrap().display().to_string();
        let svc = BuildService::with_spawn(FakeSpawn::new("", "", 0), Some(home_s));
        let s = spec(&home);
        let plan = svc.plan(&s, &BuildTarget::default()).expect("plan");
        assert_eq!(plan.decision, PlanDecision::Confirm);
        assert!(matches!(
            plan.warnings[0],
            BuildWarning::SensitiveContext { .. }
        ));
        let ticket = plan.ticket.expect("ticket");
        let sink = Collect::default();
        // Sin ticket: rechazado.
        let e = svc
            .run(
                &s,
                None,
                &BuildTarget::default(),
                &sink,
                std::future::pending(),
            )
            .await;
        assert_eq!(e.unwrap_err().code, ApiErrorCode::TicketInvalid);
        // Ticket de otra especificación: rechazado (y consumido).
        let mut other = s.clone();
        other.no_cache = true;
        let e = svc
            .run(
                &other,
                Some(&ticket),
                &BuildTarget::default(),
                &sink,
                std::future::pending(),
            )
            .await;
        assert_eq!(e.unwrap_err().code, ApiErrorCode::TicketInvalid);
        // Ticket válido de un solo uso.
        let plan = svc.plan(&s, &BuildTarget::default()).expect("plan");
        let t = plan.ticket.expect("ticket");
        let ok = svc
            .run(
                &s,
                Some(&t),
                &BuildTarget::default(),
                &sink,
                std::future::pending(),
            )
            .await;
        assert!(ok.is_ok(), "{ok:?}");
        let again = svc
            .run(
                &s,
                Some(&t),
                &BuildTarget::default(),
                &sink,
                std::future::pending(),
            )
            .await;
        assert_eq!(again.unwrap_err().code, ApiErrorCode::TicketInvalid);
        // Sin TTY: Deny y sin ticket; con --yes: Allow con ticket.
        let p = svc
            .plan_with(
                &s,
                &BuildTarget::default(),
                Interactivity::NonInteractive,
                false,
            )
            .unwrap();
        assert!(matches!(p.decision, PlanDecision::Deny { .. }) && p.ticket.is_none());
        let p = svc
            .plan_with(
                &s,
                &BuildTarget::default(),
                Interactivity::NonInteractive,
                true,
            )
            .unwrap();
        assert_eq!(p.decision, PlanDecision::Allow);
        assert!(p.ticket.is_some());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn contexto_normal_no_pide_ticket() {
        let svc = BuildService::with_spawn(FakeSpawn::new("", "", 0), Some("/home/nadie".into()));
        let dir = tmpdir("b7");
        let plan = svc
            .plan(&spec(&dir), &BuildTarget::default())
            .expect("plan");
        assert_eq!(plan.decision, PlanDecision::Allow);
        assert!(plan.ticket.is_none());
        // El ARG con nombre de secreto se avisa.
        assert!(
            plan.warnings
                .iter()
                .any(|w| matches!(w, BuildWarning::SecretLikeArg { name } if name == "TOKEN"))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn vars(list: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        list.iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }

    fn get(env: &[(OsString, OsString)], k: &str) -> Vec<String> {
        env.iter()
            .filter(|(e, _)| e == k)
            .map(|(_, v)| v.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn el_entorno_nunca_hereda_el_destino_ambiente() {
        let ambient = vars(&[
            ("PATH", "/usr/bin"),
            ("HOME", "/home/u"),
            ("DOCKER_HOST", "ssh://otro@host"),
            ("DOCKER_TLS_VERIFY", "1"),
            ("DOCKER_CERT_PATH", "/certs/ajenos"),
            ("DOCKER_CONTEXT", "prod"),
            ("LD_PRELOAD", "/tmp/x.so"),
        ]);
        // Local / túnel: solo el socket, sin nada de TLS.
        let tunnel = BuildTarget {
            docker_host: Some("unix:///run/user/1000/dockinng/tunnels/t.sock".into()),
            env: vec![],
        };
        let env = child_env(ambient.clone(), &tunnel, &[]);
        assert_eq!(
            get(&env, "DOCKER_HOST"),
            ["unix:///run/user/1000/dockinng/tunnels/t.sock"]
        );
        for gone in [
            "DOCKER_TLS_VERIFY",
            "DOCKER_CERT_PATH",
            "DOCKER_CONTEXT",
            "LD_PRELOAD",
        ] {
            assert!(get(&env, gone).is_empty(), "{gone} no debe heredarse");
        }
        assert_eq!(get(&env, "PATH"), ["/usr/bin"]);
        assert_eq!(get(&env, "BUILDKIT_PROGRESS"), ["plain"]);
        // TLS: las variables las fija el llamador (y solo esas dos).
        let tls = BuildTarget {
            docker_host: Some("tcp://h:2376".into()),
            env: vec![
                ("DOCKER_TLS_VERIFY".into(), "1".into()),
                ("DOCKER_CERT_PATH".into(), "/priv/dir".into()),
                ("LD_PRELOAD".into(), "/evil".into()),
            ],
        };
        let env = child_env(ambient.clone(), &tls, &[]);
        assert_eq!(get(&env, "DOCKER_TLS_VERIFY"), ["1"]);
        assert_eq!(get(&env, "DOCKER_CERT_PATH"), ["/priv/dir"]);
        assert!(get(&env, "LD_PRELOAD").is_empty());
        // Sin destino explícito no hay DOCKER_HOST (y el ambiente tampoco se cuela).
        let env = child_env(ambient, &BuildTarget::default(), &[]);
        assert!(get(&env, "DOCKER_HOST").is_empty());
    }

    #[test]
    fn los_valores_de_build_arg_van_por_entorno_y_no_pisan_lo_fijado() {
        let env = child_env(
            vars(&[("PATH", "/usr/bin")]),
            &BuildTarget::default(),
            &[
                ("VERSION".into(), "1.2".into()),
                ("PATH".into(), "/evil".into()),
            ],
        );
        assert_eq!(get(&env, "VERSION"), ["1.2"]);
        assert_eq!(
            get(&env, "PATH"),
            ["/usr/bin"],
            "un arg no puede pisar PATH"
        );
    }

    #[tokio::test]
    async fn el_valor_del_arg_no_aparece_en_argv_pero_si_en_el_entorno() {
        let dir = tmpdir("b8");
        let fake = FakeSpawn::new("", "", 0);
        let svc = BuildService::with_spawn(fake.clone(), None);
        let sink = Collect::default();
        svc.run(
            &spec(&dir),
            None,
            &BuildTarget::default(),
            &sink,
            std::future::pending(),
        )
        .await
        .expect("run");
        let argv = fake.seen.lock().unwrap()[0].display();
        assert!(argv.contains("--build-arg TOKEN"), "{argv}");
        assert!(!argv.contains("supersecreto"), "{argv}");
        assert_eq!(
            fake.envs.lock().unwrap()[0]
                .iter()
                .filter(|(k, _)| k == "TOKEN")
                .map(|(_, v)| v.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            ["supersecreto"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn el_ticket_esta_atado_a_la_conexion_y_se_puede_invalidar() {
        let home = tmpdir("b9");
        let home_s = std::fs::canonicalize(&home).unwrap().display().to_string();
        let svc = BuildService::with_spawn(FakeSpawn::new("", "", 0), Some(home_s));
        let s = spec(&home);
        let local = BuildTarget {
            docker_host: Some("unix:///var/run/docker.sock".into()),
            env: vec![],
        };
        let remote = BuildTarget {
            docker_host: Some("unix:///run/user/1/dockinng/tunnels/x.sock".into()),
            env: vec![],
        };
        let sink = Collect::default();
        // Plan en local, ejecución en remoto: rechazado.
        let t = svc.plan(&s, &local).unwrap().ticket.unwrap();
        let e = svc
            .run(&s, Some(&t), &remote, &sink, std::future::pending())
            .await;
        assert_eq!(e.unwrap_err().code, ApiErrorCode::TicketInvalid);
        // Mismo destino: vale.
        let t = svc.plan(&s, &local).unwrap().ticket.unwrap();
        assert!(
            svc.run(&s, Some(&t), &local, &sink, std::future::pending())
                .await
                .is_ok()
        );
        // Tras invalidar (cambio de conexión) el ticket ya no sirve.
        let t = svc.plan(&s, &local).unwrap().ticket.unwrap();
        svc.invalidate_all();
        let e = svc
            .run(&s, Some(&t), &local, &sink, std::future::pending())
            .await;
        assert_eq!(e.unwrap_err().code, ApiErrorCode::TicketInvalid);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn un_rechazo_por_build_en_curso_no_gasta_el_ticket() {
        let home = tmpdir("b10");
        let home_s = std::fs::canonicalize(&home).unwrap().display().to_string();
        let mut f = FakeSpawn::new("", "", 0);
        Arc::get_mut(&mut f).unwrap().hang = true;
        let svc = Arc::new(BuildService::with_spawn(f, Some(home_s)));
        let s = spec(&home);
        let target = BuildTarget::default();
        let t1 = svc.plan(&s, &target).unwrap().ticket.unwrap();
        let t2 = svc.plan(&s, &target).unwrap().ticket.unwrap();
        let (svc2, s2, t2b) = (svc.clone(), s.clone(), t1.clone());
        let first = tokio::spawn(async move {
            let sink = Collect::default();
            svc2.run(
                &s2,
                Some(&t2b),
                &BuildTarget::default(),
                &sink,
                tokio::time::sleep(Duration::from_millis(300)),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        let sink = Collect::default();
        let e = svc
            .run(&s, Some(&t2), &target, &sink, std::future::pending())
            .await;
        assert_eq!(e.unwrap_err().code, ApiErrorCode::Conflict);
        let _ = first.await;
        // t2 sigue vivo: se puede usar cuando el build anterior terminó.
        let ok = svc
            .run(
                &s,
                Some(&t2),
                &target,
                &sink,
                tokio::time::sleep(Duration::from_millis(50)),
            )
            .await;
        assert!(ok.is_ok(), "{ok:?}");
        let _ = std::fs::remove_dir_all(&home);
    }
}
