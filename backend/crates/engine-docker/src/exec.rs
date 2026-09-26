//! Terminal real (exec con TTY) sobre bollard.
//!
//! Hallazgos verificados que condicionan el diseño:
//! - Soltar el stream o cerrar la escritura (EOF) NO mata el shell: queda vivo dentro del
//!   contenedor. `close()` lo mata con un segundo exec `kill -HUP <pid-en-contenedor>`
//!   (`-TERM` no mata un shell interactivo). El pid sale de `/proc/<pid-host>/status`
//!   (`NSpid`), legible sin privilegios: solo motor local. En remoto el respaldo es escribir
//!   `Ctrl-C` y `exit` (límite documentado).
//! - Un shell inexistente no es un error HTTP: la salida trae "OCI runtime exec failed" y el
//!   código 126/127. Por eso una sonda previa decide `bash`/`sh`/`no_shell`.
//! - Bug conocido de bollard con TTY: un fragmento de salida que empieza por el byte 0, 1 o 2
//!   se interpreta como cabecera multiplexada y se pierde (ver test live de regresión).

use std::pin::Pin;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bollard::Docker;
use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};
use engine_core::exec::{clamp_size, parse_nspid, risk_from_inspect};
use engine_core::{
    ApiErrorCode, EngineError, EngineStream, ExecControl, ExecEngine, ExecInfo, ExecRequest,
    ExecSession, validate,
};
use futures_util::StreamExt;
use tokio::io::{AsyncWrite, AsyncWriteExt};

use crate::{DockerEngine, Endpoint, error_map, map};

/// Tamaño de lectura por fragmento de salida.
const OUTPUT_CAPACITY: usize = 64 * 1024;
/// Espera máxima de la sonda de shell.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// Espera máxima de la cascada de cierre por cada paso.
const KILL_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_STEP: Duration = Duration::from_millis(25);
/// Teclas de desacople. VERIFICADO en vivo: el daemon aplica por defecto `ctrl-p,ctrl-q` a los
/// exec por API y cierra la sesión ("read escape sequence"), y una cadena vacía NO lo
/// desactiva. Se sustituye por una secuencia de cuatro teclas de control que un usuario no
/// teclea nunca (NUL y RS), para que Ctrl-P/Ctrl-Q lleguen al shell (historial de bash, etc.).
const DETACH_KEYS: &str = "ctrl-@,ctrl-^,ctrl-@,ctrl-^";

type Input = Pin<Box<dyn AsyncWrite + Send>>;

/// Opciones de un exec sin TTY y sin entrada (sonda y kill).
fn quiet_exec(cmd: Vec<String>) -> CreateExecOptions<String> {
    CreateExecOptions {
        attach_stdin: Some(false),
        attach_stdout: Some(false),
        attach_stderr: Some(false),
        tty: Some(false),
        cmd: Some(cmd),
        ..Default::default()
    }
}

/// Lanza un exec desacoplado y espera a que termine; devuelve su código de salida.
async fn run_quiet(
    d: &Docker,
    container: &str,
    cmd: Vec<String>,
    timeout: Duration,
) -> Result<i64, EngineError> {
    let created = map(d.create_exec(container, quiet_exec(cmd)).await)?;
    let started = d
        .start_exec(
            &created.id,
            Some(StartExecOptions {
                detach: true,
                tty: false,
                output_capacity: None,
            }),
        )
        .await;
    if let Err(e) = started {
        return Err(error_map::classify(&e));
    }
    let deadline = Instant::now() + timeout;
    loop {
        let i = map(d.inspect_exec(&created.id).await)?;
        if i.running == Some(false) {
            return Ok(i.exit_code.unwrap_or(-1));
        }
        if Instant::now() >= deadline {
            return Err(EngineError::Timeout);
        }
        tokio::time::sleep(POLL_STEP).await;
    }
}

