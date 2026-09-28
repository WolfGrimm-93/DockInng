//! Detección de Podman: solo mira si hay un socket compatible con la API de Docker en los
//! sitios habituales. No ejecuta `podman` ni habla con el socket: es una lista de candidatos
//! para que la UI ofrezca "Local (Podman)" como un `Endpoint::Unix` más.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Un socket de Podman encontrado.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PodmanCandidate {
    /// Ruta absoluta del socket.
    pub path: String,
    /// `true` = socket del usuario (rootless).
    pub rootless: bool,
    /// De dónde salió: `container_host`, `xdg_runtime_dir`, `run_user` o `system`.
    pub source: String,
}

/// Entorno relevante (inyectable para tests).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PodmanEnv {
    /// `$CONTAINER_HOST` (la variable de Podman; solo se admite `unix://`).
    pub container_host: Option<String>,
    /// `$XDG_RUNTIME_DIR`.
    pub xdg_runtime_dir: Option<String>,
    pub uid: u32,
}

/// Candidatos en orden de preferencia, sin duplicados y solo los que son un socket real.
/// Función pura: el sistema de archivos entra por `exists` e `is_socket`.
pub fn detect_podman(
    env: &PodmanEnv,
    exists: impl Fn(&str) -> bool,
    is_socket: impl Fn(&str) -> bool,
) -> Vec<PodmanCandidate> {
    let mut wanted: Vec<(String, bool, &str)> = Vec::new();
    if let Some(path) = env.container_host.as_deref().and_then(unix_path) {
        // Un socket bajo `/run/user/…` o `$XDG_RUNTIME_DIR` es del usuario; el resto, del sistema.
        let rootless = path.starts_with("/run/user/")
            || env
                .xdg_runtime_dir
                .as_deref()
                .is_some_and(|d| !d.is_empty() && path.starts_with(&format!("{d}/")));
        wanted.push((path, rootless, "container_host"));
    }
    if let Some(dir) = env
        .xdg_runtime_dir
        .as_deref()
        .filter(|d| d.starts_with('/') && !d.contains('\0'))
    {
        wanted.push((
            format!("{}/podman/podman.sock", dir.trim_end_matches('/')),
            true,
            "xdg_runtime_dir",
        ));
    }
    wanted.push(("/run/podman/podman.sock".into(), false, "system"));
    wanted.push((
        format!("/run/user/{}/podman/podman.sock", env.uid),
        true,
        "run_user",
    ));

    let mut out: Vec<PodmanCandidate> = Vec::new();
    for (path, rootless, source) in wanted {
        if out.iter().any(|c| c.path == path) || !exists(&path) || !is_socket(&path) {
            continue;
        }
        out.push(PodmanCandidate {
            path,
            rootless,
            source: source.into(),
        });
    }
    out
}

/// `unix:///ruta` -> `/ruta` (solo rutas absolutas; `tcp://`, `ssh://` y demás se ignoran).
fn unix_path(host: &str) -> Option<String> {
    let path = host.strip_prefix("unix://")?;
    (path.starts_with('/') && !path.contains('\0') && path.len() <= 4096).then(|| path.to_string())
}

