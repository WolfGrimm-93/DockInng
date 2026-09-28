//! Descarga de imagen con progreso hacia la UI: mensajes del canal, bucle de la tarea y
//! exclusión de descargas repetidas de la misma referencia en una ventana.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use engine_core::pull::PullTracker;
use engine_core::{ApiError, ApiErrorCode, EngineStream, LayerProgress, PullEvent};
use futures_util::StreamExt;
use serde::Serialize;
use tokio::time::Instant;

use crate::streams::Sink;

/// Coalescencia del progreso.
pub const PULL_FLUSH: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PullOutcome {
    Done,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PullFeed {
    Started {
        reference: String,
    },
    /// Instantánea completa, coalescida a 100 ms.
    Progress {
        layers: Vec<LayerProgress>,
        done_bytes: u64,
        total_bytes: u64,
    },
    Ended {
        outcome: PullOutcome,
        up_to_date: bool,
        digest: Option<String>,
        error: Option<ApiError>,
    },
}

/// Descargas activas por (ventana, referencia): una a la vez por referencia.
#[derive(Default)]
pub struct PullGuards {
    active: Mutex<HashSet<(String, String)>>,
}

/// Se libera al soltarse (fin normal, error o tarea abortada).
pub struct PullPermit {
    guards: Arc<PullGuards>,
    key: (String, String),
}

impl Drop for PullPermit {
    fn drop(&mut self) {
        self.guards.lock().remove(&self.key);
    }
}

impl PullGuards {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn lock(&self) -> MutexGuard<'_, HashSet<(String, String)>> {
        self.active.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Descargas en curso.
    pub fn active_count(&self) -> usize {
        self.lock().len()
    }

    pub fn acquire(
        self: &Arc<Self>,
        window: &str,
        reference: &str,
    ) -> Result<PullPermit, ApiError> {
        let key = (window.to_string(), reference.to_string());
        if !self.lock().insert(key.clone()) {
            return Err(ApiError::new(
                ApiErrorCode::Conflict,
                "ya hay una descarga en curso de esa imagen",
            ));
        }
        Ok(PullPermit {
            guards: self.clone(),
            key,
        })
    }
}

fn progress(t: &PullTracker) -> PullFeed {
    let s = t.snapshot();
    PullFeed::Progress {
        layers: s.layers,
        done_bytes: s.done_bytes,
        total_bytes: s.total_bytes,
    }
}

/// Bucle de la descarga. Soltar la tarea suelta el stream y aborta la descarga en el daemon.
pub async fn run_pull(
    reference: String,
    mut stream: EngineStream<PullEvent>,
    sink: Arc<dyn Sink<PullFeed>>,
    _permit: PullPermit,
) {
    if !sink.send(PullFeed::Started { reference }) {
        return;
    }
    let mut tracker = PullTracker::new();
    let mut sent_rev = 0u64;
    let mut flush_at: Option<Instant> = None;
    let far = || Instant::now() + Duration::from_secs(3600);
    loop {
        tokio::select! {
            item = stream.next() => match item {
                Some(Ok(ev)) => {
                    tracker.feed(&ev);
                    if tracker.revision() != sent_rev && flush_at.is_none() {
                        flush_at = Some(Instant::now() + PULL_FLUSH);
                    }
                }
                Some(Err(e)) => {
                    if tracker.revision() != sent_rev && !sink.send(progress(&tracker)) {
                        return;
                    }
                    sink.send(PullFeed::Ended {
                        outcome: PullOutcome::Error,
                        up_to_date: false,
                        digest: None,
                        error: Some(e.into()),
                    });
                    return;
                }
                None => {
                    if tracker.revision() != sent_rev && !sink.send(progress(&tracker)) {
                        return;
                    }
                    sink.send(PullFeed::Ended {
                        outcome: PullOutcome::Done,
                        up_to_date: tracker.up_to_date(),
                        digest: tracker.digest().map(String::from),
                        error: None,
                    });
                    return;
                }
            },
            _ = tokio::time::sleep_until(flush_at.unwrap_or_else(far)), if flush_at.is_some() => {
                flush_at = None;
                sent_rev = tracker.revision();
                if !sink.send(progress(&tracker)) {
                    return;
                }
            }
        }
    }
}
