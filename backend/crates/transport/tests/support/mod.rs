//! Fixture de `sshd` LOCAL y desechable para las pruebas vivas de SSH.
//!
//! Nunca toca `~/.ssh` ni `~/.ssh/config`: llave de usuario y host key nuevas en un tempdir,
//! `sshd` en 127.0.0.1:54110 como el usuario actual, y se mata por PID al soltar el fixture.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use engine_core::{ConnSpec, SshIdentity, SshMode};

pub const PORT: u16 = 54110;
const SSHD: &str = "/usr/bin/sshd";

/// Serializa los tests: comparten el puerto 54110.
pub static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// ¿Están activadas las pruebas vivas de SSH y existe `sshd`?
pub fn gate() -> bool {
    let on = |k: &str| std::env::var(k).as_deref() == Ok("1");
    if !(on("DOCKINNG_LIVE_TESTS") && on("DOCKINNG_LIVE_SSH")) {
        eprintln!("saltado: exige DOCKINNG_LIVE_TESTS=1 y DOCKINNG_LIVE_SSH=1");
        return false;
    }
    if !Path::new(SSHD).exists() {
        eprintln!("saltado: no existe {SSHD}");
        return false;
    }
    true
}

pub fn tempdir(tag: &str) -> PathBuf {
    let d = PathBuf::from("/tmp").join(format!(
        "dockinng-test-ssh-{tag}-{}",
        uuid::Uuid::now_v7().simple()
    ));
    std::fs::create_dir_all(&d).expect("tempdir");
    d
}

pub fn keygen(path: &Path) {
    let st = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(path)
        .status()
        .expect("ssh-keygen");
    assert!(st.success());
}

pub struct Sshd {
    pub dir: PathBuf,
    pub user: String,
    child: Child,
}

impl Sshd {
    pub fn start(tag: &str) -> Self {
        let dir = tempdir(tag);
        keygen(&dir.join("hostkey"));
        keygen(&dir.join("id"));
        std::fs::copy(dir.join("id.pub"), dir.join("authorized_keys")).expect("authorized_keys");
        let user = std::env::var("USER")
            .ok()
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| {
                let out = Command::new("id").arg("-un").output().expect("id -un");
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            });
        let cfg = format!(
            "Port {PORT}\nListenAddress 127.0.0.1\nHostKey {d}/hostkey\nAuthorizedKeysFile {d}/authorized_keys\n\
             PidFile {d}/sshd.pid\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n\
             PubkeyAuthentication yes\nStrictModes no\nAllowUsers {user}\nLogLevel ERROR\nPerSourcePenalties no\n",
            d = dir.display()
        );
        std::fs::write(dir.join("sshd_config"), cfg).expect("sshd_config");
        let child = Command::new(SSHD)
            .args(["-D", "-e", "-f"])
            .arg(dir.join("sshd_config"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("lanzar sshd");
        let start = Instant::now();
        while std::net::TcpStream::connect(("127.0.0.1", PORT)).is_err() {
            assert!(start.elapsed() < Duration::from_secs(5), "sshd no arrancó");
            std::thread::sleep(Duration::from_millis(50));
        }
        Self { dir, user, child }
    }

    pub fn identity(&self) -> PathBuf {
        self.dir.join("id")
    }

    pub fn known_hosts(&self) -> PathBuf {
        self.dir.join("known_hosts")
    }

    pub fn tunnels_dir(&self) -> PathBuf {
        self.dir.join("tunnels")
    }

    pub fn spec_with(&self, identity: &Path, port: u16) -> ConnSpec {
        ConnSpec::Ssh {
            name: "fixture".into(),
            host: "127.0.0.1".into(),
            port: u32::from(port),
            user: self.user.clone(),
            mode: SshMode::Explicit,
            identity: SshIdentity::File {
                path: identity.to_string_lossy().into_owned(),
            },
        }
    }

    pub fn spec(&self) -> ConnSpec {
        self.spec_with(&self.identity(), PORT)
    }
}

impl Drop for Sshd {
    fn drop(&mut self) {
        // Solo el PID propio (nunca `pkill -f`).
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// ¿Sigue vivo el proceso `pid`? (`kill(pid, 0)`).
pub fn pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}