/// Decide el shell: `/bin/bash` si existe, si no `/bin/sh`; sin `/bin/sh` => `no_shell`.
async fn probe_shell(d: &Docker, container: &str) -> Result<&'static str, EngineError> {
    let no_shell = || {
        EngineError::coded(
            ApiErrorCode::NoShell,
            "el contenedor no tiene /bin/sh: no se puede abrir una terminal",
        )
    };
    let cmd = vec!["/bin/sh".into(), "-c".into(), "[ -x /bin/bash ]".into()];
    match run_quiet(d, container, cmd, PROBE_TIMEOUT).await {
        Ok(0) => Ok("/bin/bash"),
        Ok(126) | Ok(127) => Err(no_shell()),
        // 1 = no hay bash (o cualquier otro código): sh.
        Ok(_) => Ok("/bin/sh"),
        Err(EngineError::Engine { message, .. } | EngineError::InvalidInput(message))
            if message.contains("no such file")
                || message.contains("not found")
                || message.contains("executable file") =>
        {
            Err(no_shell())
        }
        Err(e) => Err(e),
    }
}

/// Lee `NSpid` de `/proc/<pid>/status` y comprueba que el proceso pertenece al contenedor
/// (su `cgroup` contiene el id completo). `None` si no se puede afirmar (motor remoto,
/// otro namespace de pids, proceso ya terminado).
async fn container_pid_of(host_pid: i64, container_id: &str) -> Option<u32> {
    if host_pid <= 1 || container_id.len() < 12 {
        return None;
    }
    let status = tokio::fs::read_to_string(format!("/proc/{host_pid}/status"))
        .await
        .ok()?;
    let cgroup = tokio::fs::read_to_string(format!("/proc/{host_pid}/cgroup"))
        .await
        .ok()?;
    if !cgroup.contains(container_id) {
        return None;
    }
    parse_nspid(&status)
}

struct DockerExecControl {
    docker: Docker,
    exec_id: String,
    container_id: String,
    /// Detrás de un `Mutex` async para que el control sea `Sync` (el escritor de bollard no lo es).
    input: tokio::sync::Mutex<Input>,
    /// Solo con socket Unix local se puede leer `/proc` del host.
    local: bool,
}

impl DockerExecControl {
    async fn inspect(&self) -> Option<(bool, Option<i64>, Option<i64>)> {
        let i = self.docker.inspect_exec(&self.exec_id).await.ok()?;
        Some((i.running.unwrap_or(false), i.exit_code, i.pid))
    }

    /// Espera (acotada) a que el proceso deje de correr.
    async fn wait_stopped(&self, limit: Duration) -> Option<Option<i64>> {
        let deadline = Instant::now() + limit;
        loop {
            match self.inspect().await {
                Some((false, code, _)) => return Some(code),
                None => return None,
                _ => {}
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(POLL_STEP).await;
        }
    }
}

#[async_trait]
impl ExecControl for DockerExecControl {
    async fn write(&mut self, data: &[u8]) -> Result<(), EngineError> {
        let mut input = self.input.lock().await;
        let r = async {
            input.write_all(data).await?;
            input.flush().await
        }
        .await;
        r.map_err(|_| EngineError::Conflict("la terminal ya no está conectada".into()))
    }

    async fn resize(&self, cols: u16, rows: u16) -> Result<(), EngineError> {
        let (cols, rows) = clamp_size(cols, rows);
        map(self
            .docker
            .resize_exec(
                &self.exec_id,
                ResizeExecOptions {
                    width: cols,
                    height: rows,
                },
            )
            .await)
    }

