//! Lanzador falso para tests: reproduce salidas guardadas (fixtures reales) con tiempos, códigos
//! de salida y reacción a SIGTERM/SIGKILL, y registra comandos, entorno y señales.

use std::ffi::OsString;
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::AsyncWriteExt;
use tokio::sync::{Notify, oneshot};

use crate::args::CommandSpec;
use crate::proc::{ChildHandle, ExitInfo, Spawn, Spawned};

#[derive(Clone, Debug)]
pub enum Step {
    Line(String),
    Sleep(Duration),
}

#[derive(Clone, Debug)]
pub struct Script {
    pub steps: Vec<Step>,
    pub stdout: String,
    pub exit_code: i32,
    /// Al recibir SIGTERM: líneas finales y código de salida; `None` = ignora SIGTERM.
    pub on_term: Option<(Vec<String>, i32)>,
    /// El lanzamiento falla con `NotFound` (binario ausente).
    pub not_found: bool,
}

impl Default for Script {
    fn default() -> Self {
        Self {
            steps: vec![],
            stdout: String::new(),
            exit_code: 0,
            on_term: Some((vec![], 1)),
            not_found: false,
        }
    }
}

impl Script {
    /// Reproduce un fixture NDJSON línea a línea.
    pub fn lines(text: &str) -> Self {
        Self {
            steps: text.lines().map(|l| Step::Line(l.to_string())).collect(),
            ..Self::default()
        }
    }
    pub fn exit(mut self, code: i32) -> Self {
        self.exit_code = code;
        self
    }
    pub fn stdout(mut self, s: &str) -> Self {
        self.stdout = s.to_string();
        self
    }
    pub fn then_sleep(mut self, d: Duration) -> Self {
        self.steps.push(Step::Sleep(d));
        self
    }
    pub fn ignoring_term(mut self) -> Self {
        self.on_term = None;
        self
    }
    pub fn on_term(mut self, lines: &[&str], code: i32) -> Self {
        self.on_term = Some((lines.iter().map(|s| (*s).to_string()).collect(), code));
        self
    }
    pub fn missing() -> Self {
        Self {
            not_found: true,
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug)]
pub struct Call {
    pub display: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: String,
    pub stdin: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct FakeSpawn {
    rules: Mutex<Vec<(String, Script)>>,
    pub calls: Arc<Mutex<Vec<Call>>>,
    /// "term" / "kill" en orden de llegada.
    pub signals: Arc<Mutex<Vec<&'static str>>>,
}

impl FakeSpawn {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Si el comando contiene `needle` se usa `script`. La primera regla que coincide gana.
    pub fn on(&self, needle: &str, script: Script) -> &Self {
        self.rules
            .lock()
            .unwrap()
            .push((needle.to_string(), script));
        self
    }

    /// Reglas básicas de detección de Compose 5.5.1.
    pub fn with_compose_5(self: Arc<Self>) -> Arc<Self> {
        self.on(
            "compose version",
            Script::default().stdout("{\"version\":\"5.5.1\"}\n"),
        );
        self.on(
            "--version",
            Script::default().stdout("Docker version 29.8.0\n"),
        );
        self
    }

    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    pub fn displays(&self) -> Vec<String> {
        self.calls().into_iter().map(|c| c.display).collect()
    }

    pub fn signals(&self) -> Vec<&'static str> {
        self.signals.lock().unwrap().clone()
    }
}

struct FakeChild {
    exit: Option<oneshot::Receiver<ExitInfo>>,
    term: Arc<Notify>,
    kill: Arc<Notify>,
    signals: Arc<Mutex<Vec<&'static str>>>,
}

impl Drop for FakeChild {
    /// Como la guardia real: soltar el manejador con el proceso vivo manda SIGTERM.
    fn drop(&mut self) {
        if self.exit.is_some() {
            self.signals.lock().unwrap().push("drop_term");
            self.term.notify_one();
        }
    }
}

#[async_trait]
impl ChildHandle for FakeChild {
    async fn wait(&mut self) -> io::Result<ExitInfo> {
        match self.exit.take() {
            Some(rx) => rx
                .await
                .map_err(|_| io::Error::other("proceso falso perdido")),
            None => Err(io::Error::other("ya esperado")),
        }
    }
    fn term(&mut self) {
        self.signals.lock().unwrap().push("term");
        self.term.notify_one();
    }
    fn kill(&mut self) {
        self.signals.lock().unwrap().push("kill");
        self.kill.notify_one();
    }
}

#[async_trait]
impl Spawn for FakeSpawn {
    async fn spawn(
        &self,
        spec: &CommandSpec,
        env: &[(OsString, OsString)],
        cwd: &Path,
        stdin: Option<Vec<u8>>,
    ) -> io::Result<Spawned> {
        let display = spec.display();
        let script = {
            let rules = self.rules.lock().unwrap();
            rules
                .iter()
                .find(|(n, _)| display.contains(n.as_str()))
                .map(|(_, s)| s.clone())
                .unwrap_or_default()
        };
        self.calls.lock().unwrap().push(Call {
            display: display.clone(),
            args: spec
                .args
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect(),
            env: env
                .iter()
                .map(|(k, v)| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.to_string_lossy().into_owned(),
                    )
                })
                .collect(),
            cwd: cwd.to_string_lossy().into_owned(),
            stdin,
        });
        if script.not_found {
            return Err(io::Error::from(io::ErrorKind::NotFound));
        }
        let (mut err_w, err_r) = tokio::io::duplex(1024 * 1024);
        let (mut out_w, out_r) = tokio::io::duplex(1024 * 1024);
        let (exit_tx, exit_rx) = oneshot::channel();
        let term = Arc::new(Notify::new());
        let kill = Arc::new(Notify::new());
        let (t2, k2) = (term.clone(), kill.clone());
        tokio::spawn(async move {
            let _ = out_w.write_all(script.stdout.as_bytes()).await;
            drop(out_w);
            let mut code = script.exit_code;
            let mut killed = false;
            let mut terminated = false;
            'steps: for step in &script.steps {
                match step {
                    Step::Line(l) => {
                        if err_w.write_all(format!("{l}\n").as_bytes()).await.is_err() {
                            break 'steps;
                        }
                    }
                    Step::Sleep(d) => {
                        let sleep = tokio::time::sleep(*d);
                        tokio::pin!(sleep);
                        loop {
                            tokio::select! {
                                _ = &mut sleep => break,
                                _ = t2.notified(), if !terminated => {
                                    if let Some((lines, c)) = &script.on_term {
                                        for l in lines {
                                            let _ = err_w.write_all(format!("{l}\n").as_bytes()).await;
                                        }
                                        code = *c;
                                        break 'steps;
                                    }
                                    terminated = true;
                                }
                                _ = k2.notified() => { killed = true; break 'steps; }
                            }
                        }
                    }
                }
            }
            drop(err_w);
            let info = if killed {
                ExitInfo {
                    code: None,
                    signal: Some(9),
                }
            } else {
                ExitInfo {
                    code: Some(code),
                    signal: None,
                }
            };
            let _ = exit_tx.send(info);
        });
        Ok(Spawned {
            stdout: Box::new(out_r),
            stderr: Box::new(err_r),
            child: Box::new(FakeChild {
                exit: Some(exit_rx),
                term,
                kill,
                signals: self.signals.clone(),
            }),
        })
    }
}
