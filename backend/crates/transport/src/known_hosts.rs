//! `known_hosts` PROPIO de DockInng (nunca se lee ni se escribe `~/.ssh/known_hosts`).
//! Formato: una línea por clave, `nombre tipo base64`, con permisos 0600.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use engine_core::{EngineError, HostKeyState};

/// Tipos de clave aceptados de `ssh-keyscan`.
const KEY_TYPES: &[&str] = &[
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "ssh-rsa",
];

/// Clave pública de servidor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKey {
    pub key_type: String,
    /// Base64 tal cual aparece en `known_hosts`.
    pub blob: String,
}

/// Entrada del archivo: los nombres a los que aplica y su clave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub names: Vec<String>,
    pub key: HostKey,
}

fn valid_blob(b: &str) -> bool {
    !b.is_empty()
        && b.len() <= 8192
        && b.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'='))
}

/// Interpreta una línea (`nombres tipo base64 [comentario]`). Ignora comentarios, líneas con
/// marcadores (`@cert-authority`, `@revoked`) y todo lo que no encaje.
pub fn parse_line(line: &str) -> Option<Entry> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') || line.starts_with('@') {
        return None;
    }
    let mut it = line.split_whitespace();
    let names = it.next()?;
    let key_type = it.next()?;
    let blob = it.next()?;
    if !KEY_TYPES.contains(&key_type) || !valid_blob(blob) {
        return None;
    }
    Some(Entry {
        names: names.split(',').map(|n| n.to_ascii_lowercase()).collect(),
        key: HostKey {
            key_type: key_type.to_string(),
            blob: blob.to_string(),
        },
    })
}

/// Entradas válidas de un contenido.
pub fn parse(content: &str) -> Vec<Entry> {
    content.lines().filter_map(parse_line).collect()
}

/// Estado de un servidor: `Trusted` si alguna clave sondeada coincide con una guardada;
/// `Changed` si hay entradas para ese nombre pero ninguna coincide; `Unknown` si no hay.
pub fn state_for(entries: &[Entry], name: &str, scanned: &[HostKey]) -> HostKeyState {
    let name = name.to_ascii_lowercase();
    let stored: Vec<&Entry> = entries.iter().filter(|e| e.names.contains(&name)).collect();
    if stored.is_empty() {
        return HostKeyState::Unknown;
    }
    if stored.iter().any(|e| scanned.contains(&e.key)) {
        HostKeyState::Trusted
    } else {
        HostKeyState::Changed
    }
}

/// Línea lista para escribir.
pub fn format_line(name: &str, key: &HostKey) -> String {
    format!(
        "{} {} {}\n",
        name.to_ascii_lowercase(),
        key.key_type,
        key.blob
    )
}

/// Lee el archivo (vacío si no existe). Rechaza symlinks.
pub fn read(path: &Path) -> Result<Vec<Entry>, EngineError> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(io_err("leer known_hosts", &e)),
        Ok(m) if m.file_type().is_symlink() => {
            return Err(EngineError::InvalidInput(
                "el known_hosts de DockInng es un enlace simbólico".into(),
            ));
        }
        Ok(_) => {}
    }
    let content = fs::read_to_string(path).map_err(|e| io_err("leer known_hosts", &e))?;
    Ok(parse(&content))
}

fn io_err(what: &str, e: &std::io::Error) -> EngineError {
    EngineError::Internal(format!("{what}: {e}"))
}

/// Bloqueo consultivo exclusivo sobre `<archivo>.lock` (sobrevive al reemplazo atómico del
/// archivo de datos, a diferencia de bloquear el propio archivo). Se libera al soltar.
struct FileLock {
    _file: std::fs::File,
}

impl FileLock {
    fn acquire(path: &Path) -> Result<Self, EngineError> {
        let mut lock_path = path.as_os_str().to_owned();
        lock_path.push(".lock");
        let f = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&lock_path)
            .map_err(|e| io_err("abrir bloqueo de known_hosts", &e))?;
        let fd = std::os::fd::AsRawFd::as_raw_fd(&f);
        if unsafe { libc::flock(fd, libc::LOCK_EX) } != 0 {
            return Err(io_err(
                "bloquear known_hosts",
                &std::io::Error::last_os_error(),
            ));
        }
        Ok(Self { _file: f })
    }
}