    async fn close(self: Box<Self>) -> Result<Option<i64>, EngineError> {
        // 0. ¿Ya terminó? Entonces no hay nada que matar.
        let Some((running, code, host_pid)) = self.inspect().await else {
            return Ok(None);
        };
        if !running {
            return Ok(code);
        }
        // 1. Cascada verificada: `kill -HUP` con el pid que ve el contenedor.
        if self.local
            && let Some(pid) = host_pid
            && let Some(inner) = container_pid_of(pid, &self.container_id).await
        {
            // `inner` es un entero validado (solo dígitos, > 1): se interpola sin riesgo.
            let cmd = vec!["/bin/sh".into(), "-c".into(), format!("kill -HUP {inner}")];
            let _ = run_quiet(&self.docker, &self.container_id, cmd, KILL_TIMEOUT).await;
            if let Some(code) = self.wait_stopped(KILL_TIMEOUT).await {
                return Ok(code);
            }
        }
        // 2. Respaldo (motor remoto o pid no verificable): Ctrl-C y `exit`.
        let _ = tokio::time::timeout(Duration::from_millis(500), async {
            let mut input = self.input.lock().await;
            let _ = input.write_all(b"\x03exit\n").await;
            let _ = input.flush().await;
        })
        .await;
        if let Some(code) = self.wait_stopped(Duration::from_secs(1)).await {
            return Ok(code);
        }
        // 3. Se sueltan los streams al salir; puede quedar el shell (límite documentado).
        Ok(None)
    }

    async fn exit_code(&self) -> Option<i64> {
        match self.inspect().await {
            Some((false, code, _)) => code,
            _ => None,
        }
    }
}

#[async_trait]
impl ExecEngine for DockerEngine {
    async fn open_exec(&self, req: ExecRequest) -> Result<ExecSession, EngineError> {
        validate::container_id(&req.container)?;
        let (cols, rows) = clamp_size(req.cols, req.rows);
        let d = self.client().await?;

        // El backend no confía en la UI: comprueba que el contenedor corre.
        let inspect = map(d.inspect_container(&req.container, None).await)?;
        let running = inspect
            .state
            .as_ref()
            .is_some_and(|s| s.running == Some(true) && s.paused != Some(true));
        if !running {
            return Err(EngineError::Conflict(
                "el contenedor no está en ejecución".into(),
            ));
        }
        let container_id = inspect.id.clone().unwrap_or_else(|| req.container.clone());
        let risk = risk_from_inspect(&serde_json::to_value(&inspect).unwrap_or_default());

        let shell = probe_shell(&d, &container_id).await?;

        // Sin usuario, directorio, privilegios ni entorno elegibles.
        let created = map(d
            .create_exec(
                &container_id,
                CreateExecOptions {
                    attach_stdin: Some(true),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    tty: Some(true),
                    detach_keys: Some(DETACH_KEYS.to_string()),
                    cmd: Some(vec![shell.to_string()]),
                    env: Some(vec!["TERM=xterm-256color".to_string()]),
                    ..Default::default()
                },
            )
            .await)?;
        let started = map(d
            .start_exec(
                &created.id,
                Some(StartExecOptions {
                    detach: false,
                    tty: true,
                    output_capacity: Some(OUTPUT_CAPACITY),
                }),
            )
            .await)?;
        let StartExecResults::Attached { output, input } = started else {
            return Err(EngineError::Protocol(
                "el daemon no adjuntó la terminal".into(),
            ));
        };
        // Tamaño inicial (el pty nace de 80x24).
        let _ = d
            .resize_exec(
                &created.id,
                ResizeExecOptions {
                    width: cols,
                    height: rows,
                },
            )
            .await;

        let output: EngineStream<Vec<u8>> = Box::pin(output.filter_map(|r| async move {
            match r {
                Ok(LogOutput::StdIn { .. }) => None,
                Ok(o) => Some(Ok(o.into_bytes().to_vec())),
                Err(e) => Some(Err(error_map::classify(&e))),
            }
        }));
        let local = matches!(self.endpoint(), Endpoint::Unix(_));
        Ok(ExecSession {
            info: ExecInfo {
                exec_id: created.id.clone(),
                shell: shell.to_string(),
                risk,
            },
            output,
            control: Box::new(DockerExecControl {
                docker: d,
                exec_id: created.id,
                container_id,
                input: tokio::sync::Mutex::new(input),
                local,
            }),
        })
    }
}
