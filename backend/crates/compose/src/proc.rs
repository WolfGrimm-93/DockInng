//! Lanzador de subprocesos seguro: argumentos como array (jamás shell), entorno limpio con lista
//! blanca, grupo de procesos propio, señales por grupo y guardia contra huérfanos.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::args::CommandSpec;
use crate::progress::MAX_LINE_LEN;

/// Variables que se heredan tal cual. Todo lo demás se descarta (en particular `COMPOSE_FILE`,
/// `COMPOSE_PROJECT_NAME`, `COMPOSE_ENV_FILES` y `DOCKER_HOST`, que se fija aparte).
const ENV_ALLOW: [&str; 13] = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LANGUAGE",
    "TZ",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "SSH_AUTH_SOCK",
    "TERM",
];
const DEFAULT_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

/// Construye el entorno del hijo a partir de las variables del proceso (lista blanca) y fuerza
/// `DOCKER_HOST` al endpoint de DockInng. Con `DOCKER_HOST` forzado se descarta `DOCKER_CONTEXT`
/// (el contexto de la CLI no debe desviar la conexión).
pub fn build_env<I>(vars: I, docker_host: Option<&str>) -> Vec<(OsString, OsString)>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    let mut out: Vec<(OsString, OsString)> = Vec::new();
    for (k, v) in vars {
        let Some(name) = k.to_str() else { continue };
        let allowed =
            ENV_ALLOW.contains(&name) || name.starts_with("LC_") || name.starts_with("XDG_");
        if !allowed || (docker_host.is_some() && name == "DOCKER_CONTEXT") {
            continue;
        }
        if v.to_string_lossy().contains('\0') {
            continue;
        }
        out.push((k, v));
    }
    if !out.iter().any(|(k, _)| k == "PATH") {
        out.push(("PATH".into(), DEFAULT_PATH.into()));
    }
    if let Some(h) = docker_host {
        out.push(("DOCKER_HOST".into(), h.into()));
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

impl ExitInfo {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
}

pub type BoxRead = Box<dyn AsyncRead + Send + Unpin>;

#[async_trait]
pub trait ChildHandle: Send {
    async fn wait(&mut self) -> io::Result<ExitInfo>;
    /// SIGTERM al grupo de procesos.
    fn term(&mut self);
    /// SIGKILL al grupo de procesos.
    fn kill(&mut self);
}

pub struct Spawned {
    pub stdout: BoxRead,
    pub stderr: BoxRead,
    pub child: Box<dyn ChildHandle>,
}

/// Abstracción del lanzador (los tests inyectan uno falso).
#[async_trait]
pub trait Spawn: Send + Sync {
    async fn spawn(
        &self,
        spec: &CommandSpec,
        env: &[(OsString, OsString)],
        cwd: &Path,
        stdin: Option<Vec<u8>>,
    ) -> io::Result<Spawned>;
}

/// Lanzador real con `tokio::process`.
pub struct TokioSpawn;

struct TokioChild {
    child: Option<tokio::process::Child>,
    pgid: Option<i32>,
    /// El hijo directo (líder del grupo) ya salió y fue reapeado.
    leader_reaped: bool,
    /// El GRUPO entero quedó vacío (o rematado). Solo entonces no queda nada que señalar:
    /// `wait()` puede cancelarse entre `leader_reaped` y este punto, y el grupo seguiría vivo.
    group_done: bool,
}

/// ¿Queda algún miembro vivo en el grupo `pgid`?
fn group_alive(pgid: i32) -> bool {
    // SAFETY: `kill(-pgid, 0)` solo comprueba si existe algún miembro.
    unsafe { libc::kill(-pgid, 0) == 0 }
}

impl TokioChild {
    fn signal(&self, sig: i32) {
        let Some(pgid) = self.pgid else { return };
        if self.group_done {
            return;
        }
        // Con el líder ya reapeado el id solo es nuestro mientras el grupo tenga miembros (un
        // grupo vacío puede reasignarse): sin miembros no se señala nada.
        if self.leader_reaped && !group_alive(pgid) {
            return;
        }
        // SAFETY: `kill` con un pgid propio (process_group(0)) y una señal válida.
        unsafe {
            libc::kill(-pgid, sig);
        }
    }
}

#[async_trait]
impl ChildHandle for TokioChild {
    async fn wait(&mut self) -> io::Result<ExitInfo> {
        use std::os::unix::process::ExitStatusExt;
        let Some(child) = self.child.as_mut() else {
            return Err(io::Error::other("proceso ya liberado"));
        };
        let st = child.wait().await?;
        self.leader_reaped = true;
        // El hijo directo (`docker`) pudo salir dejando al plugin de Compose vivo en el grupo:
        // se espera y, pasada la gracia, se remata el grupo entero (sin huérfanos). Si esta
        // futura se cancela aquí, `group_done` sigue en `false` y `kill`/`Drop` terminan el trabajo.
        reap_group(self.pgid, GROUP_GRACE).await;
        self.group_done = true;
        Ok(ExitInfo {
            code: st.code(),
            signal: st.signal(),
        })
    }
    fn term(&mut self) {
        self.signal(libc::SIGTERM);
    }
    fn kill(&mut self) {
        self.signal(libc::SIGKILL);
    }
}

impl Drop for TokioChild {
    /// Sin huérfanos: si el hijo sigue vivo al soltar el manejador (ventana destruida, tarea
    /// abortada) se le manda SIGTERM ya y una tarea desacoplada lo remata con SIGKILL a los 5 s.
    fn drop(&mut self) {
        if self.group_done {
            return;
        }
        let pgid = self.pgid;
        // El líder ya salió pero el grupo seguía vivo (`wait()` cancelado durante la espera del
        // grupo): SIGTERM ya y remate con SIGKILL pasada la gracia, sin volver a esperar al líder.
        if self.leader_reaped {
            if let Some(pgid) = pgid.filter(|p| group_alive(*p)) {
                // SAFETY: el grupo tiene miembros, así que el id no puede haberse reasignado.
                unsafe {
                    libc::kill(-pgid, libc::SIGTERM);
                }
                match tokio::runtime::Handle::try_current() {
                    Ok(h) => {
                        h.spawn(reap_group(Some(pgid), GROUP_GRACE));
                    }
                    Err(_) => {
                        // SAFETY: ver arriba.
                        unsafe {
                            libc::kill(-pgid, libc::SIGKILL);
                        }
                    }
                }
            }
            return;
        }
        let Some(mut child) = self.child.take() else {
            return;
        };
        if let Some(pgid) = pgid {
            // SAFETY: ver `signal`.
            unsafe {
                libc::kill(-pgid, libc::SIGTERM);
            }
        }
        match tokio::runtime::Handle::try_current() {
            Ok(h) => {
                h.spawn(async move {
                    if tokio::time::timeout(Duration::from_secs(5), child.wait())
                        .await
                        .is_err()
                    {
                        if let Some(pgid) = pgid {
                            // SAFETY: el hijo NO fue reapeado (seguimos esperándolo).
                            unsafe {
                                libc::kill(-pgid, libc::SIGKILL);
                            }
                        }
                        let _ = child.wait().await;
                    }
                    // Tras salir el hijo directo, rematar a los que hayan quedado en el grupo.
                    reap_group(pgid, GROUP_GRACE).await;
                });
            }
            Err(_) => {
                if let Some(pgid) = pgid {
                    // SAFETY: ver arriba.
                    unsafe {
                        libc::kill(-pgid, libc::SIGKILL);
                    }
                }
            }
        }
    }
}

#[async_trait]
impl Spawn for TokioSpawn {
    async fn spawn(
        &self,
        spec: &CommandSpec,
        env: &[(OsString, OsString)],
        cwd: &Path,
        stdin: Option<Vec<u8>>,
    ) -> io::Result<Spawned> {
        let mut cmd = tokio::process::Command::new(&spec.program);
        cmd.args(&spec.args)
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k.as_os_str(), v.as_os_str())))
            .current_dir(cwd)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = cmd.spawn()?;
        let pgid = child.id().and_then(|p| i32::try_from(p).ok());
        if let (Some(data), Some(mut si)) = (stdin, child.stdin.take()) {
            // Tarea desacoplada: si Compose cierra stdin antes de leer todo, se ignora el error.
            tokio::spawn(async move {
                let _ = si.write_all(&data).await;
                let _ = si.shutdown().await;
            });
        }
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("sin stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| io::Error::other("sin stderr"))?;
        Ok(Spawned {
            stdout: Box::new(stdout),
            stderr: Box::new(stderr),
            child: Box::new(TokioChild {
                child: Some(child),
                pgid,
                leader_reaped: false,
                group_done: false,
            }),
        })
    }
}

