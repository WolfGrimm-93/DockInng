//! Tareas de streaming (eventos, logs, stats) y su ciclo de vida.
//!
//! `Channel::send` no tiene contrapresión real: aquí se agrupa y se limita del lado Rust.
//! Toda la lógica es independiente de Tauri (se envía por un `Sink`) para poder probarla
//! con `tokio::time::pause`.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use engine_core::{
    ApiError, ApiErrorCode, ConnectionStatus, ContainerStats, EngineClient, EngineEvent,
    EngineEventKind, EngineStream, LogLine,
};
use futures_util::StreamExt;
use serde::Serialize;
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// Ventana de coalescencia de eventos.
pub const EVENT_WINDOW: Duration = Duration::from_millis(150);
pub const EVENT_MAX_BATCH: usize = 200;
/// Logs: flush cada 50 ms o al llegar a estos topes.
pub const LOG_FLUSH: Duration = Duration::from_millis(50);
pub const LOG_MAX_LINES: usize = 256;
pub const LOG_MAX_BYTES: usize = 128 * 1024;
/// Token bucket de logs (líneas por segundo).
pub const LOG_RATE: f64 = 20_000.0;
/// Y también un tope de bytes por segundo (8 MiB/s).
pub const LOG_BYTES_RATE: f64 = 8.0 * 1024.0 * 1024.0;
/// Stats: como mucho 2 muestras por segundo hacia la UI.
pub const STATS_MIN_GAP: Duration = Duration::from_millis(500);
/// Reconexión de eventos: backoff 1 s -> 30 s.
pub const BACKOFF_START: Duration = Duration::from_secs(1);
pub const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// Límites por ventana (anti-DoS).
pub const MAX_LOG_STREAMS: usize = 6;
pub const MAX_STATS_STREAMS: usize = 6;

/// Destino de los mensajes. `false` = el destino ya no existe: la tarea debe terminar.
pub trait Sink<T>: Send + Sync + 'static {
    fn send(&self, item: T) -> bool;
}

