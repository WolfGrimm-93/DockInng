//! Sesiones de terminal (exec) abiertas: feed hacia la UI, registro por ventana y bucle de sesión.
//!
//! Aislamiento: cada sesión pertenece a la ventana que la abrió; `exec_write/resize/close`
//! comprueban que la etiqueta de la ventana coincide (si no, `not_found`, sin revelar que
//! existe). La entrada usa un `mpsc` acotado por sesión (contrapresión: si se llena, la
//! terminal está saturada) y un límite de 1 MiB/s.
//!
//! Salida: se agrupa (16 ms / 32 KiB) y viaja en base64 (correcto con secuencias UTF-8
//! partidas entre fragmentos y con bytes de control). Tope sostenido de 8 MiB/s: al excederse
//! se DEJA DE LEER del stream (contrapresión TCP: el proceso se bloquea como en un terminal
//! lento); nunca se descarta salida de un TTY. La entrada del usuario (Ctrl-C) sigue
//! atendiéndose mientras la salida está frenada.
//!
//! Cierre: la sesión se cierra matando el shell (cascada del motor); si la tarea se aborta
//! (ventana cerrada, `unsubscribe`) un guardia lanza esa cascada en una tarea desacoplada.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use engine_core::{
    ApiError, ApiErrorCode, EngineClient, EngineError, ExecControl, ExecEngine, ExecRequest,
    ExecRisk, ExecSession,
};
use futures_util::StreamExt;
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::streams::{Sink, StreamKind, TokenBucket};

/// Capacidad de la cola de entrada por sesión.
pub const INPUT_QUEUE: usize = 64;
/// Máximo de bytes por `exec_write` (UTF-8 de `onData` de xterm).
pub const MAX_WRITE_BYTES: usize = engine_core::exec::MAX_WRITE_BYTES;
/// Entrada sostenida máxima por sesión (bytes/s) y ráfaga.
pub const INPUT_RATE: f64 = 1024.0 * 1024.0;
/// Agrupación de la salida.
pub const OUTPUT_FLUSH: Duration = Duration::from_millis(16);
pub const OUTPUT_MAX_CHUNK: usize = 32 * 1024;
/// Salida sostenida máxima (bytes/s) antes de frenar la lectura, y ráfaga permitida.
pub const OUTPUT_RATE: f64 = 8.0 * 1024.0 * 1024.0;
pub const OUTPUT_BURST: f64 = 2.0 * 1024.0 * 1024.0;
/// Máximo de cambios de tamaño aplicados por segundo (gana el último).
pub const RESIZE_MIN_GAP: Duration = Duration::from_millis(100);
/// Tope de la cascada de cierre.
pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
/// Tope de una escritura hacia el shell.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Espera del código de salida tras el EOF.
pub const EXIT_CODE_WAIT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecEndReason {
    ProcessExited,
    ContainerStopped,
    Closed,
    NoShell,
    Error,
    Internal,
}

/// Mensajes del canal de una terminal (`data` = base64 de bytes crudos).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecFeed {
    Opened {
        shell: String,
        risk: ExecRisk,
    },
    Output {
        data: String,
    },
    Ended {
        reason: ExecEndReason,
        exit_code: Option<i64>,
        error: Option<ApiError>,
    },
}

/// Órdenes de la UI hacia el bucle de la sesión.
#[derive(Debug)]
pub enum ExecCmd {
    Write(Vec<u8>),
    Resize(u16, u16),
    /// Cierra y mata el shell; avisa al terminar la cascada.
    Close(Option<oneshot::Sender<()>>),
}

struct SessionEntry {
    window: String,
    tx: mpsc::Sender<ExecCmd>,
    input: TokenBucket,
}

#[derive(Default)]
pub struct ExecSessions {
    inner: Mutex<HashMap<String, SessionEntry>>,
}

impl ExecSessions {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, SessionEntry>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Registra una sesión. Purga las que ya terminaron (su receptor se soltó).
    pub fn insert(&self, id: &str, window: &str, tx: mpsc::Sender<ExecCmd>) {
        let mut g = self.lock();
        g.retain(|_, e| !e.tx.is_closed());
        g.insert(
            id.to_string(),
            SessionEntry {
                window: window.to_string(),
                tx,
                input: TokenBucket::new(INPUT_RATE, INPUT_RATE, Instant::now()),
            },
        );
    }