/// Gracia para que los miembros restantes del grupo (el plugin de Compose) terminen tras la
/// salida del hijo directo, antes de rematarlos.
const GROUP_GRACE: Duration = Duration::from_secs(5);

/// Espera a que el grupo quede vacío; pasada la gracia, SIGKILL a los que queden. El líder ya
/// fue reapeado, así que mientras haya miembros el id del grupo no puede reasignarse.
async fn reap_group(pgid: Option<i32>, grace: Duration) {
    let Some(pgid) = pgid else { return };
    let start = tokio::time::Instant::now();
    loop {
        // SAFETY: `kill(-pgid, 0)` solo comprueba si existe algún miembro.
        if unsafe { libc::kill(-pgid, 0) } != 0 {
            return;
        }
        if start.elapsed() >= grace {
            // SAFETY: el grupo existe (comprobado arriba).
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Lector de líneas acotado y seguro ante cancelación (el estado vive en la estructura, así
/// que perder la futura dentro de un `select!` no pierde datos).
pub struct LineReader {
    reader: BufReader<BoxRead>,
    buf: Vec<u8>,
    overflow: bool,
    /// Bytes totales leídos.
    pub total: u64,
}

impl LineReader {
    pub fn new(r: BoxRead) -> Self {
        Self {
            reader: BufReader::with_capacity(16 * 1024, r),
            buf: Vec::new(),
            overflow: false,
            total: 0,
        }
    }

    fn take_line(&mut self) -> String {
        let line = String::from_utf8_lossy(&self.buf).into_owned();
        self.buf.clear();
        self.overflow = false;
        line.trim_end_matches('\r').to_string()
    }

    /// Siguiente línea (máx. `MAX_LINE_LEN`; el excedente se descarta). `None` = EOF.
    pub async fn next(&mut self) -> io::Result<Option<String>> {
        loop {
            let chunk = self.reader.fill_buf().await?;
            if chunk.is_empty() {
                if self.buf.is_empty() && !self.overflow {
                    return Ok(None);
                }
                return Ok(Some(self.take_line()));
            }
            let nl = chunk.iter().position(|b| *b == b'\n');
            let end = nl.unwrap_or(chunk.len());
            let room = MAX_LINE_LEN.saturating_sub(self.buf.len());
            let take = end.min(room);
            self.buf.extend_from_slice(&chunk[..take]);
            if take < end {
                self.overflow = true;
            }
            let consumed = nl.map_or(chunk.len(), |i| i + 1);
            self.total += consumed as u64;
            self.reader.consume(consumed);
            if nl.is_some() {
                return Ok(Some(self.take_line()));
            }
        }
    }
}

/// Lee hasta `cap` bytes. Devuelve (datos, excedió). No sigue leyendo tras exceder.
pub async fn read_capped<R: AsyncRead + Unpin>(
    mut r: R,
    cap: usize,
) -> io::Result<(Vec<u8>, bool)> {
    let mut out = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = r.read(&mut chunk).await?;
        if n == 0 {
            return Ok((out, false));
        }
        if out.len() + n > cap {
            out.extend_from_slice(&chunk[..cap.saturating_sub(out.len())]);
            return Ok((out, true));
        }
        out.extend_from_slice(&chunk[..n]);
    }
}

/// Directorio de trabajo neutro para procesos sin proyecto.
pub fn neutral_cwd() -> PathBuf {
    PathBuf::from("/")
}

pub fn os(s: &str) -> &OsStr {
    OsStr::new(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(list: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        list.iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }

    #[test]
    fn entorno_limpio_con_lista_blanca() {
        let env = build_env(
            vars(&[
                ("PATH", "/usr/bin"),
                ("HOME", "/home/u"),
                ("LC_ALL", "C"),
                ("XDG_RUNTIME_DIR", "/run/user/1000"),
                ("COMPOSE_FILE", "/etc/passwd"),
                ("COMPOSE_PROJECT_NAME", "x"),
                ("COMPOSE_ENV_FILES", "/x"),
                ("DOCKER_HOST", "tcp://evil:2375"),
                ("DOCKER_CONTEXT", "otro"),
                ("SECRETO_API_KEY", "abc"),
                ("AWS_SECRET_ACCESS_KEY", "x"),
                ("LD_PRELOAD", "/tmp/x.so"),
            ]),
            Some("unix:///run/docker.sock"),
        );
        let names: Vec<_> = env.iter().map(|(k, _)| k.to_str().unwrap()).collect();
        for gone in [
            "COMPOSE_FILE",
            "COMPOSE_PROJECT_NAME",
            "COMPOSE_ENV_FILES",
            "DOCKER_CONTEXT",
            "SECRETO_API_KEY",
            "AWS_SECRET_ACCESS_KEY",
            "LD_PRELOAD",
        ] {
            assert!(!names.contains(&gone), "{gone}");
        }
        assert!(names.contains(&"PATH") && names.contains(&"HOME") && names.contains(&"LC_ALL"));
        let host: Vec<_> = env.iter().filter(|(k, _)| k == "DOCKER_HOST").collect();
        assert_eq!(host.len(), 1, "DOCKER_HOST heredado descartado y forzado");
        assert_eq!(host[0].1, "unix:///run/docker.sock");
    }

    #[test]
    fn sin_path_hay_uno_por_defecto_y_sin_endpoint_no_hay_host() {
        let env = build_env(vars(&[("HOME", "/h"), ("DOCKER_CONTEXT", "c")]), None);
        assert!(env.iter().any(|(k, v)| k == "PATH" && v == DEFAULT_PATH));
        assert!(env.iter().all(|(k, _)| k != "DOCKER_HOST"));
        assert!(env.iter().any(|(k, _)| k == "DOCKER_CONTEXT"));
    }

    #[tokio::test]
    async fn line_reader_trunca_lineas_enormes_y_conserva_el_resto() {
        let mut data = vec![b'a'; MAX_LINE_LEN * 3];
        data.extend_from_slice(b"\nsiguiente\r\nultima");
        let mut r = LineReader::new(Box::new(std::io::Cursor::new(data)));
        let l1 = r.next().await.unwrap().unwrap();
        assert_eq!(l1.len(), MAX_LINE_LEN);
        assert_eq!(r.next().await.unwrap().unwrap(), "siguiente");
        assert_eq!(r.next().await.unwrap().unwrap(), "ultima");
        assert_eq!(r.next().await.unwrap(), None);
    }

    #[tokio::test]
    async fn read_capped_corta() {
        let (d, over) = read_capped(std::io::Cursor::new(vec![1u8; 100]), 10)
            .await
            .unwrap();
        assert_eq!((d.len(), over), (10, true));
        let (d, over) = read_capped(std::io::Cursor::new(vec![1u8; 10]), 10)
            .await
            .unwrap();
        assert_eq!((d.len(), over), (10, false));
    }

    #[tokio::test]
    async fn spawn_real_sin_shell_entorno_limpio_y_sigterm_al_grupo() {
        // `sh` solo como binario de prueba controlado por el test (no por entrada externa).
        let spec = CommandSpec {
            program: "sh".into(),
            args: vec![
                "-c".into(),
                "echo \"[$SECRETO]\"; echo err >&2; exec sleep 30".into(),
            ],
        };
        let env = build_env(vars(&[("PATH", "/usr/bin:/bin")]), None);
        let mut sp = TokioSpawn
            .spawn(&spec, &env, Path::new("/"), None)
            .await
            .unwrap();
        let mut out = LineReader::new(sp.stdout);
        assert_eq!(out.next().await.unwrap().unwrap(), "[]");
        let mut err = LineReader::new(sp.stderr);
        assert_eq!(err.next().await.unwrap().unwrap(), "err");
        sp.child.term();
        let info = tokio::time::timeout(Duration::from_secs(5), sp.child.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(info.signal, Some(libc::SIGTERM));
    }

    #[tokio::test]
    async fn stdin_se_entrega_al_hijo() {
        let spec = CommandSpec {
            program: "cat".into(),
            args: vec![],
        };
        let env = build_env(vars(&[("PATH", "/usr/bin:/bin")]), None);
        let mut sp = TokioSpawn
            .spawn(&spec, &env, Path::new("/"), Some(b"hola\n".to_vec()))
            .await
            .unwrap();
        let mut out = LineReader::new(sp.stdout);
        assert_eq!(out.next().await.unwrap().unwrap(), "hola");
        assert!(sp.child.wait().await.unwrap().success());
    }

    #[tokio::test]
    async fn soltar_el_manejador_no_deja_huerfanos() {
        let spec = CommandSpec {
            program: "sleep".into(),
            args: vec!["300".into()],
        };
        let env = build_env(vars(&[("PATH", "/usr/bin:/bin")]), None);
        let sp = TokioSpawn
            .spawn(&spec, &env, Path::new("/"), None)
            .await
            .unwrap();
        // pid vía /proc: buscamos el hijo directo de este proceso con cmdline exacta.
        let me = std::process::id();
        let pid = find_child_sleep(me).expect("hijo sleep");
        drop(sp.child);
        // SIGTERM inmediato: en pocos ms el proceso deja de existir (o queda zombi reapeado).
        for _ in 0..50 {
            if !proc_alive(pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("el hijo {pid} sigue vivo tras soltar el manejador");
    }

    #[tokio::test]
    async fn nietos_que_ignoran_sigterm_se_rematan_tras_la_gracia() {
        // El shell muere con SIGTERM pero su hijo lo ignora: queda vivo en el grupo (como el
        // plugin de Compose tras salir `docker`). `wait` no vuelve hasta rematarlo.
        let spec = CommandSpec {
            program: "sh".into(),
            args: vec!["-c".into(), "(trap '' TERM; exec sleep 313) & wait".into()],
        };
        let env = build_env(vars(&[("PATH", "/usr/bin:/bin")]), None);
        let mut sp = TokioSpawn
            .spawn(&spec, &env, Path::new("/"), None)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(find_by_cmdline(b"sleep\x00313").is_some(), "nieto vivo");
        sp.child.term();
        let started = std::time::Instant::now();
        sp.child.wait().await.unwrap();
        assert!(
            started.elapsed() >= Duration::from_secs(4),
            "espera la gracia"
        );
        assert!(
            find_by_cmdline(b"sleep\x00313").is_none(),
            "el nieto fue rematado"
        );
    }

    fn find_by_cmdline(needle: &[u8]) -> Option<u32> {
        for e in std::fs::read_dir("/proc").ok()?.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
                continue;
            };
            let Ok(cmd) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
                continue;
            };
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
                continue;
            };
            if cmd.windows(needle.len()).any(|w| w == needle) && !stat.contains(") Z ") {
                return Some(pid);
            }
        }
        None
    }

    fn proc_alive(pid: u32) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map(|s| !s.contains(") Z "))
            .unwrap_or(false)
    }

    fn find_child_sleep(parent: u32) -> Option<u32> {
        for e in std::fs::read_dir("/proc").ok()?.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
                continue;
            };
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
                continue;
            };
            let after = stat.rsplit_once(") ")?.1;
            let mut it = after.split_whitespace();
            let _state = it.next();
            let ppid: u32 = it.next()?.parse().ok()?;
            let cmd = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
            if ppid == parent && cmd.starts_with(b"sleep\x00300") {
                return Some(pid);
            }
        }
        None
    }

    /// ¿Existe el proceso `pid`? (`kill(pid, 0)`; un zombi cuenta como vivo, y aquí no hay).
    fn alive(pid: i32) -> bool {
        // SAFETY: señal 0 solo comprueba existencia.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Lanza `sh -c <script>` con el lanzador real y devuelve el manejador y el pid que imprimió.
    async fn lanzar(script: &str) -> (Box<dyn ChildHandle>, i32) {
        use tokio::io::AsyncBufReadExt;
        let spec = CommandSpec {
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
        };
        let sp = TokioSpawn
            .spawn(
                &spec,
                &[("PATH".into(), "/usr/bin:/bin".into())],
                Path::new("/"),
                None,
            )
            .await
            .unwrap();
        let mut lines = tokio::io::BufReader::new(sp.stdout).lines();
        let pid: i32 = lines
            .next_line()
            .await
            .unwrap()
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        (sp.child, pid)
    }

    async fn espera_muerte(pid: i32, hasta: Duration) -> bool {
        let t = tokio::time::Instant::now();
        while t.elapsed() < hasta {
            if !alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        !alive(pid)
    }

    /// Regresión (auditoría M4): el hijo directo sale pero deja un nieto en el grupo (como el
    /// plugin de Compose). Si `wait()` se cancela durante la espera del grupo, el `Drop` debe
    /// rematar al nieto igualmente (antes `reaped = true` desactivaba señales y Drop).
    #[tokio::test]
    async fn cancelar_wait_durante_la_espera_del_grupo_no_deja_huerfanos() {
        let (mut child, nieto) = lanzar("sleep 60 & echo $!; exit 0").await;
        assert!(alive(nieto));
        // Cancela `wait()` a mitad de `reap_group` (el nieto sigue vivo en el grupo).
        let r = tokio::time::timeout(Duration::from_millis(300), child.wait()).await;
        assert!(r.is_err(), "wait debería seguir esperando al grupo");
        drop(child);
        assert!(
            espera_muerte(nieto, Duration::from_secs(8)).await,
            "el nieto quedó huérfano"
        );
    }

    #[tokio::test]
    async fn kill_tras_cancelar_wait_tambien_alcanza_al_grupo() {
        let (mut child, nieto) = lanzar("sleep 60 & echo $!; exit 0").await;
        let _ = tokio::time::timeout(Duration::from_millis(300), child.wait()).await;
        child.kill();
        assert!(espera_muerte(nieto, Duration::from_secs(3)).await);
    }

    #[tokio::test]
    async fn wait_normal_remata_al_grupo_y_no_toca_a_otros() {
        let (mut child, nieto) = lanzar("sleep 60 & echo $!; exit 0").await;
        let ajeno = tokio::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .unwrap();
        let ajeno_pid = ajeno.id().unwrap() as i32;
        let info = child.wait().await.unwrap();
        assert!(info.success());
        assert!(espera_muerte(nieto, Duration::from_secs(1)).await);
        assert!(alive(ajeno_pid), "no debe matar procesos de otro grupo");
        // SAFETY: matamos nuestro propio `sleep` de prueba.
        unsafe { libc::kill(ajeno_pid, libc::SIGKILL) };
    }
}
