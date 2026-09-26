//! Mock de `ExecEngine`: sesión con canales, registra escrituras y cierres.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::stream;
use tokio::sync::mpsc;

use crate::client::EngineStream;
use crate::error::EngineError;
use crate::exec::{ExecControl, ExecEngine, ExecInfo, ExecRequest, ExecRisk, ExecSession};

/// Emisor de salida del shell simulado.
pub type OutputSender = mpsc::UnboundedSender<Result<Vec<u8>, EngineError>>;

/// Lo que el mock registró.
#[derive(Debug, Default, Clone)]
pub struct ExecLog {
    pub writes: Vec<Vec<u8>>,
    pub resizes: Vec<(u16, u16)>,
    pub closed: bool,
}

pub struct MockExec {
    pub log: Arc<Mutex<ExecLog>>,
    /// Salida que el mock emite al abrir; después el stream queda abierto hasta que se
    /// suelte el emisor devuelto por `take_output_sender`.
    pub risk: ExecRisk,
    sender: Mutex<Vec<OutputSender>>,
    /// Fallo al abrir (contenedor parado...).
    pub fail_open: Option<EngineError>,
    /// Código de salida que informa `exit_code()`.
    pub exit: Option<i64>,
}

impl Default for MockExec {
    fn default() -> Self {
        Self {
            log: Arc::default(),
            risk: ExecRisk::default(),
            sender: Mutex::new(Vec::new()),
            fail_open: None,
            exit: None,
        }
    }
}

impl MockExec {
    /// Mock cuyo proceso informa este código de salida.
    pub fn with_exit(code: i64) -> Self {
        Self {
            exit: Some(code),
            ..Self::default()
        }
    }

    /// Mock que falla al abrir la sesión.
    pub fn failing(err: EngineError) -> Self {
        Self {
            fail_open: Some(err),
            ..Self::default()
        }
    }

    /// Suelta el emisor guardado: si el test también suelta el suyo, el stream termina (EOF).
    pub fn clear_sender(&self) {
        self.sender
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// Emisor de la última sesión abierta (para simular salida del shell).
    pub fn output_sender(&self) -> Option<OutputSender> {
        self.sender
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .last()
            .cloned()
    }
}

struct MockControl {
    log: Arc<Mutex<ExecLog>>,
    exit: Option<i64>,
}

#[async_trait]
impl ExecControl for MockControl {
    async fn write(&mut self, data: &[u8]) -> Result<(), EngineError> {
        self.log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .writes
            .push(data.to_vec());
        Ok(())
    }

    async fn resize(&self, cols: u16, rows: u16) -> Result<(), EngineError> {
        self.log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .resizes
            .push((cols, rows));
        Ok(())
    }

    async fn close(self: Box<Self>) -> Result<Option<i64>, EngineError> {
        self.log.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
        Ok(None)
    }

    async fn exit_code(&self) -> Option<i64> {
        self.exit
    }
}

#[async_trait]
impl ExecEngine for MockExec {
    async fn open_exec(&self, req: ExecRequest) -> Result<ExecSession, EngineError> {
        if let Some(e) = &self.fail_open {
            return Err(e.clone());
        }
        crate::validate::container_id(&req.container)?;
        let (tx, mut rx) = mpsc::unbounded_channel::<Result<Vec<u8>, EngineError>>();
        self.sender
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(tx);
        let output: EngineStream<Vec<u8>> = Box::pin(stream::poll_fn(move |cx| rx.poll_recv(cx)));
        Ok(ExecSession {
            info: ExecInfo {
                exec_id: "exec-mock".into(),
                shell: "/bin/sh".into(),
                risk: self.risk,
            },
            output,
            control: Box::new(MockControl {
                log: self.log.clone(),
                exit: self.exit,
            }),
        })
    }
}
