//! Directorios privados (0700) para sockets y certificados temporales.
//!
//! Seguridad: no basta con verificar la hoja. Un usuario local podría precrear un ancestro
//! (p. ej. `/tmp/dockinng-<uid>`) y sustituir después `tunnels/` o `certs/`. Por eso se
//! verifica CADA ancestro: debe pertenecer a root o al usuario y no ser escribible por otros
//! (salvo directorios con sticky bit de root, como `/tmp`).

use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use engine_core::EngineError;

fn io_err(what: &str, e: &std::io::Error) -> EngineError {
    EngineError::Internal(format!("{what}: {e}"))
}

fn untrusted(path: &Path, why: &str) -> EngineError {
    EngineError::Internal(format!("directorio no confiable {}: {why}", path.display()))
}

const STICKY: u32 = 0o1000;

/// Verifica un ancestro (no la hoja): dueño root o el usuario, y sin escritura de grupo/otros
/// (o sticky de root, como `/tmp`, donde nadie puede sustituir entradas ajenas). Un symlink
/// debe pertenecer también a root o al usuario.
fn check_ancestor(path: &Path, euid: u32) -> Result<(), EngineError> {
    let link = fs::symlink_metadata(path).map_err(|e| io_err("stat ancestro", &e))?;
    if link.file_type().is_symlink() && link.uid() != 0 && link.uid() != euid {
        return Err(untrusted(path, "enlace simbólico de otro usuario"));
    }
    let meta = fs::metadata(path).map_err(|e| io_err("stat ancestro", &e))?;
    if !meta.is_dir() {
        return Err(untrusted(path, "no es un directorio"));
    }
    if meta.uid() != 0 && meta.uid() != euid {
        return Err(untrusted(path, "pertenece a otro usuario"));
    }
    let others_write = meta.mode() & 0o022 != 0;
    let sticky_root = meta.mode() & STICKY != 0 && meta.uid() == 0;
    if others_write && !sticky_root {
        return Err(untrusted(path, "escribible por otros usuarios"));
    }
    Ok(())
}

/// Crea (si falta) un directorio 0700 propio del usuario y verifica la cadena completa de
/// ancestros y la hoja (no symlink, dueño, permisos). Endurece la hoja si estaba más abierta.
pub fn ensure_private_dir(dir: &Path) -> Result<(), EngineError> {
    let euid = unsafe { libc::geteuid() };
    if !dir.is_absolute() {
        return Err(untrusted(dir, "la ruta debe ser absoluta"));
    }
    if fs::symlink_metadata(dir).is_err() {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| io_err("crear directorio privado", &e))?;
    }
    let meta = fs::symlink_metadata(dir).map_err(|e| io_err("stat directorio", &e))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(untrusted(dir, "no es un directorio normal"));
    }
    if meta.uid() != euid {
        return Err(untrusted(dir, "no pertenece al usuario actual"));
    }
    for ancestor in dir.ancestors().skip(1) {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        check_ancestor(ancestor, euid)?;
    }
    if meta.mode() & 0o077 != 0 {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| io_err("permisos del directorio", &e))?;
    }
    Ok(())
}

/// Respaldo corto (cabe en `sun_path`) bajo `$HOME/.cache`, verificado como el resto.
pub fn fallback_tunnels_dir() -> PathBuf {
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .map(|h| h.join(".cache"))
        .unwrap_or_else(|| PathBuf::from(format!("/tmp/dkt-{}", unsafe { libc::geteuid() })));
    base.join("dockinng").join("t")
}

/// Directorio base de los túneles: `$XDG_RUNTIME_DIR/dockinng/tunnels` o, sin él, el respaldo
/// bajo el directorio de caché del usuario (nunca una ruta fija compartida en `/tmp`).
pub fn default_tunnels_dir() -> PathBuf {
    match std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
    {
        Some(r) => r.join("dockinng").join("tunnels"),
        None => fallback_tunnels_dir(),
    }
}

/// Borra los `*.sock` huérfanos de arranques anteriores: solo los que ya no aceptan
/// conexiones (los de otra instancia viva se respetan). Antes valida el directorio: si no es
/// confiable no toca nada.
pub fn purge_stale_sockets(dir: &Path) -> usize {
    if fs::symlink_metadata(dir).is_err() || ensure_private_dir(dir).is_err() {
        return 0;
    }
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    let mut n = 0;
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().is_some_and(|x| x == "sock")
            && std::os::unix::net::UnixStream::connect(&p)
                .is_err_and(|err| err.kind() == std::io::ErrorKind::ConnectionRefused)
            && fs::remove_file(&p).is_ok()
        {
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(tag: &str) -> PathBuf {
        PathBuf::from("/tmp").join(format!(
            "dktest-fs-{tag}-{}",
            &uuid::Uuid::now_v7().simple().to_string()[20..]
        ))
    }

    #[test]
    fn dir_privado_y_purga_de_huerfanos() {
        let base = base("a");
        let dir = base.join("t");
        ensure_private_dir(&dir).unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        // Un socket huérfano (sin listener) se purga; uno vivo se conserva.
        let stale = dir.join("a.sock");
        drop(std::os::unix::net::UnixListener::bind(&stale).unwrap());
        let live = dir.join("b.sock");
        let _keep = std::os::unix::net::UnixListener::bind(&live).unwrap();
        assert_eq!(purge_stale_sockets(&dir), 1);
        assert!(!stale.exists() && live.exists());
        let link = base.join("enlace");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert!(ensure_private_dir(&link).is_err());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn ancestro_escribible_por_otros_se_rechaza_y_purga_no_toca_nada() {
        let base = base("w");
        let dir = base.join("x").join("t");
        ensure_private_dir(&dir).unwrap();
        let stale = dir.join("a.sock");
        drop(std::os::unix::net::UnixListener::bind(&stale).unwrap());
        // Un ancestro directo abierto a otros (sin sticky de root) invalida toda la cadena.
        fs::set_permissions(base.join("x"), fs::Permissions::from_mode(0o777)).unwrap();
        assert!(ensure_private_dir(&dir).is_err());
        assert_eq!(purge_stale_sockets(&dir), 0);
        assert!(
            stale.exists(),
            "la purga no debe operar en un directorio no confiable"
        );
        fs::set_permissions(base.join("x"), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(ensure_private_dir(&dir).is_ok());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn ancestro_symlink_de_otro_usuario_no_es_verificable_pero_relativa_se_rechaza() {
        assert!(ensure_private_dir(Path::new("relativa/x")).is_err());
        let d = default_tunnels_dir();
        assert!(
            !d.starts_with("/tmp/dockinng-"),
            "sin ruta fija compartida en /tmp"
        );
    }
}