impl<T: Serialize + Send + Sync + 'static> Sink<T> for tauri::ipc::Channel<T> {
    fn send(&self, item: T) -> bool {
        tauri::ipc::Channel::send(self, item).is_ok()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    Eof,
    ContainerStopped,
    Error,
    /// La tarea de streaming terminó en pánico.
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineFeed {
    Events {
        items: Vec<EngineEvent>,
        resync: bool,
    },
    Connection {
        status: ConnectionStatus,
    },
    Ended {
        reason: EndReason,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LogFeed {
    Lines {
        lines: Vec<LogLine>,
        dropped: u64,
    },
    Ended {
        reason: EndReason,
        error: Option<ApiError>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StatsFeed {
    Sample {
        stats: ContainerStats,
    },
    Ended {
        reason: EndReason,
        error: Option<ApiError>,
    },
}

// ---------------------------------------------------------------- eventos

/// Acciones que marcan el ciclo de vida: nunca se funden con otras del mismo objeto
/// (`docker run` emite `create` y `start` en pocos ms; la UI debe ver ambas).
fn is_lifecycle(action: &str) -> bool {
    matches!(action, "create" | "destroy")
}

/// Agrupa eventos por `(kind, id)` fundiendo los de estado (start/die/...) en el último,
/// pero conserva aparte cada `create`/`destroy`. Mantiene el orden de llegada.
#[derive(Default)]
pub struct EventCoalescer {
    events: Vec<EngineEvent>,
    /// Posición del último evento fundible de cada objeto.
    collapsible: HashMap<(EngineEventKind, String), usize>,
}

impl EventCoalescer {
    /// `true` si ya hay que enviar (tope de lote).
    pub fn push(&mut self, ev: EngineEvent) -> bool {
        let key = (ev.kind, ev.id.clone());
        if is_lifecycle(&ev.action) {
            // Corta la fusión: lo que llegue después va en una entrada nueva.
            self.collapsible.remove(&key);
            self.events.push(ev);
        } else if let Some(&pos) = self.collapsible.get(&key) {
            self.events[pos] = ev;
        } else {
            self.collapsible.insert(key, self.events.len());
            self.events.push(ev);
        }
        self.events.len() >= EVENT_MAX_BATCH
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn drain(&mut self) -> Vec<EngineEvent> {
        self.collapsible.clear();
        std::mem::take(&mut self.events)
    }
}

/// Bucle de eventos con reconexión: si el stream falla o termina informa el estado de la
/// conexión y reintenta con backoff; al volver, avisa `resync` para que la UI refresque.
pub async fn run_events(engine: Arc<dyn EngineClient>, sink: Arc<dyn Sink<EngineFeed>>) {
    let mut backoff = BACKOFF_START;
    let mut last_failed: Option<ConnectionStatus> = None;
    loop {
        let mut stream = engine.events();
        let mut coalescer = EventCoalescer::default();
        let mut deadline: Option<Instant> = None;
        let mut got_any = false;
        // Consume el stream hasta que falle o termine.
        loop {
            let flush_at = deadline;
            tokio::select! {
                item = stream.next() => match item {
                    Some(Ok(ev)) => {
                        got_any = true;
                        if deadline.is_none() {
                            deadline = Some(Instant::now() + EVENT_WINDOW);
                        }
                        if coalescer.push(ev) && !flush_events(&mut coalescer, &sink) {
                            return;
                        }
                        if coalescer.is_empty() {
                            deadline = None;
                        }
                    }
                    Some(Err(_)) | None => break,
                },
                _ = async {
                    match flush_at {
                        Some(t) => tokio::time::sleep_until(t).await,
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    deadline = None;
                    if !flush_events(&mut coalescer, &sink) {
                        return;
                    }
                }
            }
        }
        if !flush_events(&mut coalescer, &sink) {
            return;
        }
        drop(stream);
        if got_any {
            backoff = BACKOFF_START;
        }

        // Diagnóstico + reintentos hasta recuperar la conexión.
        let mut status = engine.diagnose().await;
        loop {
            match &status {
                ConnectionStatus::Connected { .. } => {
                    let ok = sink.send(EngineFeed::Connection {
                        status: status.clone(),
                    }) && sink.send(EngineFeed::Events {
                        items: vec![],
                        resync: true,
                    });
                    if !ok {
                        return;
                    }
                    last_failed = None;
                    break;
                }
                ConnectionStatus::Failed { .. } => {
                    // Solo se informa cuando el fallo cambia (evita repetir cada reintento).
                    if last_failed.as_ref() != Some(&status) {
                        if !sink.send(EngineFeed::Connection {
                            status: status.clone(),
                        }) {
                            return;
                        }
                        last_failed = Some(status.clone());
                    }
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(BACKOFF_MAX);
            status = engine.reconnect().await;
        }
        // Pausa antes de reabrir con backoff exponencial + jitter también cuando el stream
        // terminó sin traer eventos: evita un `resync` por segundo contra un stream que
        // se cierra siempre aunque el daemon responda.
        tokio::time::sleep(with_jitter(backoff)).await;
        if !got_any {
            backoff = (backoff * 2).min(BACKOFF_MAX);
        }
    }
}

/// Suma hasta un 25 % aleatorio (bits aleatorios de un UUID v7; sin dependencia extra).
fn with_jitter(d: Duration) -> Duration {
    let frac = (uuid::Uuid::now_v7().as_u128() & 0xFFFF) as f64 / 65_535.0 * 0.25;
    d + d.mul_f64(frac)
}

fn flush_events(c: &mut EventCoalescer, sink: &Arc<dyn Sink<EngineFeed>>) -> bool {
    if c.is_empty() {
        return true;
    }
    sink.send(EngineFeed::Events {
        items: c.drain(),
        resync: false,
    })
}

// ------------------------------------------------------------------- logs

pub struct TokenBucket {
    capacity: f64,
    tokens: f64,
    rate: f64,
    last: Instant,
}

impl TokenBucket {
    pub fn new(capacity: f64, rate: f64, now: Instant) -> Self {
        Self {
            capacity,
            tokens: capacity,
            rate,
            last: now,
        }
    }

    pub fn try_take(&mut self, now: Instant) -> bool {
        self.try_take_n(1.0, now)
    }

    /// Toma `n` unidades (líneas o bytes) si hay saldo.
    pub fn try_take_n(&mut self, n: f64, now: Instant) -> bool {
        let dt = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + dt * self.rate).min(self.capacity);
        if self.tokens >= n {
            self.tokens -= n;
            true
        } else {
            false
        }
    }
}

pub struct LogBatcher {
    lines: Vec<LogLine>,
    bytes: usize,
    dropped: u64,
    bucket: TokenBucket,
    /// Tope de bytes/s: 20 000 líneas de 16 KiB serían ~320 MB/s hacia el webview.
    byte_bucket: TokenBucket,
}

impl LogBatcher {
    pub fn new(now: Instant) -> Self {
        Self::with_rate(LOG_RATE, now)
    }

    pub fn with_rate(rate: f64, now: Instant) -> Self {
        Self::with_rates(rate, LOG_BYTES_RATE, now)
    }

    pub fn with_rates(lines_per_sec: f64, bytes_per_sec: f64, now: Instant) -> Self {
        Self {
            lines: Vec::new(),
            bytes: 0,
            dropped: 0,
            bucket: TokenBucket::new(lines_per_sec, lines_per_sec, now),
            byte_bucket: TokenBucket::new(bytes_per_sec, bytes_per_sec, now),
        }
    }

    /// `true` si el lote alcanzó un tope y hay que enviarlo.
    pub fn push(&mut self, line: LogLine, now: Instant) -> bool {
        let cost = line.message.len() + 32;
        if !self.bucket.try_take(now) || !self.byte_bucket.try_take_n(cost as f64, now) {
            self.dropped += 1;
        } else {
            self.bytes += cost;
            self.lines.push(line);
        }
        self.lines.len() >= LOG_MAX_LINES || self.bytes >= LOG_MAX_BYTES
    }

    pub fn take(&mut self) -> Option<LogFeed> {
        if self.lines.is_empty() && self.dropped == 0 {
            return None;
        }
        self.bytes = 0;
        Some(LogFeed::Lines {
            lines: std::mem::take(&mut self.lines),
            dropped: std::mem::take(&mut self.dropped),
        })
    }
}

fn flush_logs(b: &mut LogBatcher, sink: &Arc<dyn Sink<LogFeed>>) -> bool {
    match b.take() {
        Some(f) => sink.send(f),
        None => true,
    }
}

pub async fn run_logs(
    mut stream: EngineStream<LogLine>,
    sink: Arc<dyn Sink<LogFeed>>,
    follow: bool,
) {
    let mut batch = LogBatcher::new(Instant::now());
    let mut tick = tokio::time::interval(LOG_FLUSH);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            item = stream.next() => match item {
                Some(Ok(line)) => {
                    if batch.push(line, Instant::now()) && !flush_logs(&mut batch, &sink) {
                        return;
                    }
                }
                Some(Err(e)) => {
                    if flush_logs(&mut batch, &sink) {
                        sink.send(LogFeed::Ended { reason: EndReason::Error, error: Some(e.into()) });
                    }
                    return;
                }
                None => {
                    if flush_logs(&mut batch, &sink) {
                        let reason = if follow { EndReason::ContainerStopped } else { EndReason::Eof };
                        sink.send(LogFeed::Ended { reason, error: None });
                    }
                    return;
                }
            },
            _ = tick.tick() => {
                if !flush_logs(&mut batch, &sink) {
                    return;
                }
            }
        }
    }
}

// ------------------------------------------------------------------ stats

pub async fn run_stats(mut stream: EngineStream<ContainerStats>, sink: Arc<dyn Sink<StatsFeed>>) {
    let mut last: Option<Instant> = None;
    while let Some(item) = stream.next().await {
        match item {
            Ok(stats) => {
                let now = Instant::now();
                // Si llegan más rápido que 2/s se descarta el intermedio.
                if last.is_some_and(|l| now.duration_since(l) < STATS_MIN_GAP) {
                    continue;
                }
                last = Some(now);
                if !sink.send(StatsFeed::Sample { stats }) {
                    return;
                }
            }
            Err(e) => {
                sink.send(StatsFeed::Ended {
                    reason: EndReason::Error,
                    error: Some(e.into()),
                });
                return;
            }
        }
    }
    sink.send(StatsFeed::Ended {
        reason: EndReason::Eof,
        error: None,
    });
}

// --------------------------------------------------------------- registro

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    Events,
    Logs,
    Stats,
}

struct Entry {
    window: String,
    kind: StreamKind,
    handle: JoinHandle<()>,
}

/// Suscripciones activas, por ventana. Se cancelan al cerrar la ventana o salir.
#[derive(Default)]
pub struct StreamRegistry {
    inner: Mutex<HashMap<String, Entry>>,
}

/// Al terminar la tarea (por cualquier vía) se quita del registro.
struct RemoveOnDrop {
    registry: Arc<StreamRegistry>,
    id: String,
}

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        self.registry.lock().remove(&self.id);
    }
}

/// Aborta la tarea interna si se aborta la externa (un `JoinHandle` soltado no cancela).
struct AbortOnDrop(tokio::task::AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl StreamRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[cfg(test)]
    pub fn count(&self, window: &str, kind: StreamKind) -> usize {
        self.lock()
            .values()
            .filter(|e| e.window == window && e.kind == kind)
            .count()
    }

    #[cfg(test)]
    pub fn total(&self) -> usize {
        self.lock().len()
    }

    /// Lanza `body` como tarea supervisada. Si termina en pánico llama a `on_panic`.
    /// Debe llamarse dentro de un runtime tokio (los comandos async de Tauri lo están).
    pub fn spawn<F>(
        self: &Arc<Self>,
        window: &str,
        kind: StreamKind,
        body: F,
        on_panic: impl FnOnce() + Send + 'static,
    ) -> Result<String, ApiError>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let mut map = self.lock();
        match kind {
            // Un solo stream de eventos por ventana: el nuevo reemplaza al viejo.
            StreamKind::Events => {
                map.retain(|_, e| {
                    let stale = e.window == window && e.kind == StreamKind::Events;
                    if stale {
                        e.handle.abort();
                    }
                    !stale
                });
            }
            StreamKind::Logs | StreamKind::Stats => {
                let max = if kind == StreamKind::Logs {
                    MAX_LOG_STREAMS
                } else {
                    MAX_STATS_STREAMS
                };
                let n = map
                    .values()
                    .filter(|e| e.window == window && e.kind == kind)
                    .count();
                if n >= max {
                    return Err(ApiError::new(
                        ApiErrorCode::Conflict,
                        format!("demasiadas suscripciones abiertas (máximo {max})"),
                    ));
                }
            }
        }
        let id = uuid::Uuid::now_v7().to_string();
        let guard = RemoveOnDrop {
            registry: self.clone(),
            id: id.clone(),
        };
        let handle = tokio::spawn(async move {
            let _guard = guard;
            let inner = tokio::spawn(body);
            let _abort = AbortOnDrop(inner.abort_handle());
            if let Err(e) = inner.await
                && e.is_panic()
            {
                on_panic();
            }
        });
        map.insert(
            id.clone(),
            Entry {
                window: window.to_string(),
                kind,
                handle,
            },
        );
        Ok(id)
    }

    pub fn abort(&self, id: &str) -> bool {
        match self.lock().remove(id) {
            Some(e) => {
                e.handle.abort();
                true
            }
            None => false,
        }
    }

    pub fn abort_for_window(&self, window: &str) -> usize {
        let mut map = self.lock();
        let ids: Vec<String> = map
            .iter()
            .filter(|(_, e)| e.window == window)
            .map(|(k, _)| k.clone())
            .collect();
        for id in &ids {
            if let Some(e) = map.remove(id) {
                e.handle.abort();
            }
        }
        ids.len()
    }

    pub fn abort_all(&self) {
        for (_, e) in self.lock().drain() {
            e.handle.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use engine_core::testing::MockEngine;
    use engine_core::{EngineError, LogStream};
    use futures_util::stream;
    use tokio::sync::mpsc;

    use super::*;

    /// Sink de tests: reenvía a un canal y puede simular un destino cerrado.
    struct ChanSink<T>(mpsc::UnboundedSender<T>);

    impl<T: Send + 'static> Sink<T> for ChanSink<T> {
        fn send(&self, item: T) -> bool {
            self.0.send(item).is_ok()
        }
    }

    fn chan<T: Send + 'static>() -> (Arc<dyn Sink<T>>, mpsc::UnboundedReceiver<T>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(ChanSink(tx)), rx)
    }

    fn line(n: usize) -> LogLine {
        LogLine {
            stream: LogStream::Stdout,
            timestamp: None,
            message: format!("l{n}"),
            truncated: false,
        }
    }

    fn ev(kind: EngineEventKind, id: &str, action: &str) -> EngineEvent {
        EngineEvent {
            kind,
            action: action.into(),
            id: id.into(),
            name: None,
            time_nano: 0,
            attributes: Default::default(),
        }
    }

    #[test]
    fn coalescer_deduplica_por_kind_e_id_conservando_el_ultimo() {
        let mut c = EventCoalescer::default();
        c.push(ev(EngineEventKind::Container, "a", "start"));
        c.push(ev(EngineEventKind::Container, "b", "start"));
        c.push(ev(EngineEventKind::Container, "a", "die"));
        c.push(ev(EngineEventKind::Network, "a", "connect"));
        let out = c.drain();
        assert_eq!(out.len(), 3);
        assert_eq!((out[0].id.as_str(), out[0].action.as_str()), ("a", "die"));
        assert_eq!(out[1].id, "b");
        assert_eq!(out[2].kind, EngineEventKind::Network);
        assert!(c.is_empty());
    }

    #[test]
    fn coalescer_conserva_create_y_destroy_junto_a_start() {
        let mut c = EventCoalescer::default();
        c.push(ev(EngineEventKind::Container, "a", "create"));
        c.push(ev(EngineEventKind::Container, "a", "start"));
        c.push(ev(EngineEventKind::Container, "a", "die"));
        c.push(ev(EngineEventKind::Container, "a", "destroy"));
        c.push(ev(EngineEventKind::Container, "a", "create"));
        c.push(ev(EngineEventKind::Container, "a", "start"));
        let acts: Vec<String> = c.drain().into_iter().map(|e| e.action).collect();
        // start+die se funden (queda die); create/destroy se conservan.
        assert_eq!(acts, ["create", "die", "destroy", "create", "start"]);
        assert!(c.is_empty());
    }

    #[test]
    fn coalescer_pide_flush_al_llegar_al_tope() {
        let mut c = EventCoalescer::default();
        let mut full = false;
        for i in 0..EVENT_MAX_BATCH {
            full = c.push(ev(EngineEventKind::Container, &format!("c{i}"), "start"));
        }
        assert!(full);
    }

    #[tokio::test(start_paused = true)]
    async fn token_bucket_descarta_el_exceso_y_se_recarga() {
        let t0 = Instant::now();
        let mut b = TokenBucket::new(10.0, 10.0, t0);
        let ok = (0..25).filter(|_| b.try_take(t0)).count();
        assert_eq!(ok, 10);
        assert!(b.try_take(t0 + Duration::from_millis(500)));
    }

    #[tokio::test(start_paused = true)]
    async fn batcher_cuenta_dropped_y_flush_por_lineas() {
        let t0 = Instant::now();
        let mut b = LogBatcher::with_rate(1000.0, t0);
        let mut flushes = 0;
        for i in 0..1200 {
            if b.push(line(i), t0) {
                flushes += 1;
                assert!(b.take().is_some());
            }
        }
        assert_eq!(flushes, 3); // 1000 aceptadas => 3 lotes de 256 (768) + resto
        let Some(LogFeed::Lines { lines, dropped }) = b.take() else {
            panic!("lote")
        };
        assert_eq!(lines.len(), 1000 - 768);
        assert_eq!(dropped, 200);
    }

    #[tokio::test(start_paused = true)]
    async fn batcher_limita_bytes_por_segundo_aunque_las_lineas_sean_pocas() {
        let t0 = Instant::now();
        // Líneas casi ilimitadas, 10 KiB/s de presupuesto; cada línea cuesta 1000+32 bytes.
        let mut b = LogBatcher::with_rates(1e9, 10.0 * 1024.0, t0);
        let big = |n: usize| LogLine {
            stream: LogStream::Stdout,
            timestamp: None,
            message: "x".repeat(1000),
            truncated: n == 0,
        };
        for i in 0..100 {
            b.push(big(i), t0);
        }
        let Some(LogFeed::Lines { lines, dropped }) = b.take() else {
            panic!("lote")
        };
        assert_eq!(lines.len(), 9); // 9 * 1032 <= 10240 < 10 * 1032
        assert_eq!(dropped, 91);
        // Tras 1 s vuelve a haber saldo.
        assert!(b.push(big(1), t0 + Duration::from_secs(1)) || !b.lines.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn eventos_sin_datos_no_hacen_resync_cada_segundo() {
        let engine: Arc<dyn EngineClient> = Arc::new(MockEngine::new());
        let (sink, mut rx) = chan::<EngineFeed>();
        let t0 = Instant::now();
        let task = tokio::spawn(run_events(engine, sink));
        let mut at = Vec::new();
        while at.len() < 6 {
            if let Some(EngineFeed::Events { resync: true, .. }) = rx.recv().await {
                at.push(Instant::now().duration_since(t0));
            }
        }
        task.abort();
        let gaps: Vec<f64> = at.windows(2).map(|w| (w[1] - w[0]).as_secs_f64()).collect();
        // Backoff exponencial (con jitter <= 25 %): cada hueco supera al anterior...
        for w in gaps.windows(2) {
            assert!(w[1] > w[0], "huecos no crecientes: {gaps:?}");
        }
        // ...y con tope de 30 s (+ jitter).
        assert!(gaps.iter().all(|g| *g <= 37.6), "{gaps:?}");
        // Con el bug anterior habría un resync por segundo: 5 huecos de ~1 s.
        assert!(gaps.iter().sum::<f64>() > 20.0, "{gaps:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn run_logs_agrupa_y_termina_con_eof() {
        let (sink, mut rx) = chan::<LogFeed>();
        let items: Vec<Result<LogLine, EngineError>> = (0..10).map(|i| Ok(line(i))).collect();
        run_logs(Box::pin(stream::iter(items)), sink, false).await;
        // El reparto en lotes depende de qué rama del select gane: se suman todos.
        let (mut total, mut dropped_total) = (0, 0);
        loop {
            match rx.recv().await {
                Some(LogFeed::Lines { lines, dropped }) => {
                    total += lines.len();
                    dropped_total += dropped;
                }
                Some(end) => {
                    assert_eq!(
                        end,
                        LogFeed::Ended {
                            reason: EndReason::Eof,
                            error: None
                        }
                    );
                    break;
                }
                None => panic!("faltó el mensaje de fin"),
            }
        }
        assert_eq!((total, dropped_total), (10, 0));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn run_logs_con_follow_termina_como_container_stopped_y_reporta_errores() {
        let (sink, mut rx) = chan::<LogFeed>();
        run_logs(Box::pin(stream::empty()), sink, true).await;
        assert_eq!(
            rx.recv().await,
            Some(LogFeed::Ended {
                reason: EndReason::ContainerStopped,
                error: None
            })
        );
        let (sink, mut rx) = chan::<LogFeed>();
        let items: Vec<Result<LogLine, EngineError>> =
            vec![Ok(line(1)), Err(EngineError::NotFound("x".into()))];
        run_logs(Box::pin(stream::iter(items)), sink, true).await;
        assert!(matches!(rx.recv().await, Some(LogFeed::Lines { .. })));
        let Some(LogFeed::Ended { reason, error }) = rx.recv().await else {
            panic!("fin")
        };
        assert_eq!(reason, EndReason::Error);
        assert_eq!(error.map(|e| e.code), Some(ApiErrorCode::NotFound));
    }

    #[tokio::test(start_paused = true)]
    async fn run_logs_se_detiene_si_el_destino_se_cierra() {
        let (sink, rx) = chan::<LogFeed>();
        drop(rx);
        // Stream infinito: solo termina si la tarea nota que el destino desapareció.
        let inf = stream::iter(0usize..).map(|i| Ok::<_, EngineError>(line(i)));
        tokio::time::timeout(Duration::from_secs(5), run_logs(Box::pin(inf), sink, true))
            .await
            .expect("debe terminar al cerrarse el destino");
    }

    #[tokio::test(start_paused = true)]
    async fn run_stats_descarta_muestras_demasiado_seguidas() {
        let (sink, mut rx) = chan::<StatsFeed>();
        let mk = || MockEngine::new();
        let _ = mk();
        let s = || ContainerStats {
            read_at: String::new(),
            cpu_percent: 1.0,
            mem_used_bytes: 1,
            mem_limit_bytes: 2,
            mem_percent: 50.0,
            net_rx_bytes: 0,
            net_tx_bytes: 0,
            net_rx_bytes_per_sec: 0.0,
            net_tx_bytes_per_sec: 0.0,
            block_read_bytes: 0,
            block_write_bytes: 0,
            pids: 1,
        };
        // Tres muestras seguidas (mismo instante): pasa solo la primera.
        let items: Vec<Result<ContainerStats, EngineError>> = vec![Ok(s()), Ok(s()), Ok(s())];
        run_stats(Box::pin(stream::iter(items)), sink).await;
        assert!(matches!(rx.recv().await, Some(StatsFeed::Sample { .. })));
        assert!(matches!(
            rx.recv().await,
            Some(StatsFeed::Ended {
                reason: EndReason::Eof,
                ..
            })
        ));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn eventos_reconecta_y_pide_resync() {
        let engine: Arc<dyn EngineClient> = Arc::new(MockEngine::new());
        let (sink, mut rx) = chan::<EngineFeed>();
        let task = tokio::spawn(run_events(engine, sink));
        // El stream vacío termina de inmediato: se diagnostica (Connected) y se pide resync.
        assert!(matches!(
            rx.recv().await,
            Some(EngineFeed::Connection {
                status: ConnectionStatus::Connected { .. }
            })
        ));
        assert_eq!(
            rx.recv().await,
            Some(EngineFeed::Events {
                items: vec![],
                resync: true
            })
        );
        task.abort();
    }

    #[tokio::test]
    async fn registro_limites_por_ventana_y_cancelacion() {
        let reg = StreamRegistry::new();
        let pending = || std::future::pending::<()>();
        let mut ids = Vec::new();
        for _ in 0..MAX_LOG_STREAMS {
            ids.push(
                reg.spawn("main", StreamKind::Logs, pending(), || {})
                    .expect("cabe"),
            );
        }
        let err = reg
            .spawn("main", StreamKind::Logs, pending(), || {})
            .expect_err("excede");
        assert_eq!(err.code, ApiErrorCode::Conflict);
        // Otra ventana tiene su propio cupo.
        reg.spawn("otra", StreamKind::Logs, pending(), || {})
            .expect("otra ventana");
        assert_eq!(reg.count("main", StreamKind::Logs), MAX_LOG_STREAMS);
        // Eventos: el nuevo reemplaza al viejo.
        reg.spawn("main", StreamKind::Events, pending(), || {})
            .expect("ev1");
        reg.spawn("main", StreamKind::Events, pending(), || {})
            .expect("ev2");
        assert_eq!(reg.count("main", StreamKind::Events), 1);
        // unsubscribe y cierre de ventana.
        assert!(reg.abort(&ids[0]));
        assert!(!reg.abort(&ids[0]));
        assert_eq!(reg.abort_for_window("main"), MAX_LOG_STREAMS - 1 + 1);
        assert_eq!(reg.total(), 1);
        reg.abort_all();
        assert_eq!(reg.total(), 0);
    }

    #[tokio::test]
    async fn la_tarea_se_quita_sola_al_terminar_y_el_panico_se_informa() {
        let reg = StreamRegistry::new();
        let flag = Arc::new(AtomicUsize::new(0));
        let f2 = flag.clone();
        reg.spawn(
            "main",
            StreamKind::Logs,
            async { panic!("prueba de pánico en el stream") },
            move || {
                f2.fetch_add(1, Ordering::SeqCst);
            },
        )
        .expect("spawn");
        for _ in 0..100 {
            if reg.total() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(reg.total(), 0);
        assert_eq!(flag.load(Ordering::SeqCst), 1);
        // Un fin normal también limpia.
        reg.spawn("main", StreamKind::Stats, async {}, || {})
            .expect("spawn");
        for _ in 0..100 {
            if reg.total() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(reg.total(), 0);
    }

    #[tokio::test]
    async fn abortar_la_tarea_externa_aborta_la_interna() {
        let reg = StreamRegistry::new();
        let alive = Arc::new(AtomicUsize::new(0));
        struct Probe(Arc<AtomicUsize>);
        impl Drop for Probe {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let probe = Probe(alive.clone());
        let id = reg
            .spawn(
                "main",
                StreamKind::Logs,
                async move {
                    let _p = probe;
                    std::future::pending::<()>().await
                },
                || {},
            )
            .expect("spawn");
        tokio::time::sleep(Duration::from_millis(50)).await;
        reg.abort(&id);
        for _ in 0..100 {
            if alive.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            alive.load(Ordering::SeqCst),
            1,
            "el stream interno no se liberó"
        );
    }
}