/// Detección sobre el equipo real (variables de entorno, uid y sistema de archivos).
pub fn detect_podman_host() -> Vec<PodmanCandidate> {
    use std::os::unix::fs::FileTypeExt;
    let env = PodmanEnv {
        container_host: std::env::var("CONTAINER_HOST").ok(),
        xdg_runtime_dir: std::env::var("XDG_RUNTIME_DIR").ok(),
        // SAFETY: `getuid` no tiene precondiciones ni puede fallar.
        uid: unsafe { libc::getuid() },
    };
    detect_podman(
        &env,
        |p| Path::new(p).exists(),
        |p| {
            std::fs::symlink_metadata(p)
                .map(|m| m.file_type().is_socket())
                .unwrap_or(false)
                // Un enlace a un socket (habitual en `/run/podman`) también cuenta.
                || std::fs::metadata(p)
                    .map(|m| m.file_type().is_socket())
                    .unwrap_or(false)
        },
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::os::unix::net::UnixListener;

    use super::*;

    fn fs(paths: &[&str]) -> impl Fn(&str) -> bool {
        let set: HashSet<String> = paths.iter().map(|s| s.to_string()).collect();
        move |p| set.contains(p)
    }

    fn env(host: Option<&str>, xdg: Option<&str>, uid: u32) -> PodmanEnv {
        PodmanEnv {
            container_host: host.map(String::from),
            xdg_runtime_dir: xdg.map(String::from),
            uid,
        }
    }

    #[test]
    fn tabla_de_entornos() {
        let sock = |p: &str, rootless, src: &str| PodmanCandidate {
            path: p.into(),
            rootless,
            source: src.into(),
        };
        // (entorno, sockets existentes, esperado)
        let cases: Vec<(PodmanEnv, Vec<&str>, Vec<PodmanCandidate>)> = vec![
            (env(None, None, 1000), vec![], vec![]),
            (
                env(None, Some("/run/user/1000"), 1000),
                vec!["/run/user/1000/podman/podman.sock"],
                // XDG y /run/user/<uid> coinciden: sale una sola vez, con la primera fuente.
                vec![sock(
                    "/run/user/1000/podman/podman.sock",
                    true,
                    "xdg_runtime_dir",
                )],
            ),
            (
                env(None, None, 1000),
                vec![
                    "/run/podman/podman.sock",
                    "/run/user/1000/podman/podman.sock",
                ],
                vec![
                    sock("/run/podman/podman.sock", false, "system"),
                    sock("/run/user/1000/podman/podman.sock", true, "run_user"),
                ],
            ),
            (
                env(Some("unix:///tmp/mio.sock"), None, 1000),
                vec!["/tmp/mio.sock", "/run/podman/podman.sock"],
                vec![
                    sock("/tmp/mio.sock", false, "container_host"),
                    sock("/run/podman/podman.sock", false, "system"),
                ],
            ),
            (
                env(Some("unix:///run/user/1000/p.sock"), None, 1000),
                vec!["/run/user/1000/p.sock"],
                vec![sock("/run/user/1000/p.sock", true, "container_host")],
            ),
            // Esquemas que no son unix, rutas relativas y sockets inexistentes se ignoran.
            (env(Some("tcp://1.2.3.4:2375"), None, 1), vec![], vec![]),
            (env(Some("ssh://u@h/run/x.sock"), None, 1), vec![], vec![]),
            (
                env(Some("unix://relativa.sock"), None, 1),
                vec!["relativa.sock"],
                vec![],
            ),
            (
                env(None, Some("relativo"), 1),
                vec!["relativo/podman/podman.sock"],
                vec![],
            ),
        ];
        for (e, present, want) in cases {
            let got = detect_podman(&e, fs(&present), fs(&present));
            assert_eq!(got, want, "{e:?}");
        }
    }

    #[test]
    fn existe_pero_no_es_socket_no_cuenta() {
        let e = env(None, None, 7);
        let got = detect_podman(&e, |_| true, |_| false);
        assert!(got.is_empty());
    }

    #[test]
    fn sockets_falsos_en_tempdir() {
        // `UnixListener::bind` has a small platform limit for socket paths.  Do not use
        // `temp_dir()`/`TMPDIR` (or an arbitrarily long XDG path) for this fixture.
        let base = std::path::PathBuf::from("/tmp");
        let dir = base.join(format!("dkp-{}", uuid::Uuid::now_v7().simple()));
        std::fs::create_dir_all(dir.join("podman")).expect("mkdir");
        let sock = dir.join("podman/podman.sock");
        let _listener = UnixListener::bind(&sock).expect("bind");
        // Un archivo normal con el mismo nombre en otro sitio no es un socket.
        let fake = dir.join("fake.sock");
        std::fs::write(&fake, b"x").expect("write");
        let e = PodmanEnv {
            container_host: Some(format!("unix://{}", fake.display())),
            xdg_runtime_dir: Some(dir.display().to_string()),
            uid: 4_000_000,
        };
        use std::os::unix::fs::FileTypeExt;
        let is_sock = |p: &str| {
            std::fs::metadata(p)
                .map(|m| m.file_type().is_socket())
                .unwrap_or(false)
        };
        let got = detect_podman(&e, |p| Path::new(p).exists(), is_sock);
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].path, sock.display().to_string());
        assert!(got[0].rootless);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deteccion_del_equipo_no_falla() {
        // Solo comprueba que no hace panic: el resultado depende de la máquina.
        let _ = detect_podman_host();
    }
}
