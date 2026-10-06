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

/// Shell según el código de salida de la sonda `[ -x /bin/bash ]`: 0 = bash; 126/127 = no hay
/// ejecutable (`None` => `no_shell`); cualquier otro código (p. ej. 1) = no hay bash, sh.
fn shell_for_probe_exit(code: i64) -> Option<&'static str> {
    match code {
        0 => Some("/bin/bash"),
        126 | 127 => None,
        _ => Some("/bin/sh"),
    }
}

/// Un error del daemon que significa "ese ejecutable no existe" (la sonda no llega a ejecutar).
fn is_missing_shell_message(message: &str) -> bool {
    message.contains("no such file")
        || message.contains("not found")
        || message.contains("executable file")
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
        Ok(code) => shell_for_probe_exit(code).ok_or_else(no_shell),
        Err(EngineError::Engine { message, .. } | EngineError::InvalidInput(message))
            if is_missing_shell_message(&message) =>
        {
            Err(no_shell())
        }
        Err(e) => Err(e),
    }
}

/// Estado de un exec: (corriendo, código de salida, pid del proceso en el host).
type ExecState = Option<(bool, Option<i64>, Option<i64>)>;

/// Qué hace `close` a partir del estado leído: terminar ya o cascada de cierre.
#[derive(Debug, PartialEq, Eq)]
enum ClosePlan {
    /// Ya no corre (o no existe): se devuelve su código; no hay nada que matar.
    Finished(Option<i64>),
    /// Sigue corriendo: hay que intentar cerrarlo.
    Running { host_pid: Option<i64> },
}

fn close_plan(state: ExecState) -> ClosePlan {
    match state {
        None => ClosePlan::Finished(None),
        Some((false, code, _)) => ClosePlan::Finished(code),
        Some((true, _, host_pid)) => ClosePlan::Running { host_pid },
    }
}

/// Pid (dentro del contenedor) al que se manda `kill -HUP`. Solo con socket local y pid del
/// host conocido; en remoto no se puede verificar el namespace, así que no hay objetivo.
fn hup_target(local: bool, host_pid: Option<i64>, container_pid: Option<u32>) -> Option<u32> {
    if local && host_pid.is_some() {
        container_pid
    } else {
        None
    }
}

/// Comando del exec de cierre. El pid es un entero ya validado (solo dígitos, > 1).
fn kill_command(container_pid: u32) -> Vec<String> {
    vec![
        "/bin/sh".into(),
        "-c".into(),
        format!("kill -HUP {container_pid}"),
    ]
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
        let host_pid = match close_plan(self.inspect().await) {
            ClosePlan::Finished(code) => return Ok(code),
            ClosePlan::Running { host_pid } => host_pid,
        };
        // 1. Cascada verificada: `kill -HUP` con el pid que ve el contenedor.
        let inner = match host_pid {
            Some(pid) if self.local => container_pid_of(pid, &self.container_id).await,
            _ => None,
        };
        if let Some(inner) = hup_target(self.local, host_pid, inner) {
            let _ = run_quiet(
                &self.docker,
                &self.container_id,
                kill_command(inner),
                KILL_TIMEOUT,
            )
            .await;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sonda_de_shell_por_codigo_de_salida() {
        assert_eq!(shell_for_probe_exit(0), Some("/bin/bash"));
        // 1 = no hay bash: sh.
        assert_eq!(shell_for_probe_exit(1), Some("/bin/sh"));
        assert_eq!(shell_for_probe_exit(2), Some("/bin/sh"));
        // Sin ejecutable: no hay terminal posible.
        assert_eq!(shell_for_probe_exit(126), None);
        assert_eq!(shell_for_probe_exit(127), None);
    }

    #[test]
    fn mensajes_de_shell_inexistente_del_daemon() {
        assert!(is_missing_shell_message(
            "OCI runtime exec failed: exec: \"/bin/sh\": stat /bin/sh: no such file or directory"
        ));
        assert!(is_missing_shell_message(
            "exec failed: executable file not found in $PATH"
        ));
        assert!(!is_missing_shell_message(
            "error de red al hablar con el daemon"
        ));
    }

    #[test]
    fn cierre_ya_terminado_no_mata_nada() {
        // Sin exec (inspect falló) o ya parado: se devuelve su código y no hay cascada.
        assert_eq!(close_plan(None), ClosePlan::Finished(None));
        assert_eq!(
            close_plan(Some((false, Some(130), Some(42)))),
            ClosePlan::Finished(Some(130))
        );
        assert_eq!(
            close_plan(Some((true, None, Some(42)))),
            ClosePlan::Running { host_pid: Some(42) }
        );
    }

    #[test]
    fn hup_solo_con_socket_local_y_pid_verificado() {
        // Remoto: no se puede verificar el namespace de pids => no hay objetivo.
        assert_eq!(hup_target(false, Some(42), Some(7)), None);
        // Local sin pid del host: no hay de dónde partir.
        assert_eq!(hup_target(true, None, Some(7)), None);
        // Local con pid del host pero no verificado dentro del contenedor.
        assert_eq!(hup_target(true, Some(42), None), None);
        // Local y verificado.
        assert_eq!(hup_target(true, Some(42), Some(7)), Some(7));
    }

    #[test]
    fn comando_de_cierre_interpola_solo_el_pid_validado() {
        assert_eq!(
            kill_command(7),
            vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "kill -HUP 7".to_string()
            ]
        );
    }
}
