//! Servicio de stacks de la app: lista/lectura con descubrimiento por labels y operaciones con
//! progreso en vivo (una tarea supervisada por operación, cancelable por ventana).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use engine_core::{
    ApiError, ApiErrorCode, CancelSignal, ComposeContainer, StackControl, StackDiscovery,
    StackFiles, StackOp, StackOpFeed, StackOutcome, StackSink, StackSummary,
};
use tokio::sync::oneshot;

use crate::streams::{Sink, StreamKind, StreamRegistry};

/// Máximo de entradas de cancelación vivas (defensa; el registro real limita a 3 por ventana).
const MAX_CANCEL_ENTRIES: usize = 64;

struct OpEntry {
    window: String,
    cancel: oneshot::Sender<()>,
}

pub struct StackService {
    pub discovery: Arc<dyn StackDiscovery>,
    pub control: Arc<dyn StackControl>,
    ops: Mutex<HashMap<String, OpEntry>>,
}

impl StackService {
    pub fn new(discovery: Arc<dyn StackDiscovery>, control: Arc<dyn StackControl>) -> Arc<Self> {
        Arc::new(Self {
            discovery,
            control,
            ops: Mutex::new(HashMap::new()),
        })
    }

    fn ops(&self) -> MutexGuard<'_, HashMap<String, OpEntry>> {
        self.ops.lock().unwrap_or_else(|e| e.into_inner())
    }

    async fn containers(&self) -> Result<Vec<ComposeContainer>, ApiError> {
        Ok(self.discovery.list_compose_containers().await?)
    }

    /// Lista única para la página y el contador del sidebar.
    pub async fn list_stacks(&self) -> Result<Vec<StackSummary>, ApiError> {
        let containers = self.containers().await?;
        Ok(self.control.list_stacks(containers).await?)
    }

    pub async fn read(&self, name: &str) -> Result<StackFiles, ApiError> {
        // Solo los stacks descubiertos necesitan los contenedores (para las labels).
        let containers = match self.control.origin_of(name).await {
            Ok(Some(_)) => Vec::new(),
            _ => self.containers().await?,
        };
        Ok(self.control.stack_read(name, containers).await?)
    }

    /// Vincula un compose externo; los contenedores se usan para detectar choques de nombre.
    pub async fn link(&self, path: &str) -> Result<String, ApiError> {
        let containers = self.containers().await?;
        Ok(self.control.stack_link(path, containers).await?)
    }

    pub async fn summary_of(&self, name: &str) -> Result<StackSummary, ApiError> {
        self.list_stacks()
            .await?
            .into_iter()
            .find(|s| s.name == name)
            .ok_or_else(|| ApiError::new(ApiErrorCode::NotFound, "stack no encontrado"))
    }

    /// Hay sitio para registrar una cancelación (tras purgar las de tareas terminadas).
    fn has_capacity(&self) -> bool {
        let mut ops = self.ops();
        ops.retain(|_, e| !e.cancel.is_closed());
        ops.len() < MAX_CANCEL_ENTRIES
    }

    /// Registra la cancelación; si no cabe devuelve `false` (la operación NO debe continuar).
    fn register(&self, id: String, window: &str, cancel: oneshot::Sender<()>) -> bool {
        let mut ops = self.ops();
        ops.retain(|_, e| !e.cancel.is_closed());
        if ops.len() >= MAX_CANCEL_ENTRIES {
            return false;
        }
        ops.insert(
            id,
            OpEntry {
                window: window.to_string(),
                cancel,
            },
        );
        true
    }

    /// Cancela con limpieza (SIGTERM → `Ended{canceled}`). Solo la ventana dueña; otra recibe
    /// `not_found` (no revela la existencia de la operación).
    pub fn cancel(&self, window: &str, id: &str) -> Result<(), ApiError> {
        let mut ops = self.ops();
        match ops.get(id) {
            Some(e) if e.window == window => {}
            _ => {
                return Err(ApiError::new(
                    ApiErrorCode::NotFound,
                    "operación no encontrada",
                ));
            }
        }
        if let Some(e) = ops.remove(id) {
            // Si la tarea ya terminó el envío falla: no es un error.
            let _ = e.cancel.send(());
        }
        Ok(())
    }
}

/// Valida y reserva la operación (errores devueltos al llamador) y lanza la tarea supervisada.
/// Devuelve el id de suscripción (también válido para `unsubscribe`, que aborta duro y mata el
/// subproceso por la guardia de `compose`).
pub async fn start_stack_op(
    streams: &Arc<StreamRegistry>,
    stacks: &Arc<StackService>,
    window: &str,
    name: &str,
    op: StackOp,
    sink: Arc<dyn Sink<StackOpFeed>>,
) -> Result<String, ApiError> {
    if !stacks.has_capacity() {
        return Err(ApiError::new(
            ApiErrorCode::Conflict,
            "demasiadas operaciones de stack en curso",
        ));
    }
    let prepared = stacks.control.prepare_op(name, op).await?;
    let (tx, rx) = oneshot::channel::<()>();
    // Un emisor soltado NO cuenta como cancelación: solo un `send` explícito.
    let cancel: CancelSignal = Box::pin(async move {
        if rx.await.is_err() {
            std::future::pending::<()>().await;
        }
    });
    let out = sink.clone();
    let feed: StackSink = Arc::new(move |ev: StackOpFeed| {
        out.send(ev);
    });
    let panic_sink = sink;
    let id = streams.spawn(
        window,
        StreamKind::StackOp,
        async move {
            prepared.run(feed, cancel).await;
        },
        move || {
            panic_sink.send(StackOpFeed::Ended {
                outcome: StackOutcome::Failed,
                exit_code: None,
                error: Some(ApiError::new(
                    ApiErrorCode::Internal,
                    "la operación terminó de forma inesperada",
                )),
                issues: vec![],
            });
        },
    )?;
    if !stacks.register(id.clone(), window, tx) {
        // Sin poder cancelarla no se deja correr: se aborta (la guardia mata el subproceso).
        streams.abort(&id);
        return Err(ApiError::new(
            ApiErrorCode::Conflict,
            "demasiadas operaciones de stack en curso",
        ));
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::testing_stacks::MockStacks;

    #[test]
    fn sin_sitio_para_cancelar_no_se_registra() {
        let m = Arc::new(MockStacks::default());
        let svc = StackService::new(m.clone(), m);
        let mut keep = Vec::new();
        for i in 0..MAX_CANCEL_ENTRIES {
            let (tx, rx) = oneshot::channel();
            assert!(svc.register(format!("id{i}"), "main", tx));
            keep.push(rx);
        }
        assert!(!svc.has_capacity());
        let (tx, _rx) = oneshot::channel();
        assert!(!svc.register("extra".into(), "main", tx));
        // Al terminar tareas (receptores soltados) vuelve a haber sitio.
        drop(keep);
        assert!(svc.has_capacity());
    }
}