    /// Cola de entrada de la sesión, solo si pertenece a `window`. Otra ventana o inexistente
    /// dan la misma respuesta.
    pub fn sender(&self, id: &str, window: &str) -> Result<mpsc::Sender<ExecCmd>, ApiError> {
        let mut g = self.lock();
        match g.get(id) {
            Some(e) if e.window == window && !e.tx.is_closed() => Ok(e.tx.clone()),
            Some(e) if e.tx.is_closed() => {
                g.remove(id);
                Err(not_found())
            }
            _ => Err(not_found()),
        }
    }

    /// Como `sender`, y además descuenta `bytes` del límite de entrada de la sesión.
    pub fn sender_for_write(
        &self,
        id: &str,
        window: &str,
        bytes: usize,
    ) -> Result<mpsc::Sender<ExecCmd>, ApiError> {
        let mut g = self.lock();
        match g.get_mut(id) {
            Some(e) if e.window == window && !e.tx.is_closed() => {
                if e.input.try_take_n(bytes as f64, Instant::now()) {
                    Ok(e.tx.clone())
                } else {
                    Err(ApiError::new(
                        ApiErrorCode::Conflict,
                        "terminal saturada: demasiada entrada por segundo",
                    ))
                }
            }
            _ => Err(not_found()),
        }
    }

    pub fn remove(&self, id: &str) {
        self.lock().remove(id);
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Cierra todas las sesiones (mata sus shells) esperando como mucho `limit` en total.
    pub async fn close_all(&self, limit: Duration) {
        let senders: Vec<mpsc::Sender<ExecCmd>> = self.lock().drain().map(|(_, e)| e.tx).collect();
        let mut acks = Vec::new();
        for tx in senders {
            let (ack_tx, ack_rx) = oneshot::channel();
            if tx.try_send(ExecCmd::Close(Some(ack_tx))).is_ok() {
                acks.push(ack_rx);
            }
        }
        let _ = tokio::time::timeout(limit, async {
            for a in acks {
                let _ = a.await;
            }
        })
        .await;
    }
}

fn not_found() -> ApiError {
    ApiError::new(ApiErrorCode::NotFound, "la terminal no existe")
}

// ------------------------------------------------------------------ comandos (lógica)

/// Abre una terminal: reserva cupo (4 por ventana), lanza la tarea y registra la sesión.
pub fn start_session(
    streams: &Arc<crate::streams::StreamRegistry>,
    sessions: &Arc<ExecSessions>,
    exec: Arc<dyn ExecEngine>,
    engine: Arc<dyn EngineClient>,
    window: &str,
    req: ExecRequest,
    sink: Arc<dyn Sink<ExecFeed>>,
) -> Result<String, ApiError> {
    let (tx, rx) = mpsc::channel(INPUT_QUEUE);
    let panic_sink = sink.clone();
    let id = streams.spawn(
        window,
        StreamKind::Exec,
        run_exec(exec, engine, req, sink, rx),
        move || {
            panic_sink.send(ExecFeed::Ended {
                reason: ExecEndReason::Internal,
                exit_code: None,
                error: None,
            });
        },
    )?;
    sessions.insert(&id, window, tx);
    Ok(id)
}

pub fn write_input(
    sessions: &ExecSessions,
    id: &str,
    window: &str,
    data: &str,
) -> Result<(), ApiError> {
    if data.len() > MAX_WRITE_BYTES {
        return Err(ApiError::new(
            ApiErrorCode::InvalidInput,
            format!("entrada demasiado grande (máximo {MAX_WRITE_BYTES} bytes por llamada)"),
        ));
    }
    if data.is_empty() {
        return Ok(());
    }
    let tx = sessions.sender_for_write(id, window, data.len())?;
    tx.try_send(ExecCmd::Write(data.as_bytes().to_vec()))
        .map_err(|_| ApiError::new(ApiErrorCode::Conflict, "terminal saturada"))
}

pub fn resize_terminal(
    sessions: &ExecSessions,
    id: &str,
    window: &str,
    cols: u16,
    rows: u16,
) -> Result<(), ApiError> {
    let (cols, rows) = engine_core::exec::clamp_size(cols, rows);
    let tx = sessions.sender(id, window)?;
    // Si la cola está llena se descarta: el próximo resize traerá el tamaño vigente.
    let _ = tx.try_send(ExecCmd::Resize(cols, rows));
    Ok(())
}

pub async fn close_session(
    sessions: &ExecSessions,
    id: &str,
    window: &str,
) -> Result<(), ApiError> {
    let tx = sessions.sender(id, window)?;
    sessions.remove(id);
    let (ack_tx, ack_rx) = oneshot::channel();
    if tokio::time::timeout(
        Duration::from_secs(1),
        tx.send(ExecCmd::Close(Some(ack_tx))),
    )
    .await
    .is_ok_and(|r| r.is_ok())
    {
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, ack_rx).await;
    }
    Ok(())
}