/// Añade una línea (crea el archivo 0600, sin seguir symlinks, con bloqueo exclusivo).
pub fn append(path: &Path, line: &str) -> Result<(), EngineError> {
    let _lock = FileLock::acquire(path)?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| io_err("abrir known_hosts", &e))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| io_err("permisos de known_hosts", &e))?;
    let fd = std::os::fd::AsRawFd::as_raw_fd(&f);
    // Bloqueo consultivo: dos instancias de DockInng no intercalan escrituras.
    if unsafe { libc::flock(fd, libc::LOCK_EX) } != 0 {
        return Err(io_err(
            "bloquear known_hosts",
            &std::io::Error::last_os_error(),
        ));
    }
    // Si el archivo no terminaba en salto de línea, se añade uno para no fusionar entradas.
    let needs_nl = fs::read(path)
        .map(|b| !b.is_empty() && b.last() != Some(&b'\n'))
        .unwrap_or(false);
    let mut data = String::new();
    if needs_nl {
        data.push('\n');
    }
    data.push_str(line);
    f.write_all(data.as_bytes())
        .and_then(|()| f.flush())
        .map_err(|e| io_err("escribir known_hosts", &e))
}

/// Elimina SOLO el nombre pedido (acción explícita del usuario ante una clave cambiada). Una
/// línea con varios nombres (`a,b tipo clave`) conserva los demás; si era el único, se borra la
/// línea. Bloqueo exclusivo y reescritura atómica con archivo temporal único. Devuelve cuántas
/// líneas se modificaron.
pub fn remove_name(path: &Path, name: &str) -> Result<usize, EngineError> {
    let name = name.to_ascii_lowercase();
    let _lock = FileLock::acquire(path)?;
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => {
            return Err(EngineError::InvalidInput(
                "el known_hosts de DockInng es un enlace simbólico".into(),
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(io_err("leer known_hosts", &e)),
        Ok(_) => {}
    }
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => return Err(io_err("leer known_hosts", &e)),
    };
    let mut changed = 0;
    let mut out = String::new();
    for line in content.lines() {
        let hit = parse_line(line).is_some_and(|e| e.names.contains(&name));
        if !hit {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        changed += 1;
        // `parse_line` ya validó que hay nombres, tipo y clave separados por espacios.
        let trimmed = line.trim();
        let (names, rest) = trimmed
            .split_once(char::is_whitespace)
            .unwrap_or((trimmed, ""));
        let kept: Vec<&str> = names
            .split(',')
            .filter(|n| !n.eq_ignore_ascii_case(&name))
            .collect();
        if !kept.is_empty() {
            out.push_str(&format!("{} {}\n", kept.join(","), rest.trim_start()));
        }
    }
    if changed > 0 {
        let mut tmp_name = path.as_os_str().to_owned();
        tmp_name.push(format!(".{}.tmp", uuid::Uuid::now_v7().simple()));
        let tmp = PathBuf::from(tmp_name);
        let write = || -> std::io::Result<()> {
            let mut f = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&tmp)?;
            f.write_all(out.as_bytes())?;
            f.sync_all()?;
            fs::rename(&tmp, path)
        };
        if let Err(e) = write() {
            let _ = fs::remove_file(&tmp);
            return Err(io_err("reemplazar known_hosts", &e));
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    fn key(t: &str, b: &str) -> HostKey {
        HostKey {
            key_type: t.into(),
            blob: b.into(),
        }
    }

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d =
            std::env::temp_dir().join(format!("dockinng-test-kh-{tag}-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn parsea_y_descarta_lo_raro() {
        let c = "# comentario\n\
                 example.com,10.0.0.1 ssh-ed25519 AAAAC3Nza comentario\n\
                 @revoked h ssh-ed25519 AAAA\n\
                 @cert-authority * ssh-rsa AAAA\n\
                 [h]:2222 ssh-rsa AAAB+/=\n\
                 malo tipo-raro AAAA\n\
                 sin-blob ssh-rsa\n\
                 x ssh-rsa no$base64\n";
        let e = parse(c);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].names, ["example.com", "10.0.0.1"]);
        assert_eq!(e[1].names, ["[h]:2222"]);
    }

    #[test]
    fn estados_unknown_trusted_changed() {
        let e = parse("srv ssh-ed25519 AAAAOK\nsrv ssh-rsa AAAARSA\n");
        let good = key("ssh-ed25519", "AAAAOK");
        let other = key("ssh-ed25519", "AAAAOTRA");
        assert_eq!(
            state_for(&e, "SRV", std::slice::from_ref(&good)),
            HostKeyState::Trusted
        );
        assert_eq!(
            state_for(&e, "srv", std::slice::from_ref(&other)),
            HostKeyState::Changed
        );
        assert_eq!(state_for(&e, "nuevo", &[good]), HostKeyState::Unknown);
        assert_eq!(state_for(&[], "srv", &[other]), HostKeyState::Unknown);
    }

    #[test]
    fn append_crea_0600_y_no_fusiona_lineas() {
        let d = tmp("append");
        let p = d.join("known_hosts");
        append(
            &p,
            &format_line("Host.Example", &key("ssh-ed25519", "AAAA1")),
        )
        .unwrap();
        assert_eq!(fs::metadata(&p).unwrap().mode() & 0o777, 0o600);
        // Archivo sin salto de línea final: no se fusiona con la siguiente.
        fs::write(&p, "a ssh-rsa AAAA2").unwrap();
        append(&p, &format_line("b", &key("ssh-rsa", "AAAA3"))).unwrap();
        assert_eq!(read(&p).unwrap().len(), 2);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn rechaza_symlink() {
        let d = tmp("symlink");
        let real = d.join("real");
        fs::write(&real, "").unwrap();
        let link = d.join("known_hosts");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(read(&link).is_err());
        assert!(append(&link, "x ssh-rsa AAAA\n").is_err());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn remove_name_conserva_los_otros_nombres_de_una_linea_multinombre() {
        let d = tmp("multi");
        let p = d.join("known_hosts");
        fs::write(&p, "a,b,10.0.0.1 ssh-rsa AAAA1\nc ssh-rsa AAAA2\n").unwrap();
        assert_eq!(remove_name(&p, "b").unwrap(), 1);
        let e = read(&p).unwrap();
        assert_eq!(e[0].names, ["a", "10.0.0.1"]);
        assert_eq!(e[1].names, ["c"]);
        // Sin restos: ni temporales ni cambio de modo.
        let leftovers: Vec<_> = fs::read_dir(&d)
            .unwrap()
            .flatten()
            .filter(|f| f.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        // Dos hilos quitando y añadiendo a la vez no corrompen el archivo.
        let p2 = p.clone();
        let t = std::thread::spawn(move || {
            for i in 0..30 {
                append(
                    &p2,
                    &format_line(&format!("h{i}"), &key("ssh-rsa", "AAAAX")),
                )
                .unwrap();
            }
        });
        for _ in 0..30 {
            remove_name(&p, "c").unwrap();
        }
        t.join().unwrap();
        assert_eq!(
            read(&p)
                .unwrap()
                .iter()
                .filter(|e| e.names[0].starts_with('h'))
                .count(),
            30
        );
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn remove_name_solo_quita_ese_nombre() {
        let d = tmp("remove");
        let p = d.join("known_hosts");
        fs::write(
            &p,
            "a ssh-rsa AAAA1\nb ssh-rsa AAAA2\na ssh-ed25519 AAAA3\n",
        )
        .unwrap();
        assert_eq!(remove_name(&p, "A").unwrap(), 2);
        let e = read(&p).unwrap();
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].names, ["b"]);
        assert_eq!(remove_name(&d.join("no-existe"), "a").unwrap(), 0);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn remove_name_rechaza_symlink_sin_tocar_el_objetivo() {
        let d = tmp("remove-symlink");
        let real = d.join("real");
        fs::write(&real, "a ssh-rsa AAAA1\n").unwrap();
        let link = d.join("known_hosts");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        assert!(remove_name(&link, "a").is_err());
        assert_eq!(fs::read_to_string(&real).unwrap(), "a ssh-rsa AAAA1\n");
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        fs::remove_dir_all(&d).unwrap();
    }
}