// --------------------------------------------------------------------- bucle de sesión

/// Si la tarea se aborta con el control aún dentro, lanza la cascada de cierre desacoplada.
struct CloseOnDrop(Option<Box<dyn ExecControl>>);

impl CloseOnDrop {
    fn control(&mut self) -> Option<&mut Box<dyn ExecControl>> {
        self.0.as_mut()
    }

    /// Cierre explícito (con tope); deja el guardia inerte.
    async fn close(&mut self) -> Option<i64> {
        let c = self.0.take()?;
        match tokio::time::timeout(CLOSE_TIMEOUT, c.close()).await {
            Ok(Ok(code)) => code,
            _ => None,
        }
    }

    /// El proceso ya terminó: no hay nada que matar.
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for CloseOnDrop {
    fn drop(&mut self) {
        if let Some(c) = self.0.take()
            && let Ok(h) = tokio::runtime::Handle::try_current()
        {
            h.spawn(async move {
                let _ = tokio::time::timeout(CLOSE_TIMEOUT, c.close()).await;
            });
        }
    }
}

fn encode_chunks(buf: &mut Vec<u8>, sink: &Arc<dyn Sink<ExecFeed>>) -> bool {
    for piece in buf.chunks(OUTPUT_MAX_CHUNK) {
        if !sink.send(ExecFeed::Output {
            data: STANDARD.encode(piece),
        }) {
            return false;
        }
    }
    buf.clear();
    true
}

fn ended(
    sink: &Arc<dyn Sink<ExecFeed>>,
    reason: ExecEndReason,
    exit_code: Option<i64>,
    error: Option<ApiError>,
) {
    sink.send(ExecFeed::Ended {
        reason,
        exit_code,
        error,
    });
}

/// Bucle de una sesión: abre el exec, reenvía salida, atiende la entrada y cierra.
pub async fn run_exec(
    exec: Arc<dyn ExecEngine>,
    engine: Arc<dyn EngineClient>,
    req: ExecRequest,
    sink: Arc<dyn Sink<ExecFeed>>,
    mut rx: mpsc::Receiver<ExecCmd>,
) {
    let container = req.container.clone();
    let session = match exec.open_exec(req).await {
        Ok(s) => s,
        Err(e) => {
            let no_shell = matches!(
                e,
                EngineError::Coded {
                    code: ApiErrorCode::NoShell,
                    ..
                }
            );
            let reason = if no_shell {
                ExecEndReason::NoShell
            } else {
                ExecEndReason::Error
            };
            ended(&sink, reason, None, Some(e.into()));
            return;
        }
    };
    let ExecSession {
        info,
        mut output,
        control,
    } = session;
    // Solo metadatos: NUNCA el contenido de la entrada o la salida.
    eprintln!(
        "terminal abierta: contenedor={container} exec={} shell={}",
        info.exec_id, info.shell
    );
    let mut guard = CloseOnDrop(Some(control));
    if !sink.send(ExecFeed::Opened {
        shell: info.shell.clone(),
        risk: info.risk,
    }) {
        return;
    }

    let mut buf: Vec<u8> = Vec::new();
    let mut flush_at: Option<Instant> = None;
    // Frenado de lectura: saldo de salida; negativo = hay que esperar.
    let mut allowance = OUTPUT_BURST;
    let mut last_refill = Instant::now();
    let mut resume_at: Option<Instant> = None;
    let mut last_resize: Option<Instant> = None;
    let mut pending_resize: Option<(u16, u16)> = None;

    loop {
        let throttled = resume_at.is_some();
        let far = Instant::now() + Duration::from_secs(3600);
        tokio::select! {
            biased;
            cmd = rx.recv() => match cmd {
                None => {
                    // La UI soltó la sesión sin cerrar: se mata el shell igualmente.
                    encode_chunks(&mut buf, &sink);
                    let code = guard.close().await;
                    ended(&sink, ExecEndReason::Closed, code, None);
                    return;
                }
                Some(ExecCmd::Write(data)) => {
                    // Una escritura atascada (shell detenido, pty lleno) no puede bloquear
                    // para siempre la salida ni el cierre.
                    let written = match guard.control() {
                        Some(c) => tokio::time::timeout(WRITE_TIMEOUT, c.write(&data))
                            .await
                            .unwrap_or(Err(EngineError::Timeout)),
                        None => Ok(()),
                    };
                    if let Err(e) = written {
                        // Escritura fallida: el shell ya no está (o la conexión cayó).
                        encode_chunks(&mut buf, &sink);
                        let code = guard.close().await;
                        ended(&sink, ExecEndReason::Error, code, Some(e.into()));
                        return;
                    }
                }
                Some(ExecCmd::Resize(c, r)) => {
                    pending_resize = Some((c, r));
                }
                Some(ExecCmd::Close(ack)) => {
                    encode_chunks(&mut buf, &sink);
                    let code = guard.close().await;
                    ended(&sink, ExecEndReason::Closed, code, None);
                    eprintln!("terminal cerrada: contenedor={container}");
                    if let Some(a) = ack {
                        let _ = a.send(());
                    }
                    return;
                }
            },
            item = output.next(), if !throttled => match item {
                Some(Ok(bytes)) => {
                    // Reposición del saldo y descuento de lo leído.
                    let now = Instant::now();
                    let dt = now.saturating_duration_since(last_refill).as_secs_f64();
                    last_refill = now;
                    allowance = (allowance + dt * OUTPUT_RATE).min(OUTPUT_BURST);
                    allowance -= bytes.len() as f64;
                    if allowance < 0.0 {
                        resume_at = Some(now + Duration::from_secs_f64(-allowance / OUTPUT_RATE));
                    }
                    buf.extend_from_slice(&bytes);
                    if buf.len() >= OUTPUT_MAX_CHUNK {
                        if !encode_chunks(&mut buf, &sink) {
                            return;
                        }
                        flush_at = None;
                    } else if flush_at.is_none() {
                        flush_at = Some(now + OUTPUT_FLUSH);
                    }
                }
                Some(Err(e)) => {
                    encode_chunks(&mut buf, &sink);
                    let code = guard.close().await;
                    ended(&sink, ExecEndReason::Error, code, Some(e.into()));
                    return;
                }
                None => {
                    // Fin del stream: el proceso terminó (o la conexión se cerró).
                    if !encode_chunks(&mut buf, &sink) {
                        return;
                    }
                    finish_after_eof(&mut guard, &engine, &container, &sink).await;
                    return;
                }
            },
            _ = tokio::time::sleep_until(flush_at.unwrap_or(far)), if flush_at.is_some() => {
                flush_at = None;
                if !encode_chunks(&mut buf, &sink) {
                    return;
                }
            }
            _ = tokio::time::sleep_until(resume_at.unwrap_or(far)), if throttled => {
                resume_at = None;
                allowance = 0.0;
                last_refill = Instant::now();
            }
            _ = tokio::time::sleep_until(resize_deadline(last_resize, pending_resize.is_some()).unwrap_or(far)),
                if pending_resize.is_some() => {
                if let (Some((c, r)), Some(ctl)) = (pending_resize.take(), guard.control()) {
                    let _ = ctl.resize(c, r).await;
                    last_resize = Some(Instant::now());
                }
            }
        }
    }
}

/// Instante en que se puede aplicar el resize pendiente (máx. 10/s, gana el último).
fn resize_deadline(last: Option<Instant>, pending: bool) -> Option<Instant> {
    if !pending {
        return None;
    }
    Some(match last {
        Some(t) => t + RESIZE_MIN_GAP,
        None => Instant::now(),
    })
}

/// Tras el EOF del stream: espera el código de salida (hasta 2 s) y distingue si el
/// contenedor paró.
async fn finish_after_eof(
    guard: &mut CloseOnDrop,
    engine: &Arc<dyn EngineClient>,
    container: &str,
    sink: &Arc<dyn Sink<ExecFeed>>,
) {
    let mut code = None;
    let deadline = Instant::now() + EXIT_CODE_WAIT;
    while let Some(c) = guard.control() {
        code = c.exit_code().await;
        if code.is_some() || Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // El proceso terminó (o ya no se puede saber): no hay shell que matar.
    if code.is_some() {
        guard.disarm();
    }
    let stopped = match engine.inspect_container(container).await {
        Ok(d) => !d.summary.state.is_live(),
        Err(_) => false,
    };
    let reason = if stopped {
        ExecEndReason::ContainerStopped
    } else {
        ExecEndReason::ProcessExited
    };
    eprintln!("terminal terminada: contenedor={container}");
    ended(sink, reason, code, None);
}
