//! Stacks propios (`~/.local/share/dockinng/stacks/<nombre>/{compose.yaml,.env}`) y vinculados
//! (`link.json`). Todo acceso a disco de este módulo es defensivo:
//!
//! * el nombre se valida ANTES de construir cualquier ruta;
//! * raíz y directorio del stack no pueden ser symlinks y deben quedar dentro de la raíz
//!   canonicalizada;
//! * los archivos se abren con `O_NOFOLLOW` y se exige archivo regular;
//! * la escritura es atómica (temporal `O_EXCL` 0600 + `rename`);
//! * nunca hay `remove_dir_all`.

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::ComposeError;
use crate::types::{StackFiles, StackOrigin};
use crate::validate::validate_stack_name;

pub const MAX_YAML_BYTES: usize = 1024 * 1024;
pub const MAX_ENV_BYTES: usize = 256 * 1024;
const MAX_LINK_BYTES: usize = 64 * 1024;
const MAX_LINKED_FILES: usize = 8;
const MAX_STACKS: usize = 2000;
const COMPOSE_NAMES: [&str; 2] = ["compose.yaml", "compose.yml"];
const ENV_NAME: &str = ".env";
const LINK_NAME: &str = "link.json";
/// Directorios del sistema que nunca se aceptan como origen de archivos vinculados.
const FORBIDDEN_PREFIXES: [&str; 3] = ["/proc", "/sys", "/dev"];

/// Raíz de los stacks propios: `$XDG_DATA_HOME/dockinng/stacks` o `~/.local/share/dockinng/stacks`.
pub fn default_root() -> Result<PathBuf, ComposeError> {
    let base = match std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
        Some(x) if Path::new(&x).is_absolute() => PathBuf::from(x),
        _ => {
            let home = std::env::var_os("HOME")
                .filter(|h| Path::new(h).is_absolute())
                .ok_or_else(|| ComposeError::Io("HOME no está definido".into()))?;
            PathBuf::from(home).join(".local/share")
        }
    };
    Ok(base.join("dockinng").join("stacks"))
}

/// Datos de un stack vinculado (`link.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkData {
    pub config_files: Vec<String>,
    pub working_dir: String,
    pub env_file: Option<String>,
    pub created_at: String,
}

/// Rutas ya validadas y canonicalizadas, listas para pasar a `docker compose`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedStack {
    pub name: String,
    pub origin: StackOrigin,
    pub project_dir: PathBuf,
    pub config_files: Vec<PathBuf>,
    pub env_file: Option<PathBuf>,
    pub editable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredStack {
    pub name: String,
    pub origin: StackOrigin,
    pub config_files: Vec<String>,
    pub working_dir: Option<String>,
}

pub struct StackStore {
    root: PathBuf,
    /// No se pudo resolver el directorio de datos: los stacks propios fallan con un error claro.
    unavailable: bool,
}

// ---------------------------------------------------------------------------------------------
// Utilidades de bajo nivel
// ---------------------------------------------------------------------------------------------

fn check_text(text: &str, max: usize, what: &str) -> Result<(), ComposeError> {
    if text.len() > max {
        return Err(ComposeError::InvalidInput(format!(
            "{what} demasiado grande (máx. {} KiB)",
            max / 1024
        )));
    }
    if text.contains('\0') {
        return Err(ComposeError::InvalidInput(format!(
            "{what} contiene bytes NUL"
        )));
    }
    Ok(())
}

fn mtime_ns(meta: &fs::Metadata) -> i128 {
    i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec())
}

/// `mtime_ns:len` de un archivo abierto.
fn stamp(meta: &fs::Metadata) -> String {
    format!("{}:{}", mtime_ns(meta), meta.len())
}

/// Abre sin seguir symlinks (el ÚLTIMO componente) y sin bloquearse en FIFOs.
fn open_nofollow_read(path: &Path) -> Result<File, ComposeError> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ComposeError::NotFound("archivo no encontrado".into()),
            _ if e.raw_os_error() == Some(libc::ELOOP) => {
                ComposeError::Denied("el archivo es un enlace simbólico".into())
            }
            _ => ComposeError::io("abrir archivo", &e),
        })
}

/// Lee un archivo regular acotado. Devuelve (texto, marca `mtime:len`).
fn read_regular(path: &Path, max: usize) -> Result<(String, String), ComposeError> {
    let file = open_nofollow_read(path)?;
    let meta = file.metadata().map_err(|e| ComposeError::io("stat", &e))?;
    if !meta.is_file() {
        return Err(ComposeError::Denied("no es un archivo regular".into()));
    }
    if meta.len() > max as u64 {
        return Err(ComposeError::Denied(format!(
            "el archivo supera {} KiB",
            max / 1024
        )));
    }
    let mut buf = Vec::with_capacity(meta.len() as usize);
    file.take(max as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| ComposeError::io("leer archivo", &e))?;
    if buf.len() > max {
        return Err(ComposeError::Denied(
            "el archivo supera el tamaño máximo".into(),
        ));
    }
    let text = String::from_utf8(buf)
        .map_err(|_| ComposeError::Denied("el archivo no es UTF-8 válido".into()))?;
    if text.contains('\0') {
        return Err(ComposeError::Denied("el archivo contiene bytes NUL".into()));
    }
    Ok((text, stamp(&meta)))
}

fn temp_suffix() -> String {
    uuid::Uuid::now_v7().simple().to_string()
}

/// Resultado de un borrado de limpieza: `Some(descripción)` si falló de verdad. Que el archivo
/// no exista es lo normal (el fallo pudo ocurrir antes de crearlo) y no cuenta.
fn borrar_creado(paso: &str, r: std::io::Result<()>) -> Option<String> {
    match r {
        Ok(()) => None,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        // Solo el `kind`: los errores del SO pueden llevar rutas.
        Err(e) => Some(format!("{paso} ({:?})", e.kind())),
    }
}

/// Añade a `principal` los borrados de limpieza que fallaron. El error original se conserva
/// (misma variante, mismo código de API); la limpieza incompleta se anota en el mensaje para
/// que no quede en silencio que algo sobró en disco.
fn anotar_limpieza(
    principal: ComposeError,
    limpieza: impl IntoIterator<Item = Option<String>>,
) -> ComposeError {
    let fallos: Vec<String> = limpieza.into_iter().flatten().collect();
    if fallos.is_empty() {
        return principal;
    }
    let nota = format!("limpieza incompleta: {}", fallos.join(", "));
    let anotado = |m: String| format!("{m}; {nota}");
    match principal {
        ComposeError::Missing(m) => ComposeError::Missing(anotado(m)),
        ComposeError::InvalidInput(m) => ComposeError::InvalidInput(anotado(m)),
        ComposeError::Denied(m) => ComposeError::Denied(anotado(m)),
        ComposeError::NotFound(m) => ComposeError::NotFound(anotado(m)),
        ComposeError::Conflict(m) => ComposeError::Conflict(anotado(m)),
        ComposeError::StateChanged(m) => ComposeError::StateChanged(anotado(m)),
        ComposeError::Io(m) => ComposeError::Io(anotado(m)),
        ComposeError::Internal(m) => ComposeError::Internal(anotado(m)),
        // Variantes sin texto libre (Failed, Invalid, Timeout...): la nota no puede perderse,
        // así que el error pasa a interno con el original dentro.
        otro => ComposeError::Internal(anotado(otro.to_string())),
    }
}

/// Escritura atómica: temporal en el MISMO directorio (`O_EXCL`, sin seguir symlinks) + `rename`.
fn write_atomic(
    dir: &Path,
    file_name: &str,
    content: &[u8],
    mode: u32,
) -> Result<(), ComposeError> {
    let target = dir.join(file_name);
    // Si el destino existe debe ser un archivo regular (no symlink): `rename` lo reemplazaría
    // sin seguirlo, pero no queremos machacar enlaces ajenos.
    if let Ok(meta) = fs::symlink_metadata(&target)
        && !meta.is_file()
    {
        return Err(ComposeError::Denied(
            "el destino no es un archivo regular".into(),
        ));
    }
    let tmp = dir.join(format!(".{file_name}.tmp-{}", temp_suffix()));
    let result = (|| {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&tmp)?;
        f.write_all(content)?;
        f.sync_all()?;
        drop(f);
        // El `mode` de `open` respeta la umask: se fija explícitamente.
        fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
        fs::rename(&tmp, &target)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(ComposeError::io("escribir archivo", &e));
    }
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

fn is_forbidden(path: &Path) -> bool {
    FORBIDDEN_PREFIXES.iter().any(|p| path.starts_with(p))
}

/// Valida una ruta externa (archivo compose, `.env`): absoluta, sin NUL, canonicalizable,
/// archivo regular, fuera de `/proc /sys /dev`, dentro del tamaño máximo y (opcional) `.yml/.yaml`.
pub fn validate_external_file(
    path: &Path,
    max: usize,
    yaml_ext: bool,
) -> Result<PathBuf, ComposeError> {
    use std::os::unix::ffi::OsStrExt;
    if !path.is_absolute() || path.as_os_str().as_bytes().contains(&0) {
        return Err(ComposeError::InvalidInput(
            "la ruta debe ser absoluta y no contener NUL".into(),
        ));
    }
    let canon = fs::canonicalize(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => ComposeError::NotFound("archivo no encontrado".into()),
        _ => ComposeError::io("resolver ruta", &e),
    })?;
    if is_forbidden(&canon) {
        return Err(ComposeError::Denied("ruta no permitida".into()));
    }
    let meta = fs::symlink_metadata(&canon).map_err(|e| ComposeError::io("stat", &e))?;
    if !meta.is_file() {
        return Err(ComposeError::Denied("no es un archivo regular".into()));
    }
    if meta.len() > max as u64 {
        return Err(ComposeError::Denied(format!(
            "el archivo supera {} KiB",
            max / 1024
        )));
    }
    if yaml_ext {
        let ext_ok = canon
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("yml") || e.eq_ignore_ascii_case("yaml"));
        if !ext_ok {
            return Err(ComposeError::Denied(
                "el archivo compose debe tener extensión .yml o .yaml".into(),
            ));
        }
    }
    Ok(canon)
}

/// Como `validate_external_file`, pero además: la ruta NO puede ser un symlink (el enlace mismo,
/// no sus directorios padre) y el archivo canónico debe quedar dentro de `wd`. Evita que un
/// `.env -> ~/.bashrc` de un repo ajeno se lea o se sobrescriba.
fn validate_confined_file(
    path: &Path,
    wd: &Path,
    max: usize,
    yaml_ext: bool,
) -> Result<PathBuf, ComposeError> {
    if let Ok(m) = fs::symlink_metadata(path)
        && m.file_type().is_symlink()
    {
        return Err(ComposeError::Denied(
            "el archivo es un enlace simbólico: no se acepta en un stack vinculado".into(),
        ));
    }
    let canon = validate_external_file(path, max, yaml_ext)?;
    if !canon.starts_with(wd) {
        return Err(ComposeError::Denied(
            "el archivo queda fuera del directorio del proyecto".into(),
        ));
    }
    Ok(canon)
}

/// `.env` aceptable de un proyecto: archivo normal (no symlink) dentro de `wd`.
pub fn confined_env(env: &Path, wd: &Path) -> Option<PathBuf> {
    validate_confined_file(env, wd, MAX_ENV_BYTES, false).ok()
}

/// Expande solo `~` y `~/...` con `$HOME` del proceso (nunca `~usuario`). Rechaza `..`.
pub fn expand_tilde(path: &str) -> Result<PathBuf, ComposeError> {
    let rest = if path == "~" {
        ""
    } else if let Some(r) = path.strip_prefix("~/") {
        r
    } else {
        return Ok(PathBuf::from(path));
    };
    if Path::new(rest)
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(ComposeError::InvalidInput(
            "la ruta no puede contener `..`".into(),
        ));
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|h| h.is_absolute())
        .ok_or_else(|| ComposeError::InvalidInput("HOME no está definido".into()))?;
    Ok(home.join(rest))
}

fn validate_external_dir(path: &Path) -> Result<PathBuf, ComposeError> {
    use std::os::unix::ffi::OsStrExt;
    if !path.is_absolute() || path.as_os_str().as_bytes().contains(&0) {
        return Err(ComposeError::InvalidInput(
            "el directorio debe ser una ruta absoluta sin NUL".into(),
        ));
    }
    let canon = fs::canonicalize(path).map_err(|e| ComposeError::io("resolver directorio", &e))?;
    if is_forbidden(&canon) || !canon.is_dir() {
        return Err(ComposeError::Denied("directorio no permitido".into()));
    }
    Ok(canon)
}

/// Lectura de solo lectura de un archivo compose externo (stacks `discovered`).
pub fn read_external_readonly(path: &Path) -> Result<String, ComposeError> {
    let canon = validate_external_file(path, MAX_YAML_BYTES, true)?;
    read_regular(&canon, MAX_YAML_BYTES).map(|(t, _)| t)
}

/// Fecha RFC 3339 UTC sin dependencias.
pub fn rfc3339_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Algoritmo civil-from-days (H. Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

// ---------------------------------------------------------------------------------------------
// Almacén
// ---------------------------------------------------------------------------------------------

enum Kind {
    Managed { compose: PathBuf },
    Linked { link: LinkData },
}

impl StackStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            unavailable: false,
        }
    }

    /// Almacén sin directorio de datos: no lista nada y toda operación sobre stacks propios
    /// devuelve `no se pudo determinar el directorio de datos`.
    pub fn unavailable() -> Self {
        Self {
            root: PathBuf::new(),
            unavailable: true,
        }
    }

    /// `Err` claro si el directorio de datos no se pudo resolver.
    pub fn require_available(&self) -> Result<(), ComposeError> {
        if self.unavailable {
            Err(ComposeError::Internal(
                "no se pudo determinar el directorio de datos (revisa $XDG_DATA_HOME o $HOME)"
                    .into(),
            ))
        } else {
            Ok(())
        }
    }

    pub fn with_default_root() -> Result<Self, ComposeError> {
        Ok(Self::new(default_root()?))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Crea la raíz (0700) si falta y verifica que es un directorio propio, no symlink.
    fn ensure_root(&self) -> Result<PathBuf, ComposeError> {
        self.require_available()?;
        if fs::symlink_metadata(&self.root).is_err() {
            DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&self.root)
                .map_err(|e| ComposeError::io("crear raíz de stacks", &e))?;
        }
        self.existing_root()
    }

    /// Verifica la raíz sin crearla.
    fn existing_root(&self) -> Result<PathBuf, ComposeError> {
        let meta =
            fs::symlink_metadata(&self.root).map_err(|e| ComposeError::io("stat raíz", &e))?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(ComposeError::Denied(
                "la raíz de stacks no es un directorio normal".into(),
            ));
        }
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err(ComposeError::Denied("la raíz de stacks no es tuya".into()));
        }
        if meta.mode() & 0o077 != 0 {
            fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700))
                .map_err(|e| ComposeError::io("permisos de la raíz", &e))?;
        }
        fs::canonicalize(&self.root).map_err(|e| ComposeError::io("resolver raíz", &e))
    }

    /// Directorio del stack, validado (`Ok(None)` si no existe).
    fn stack_dir(&self, name: &str) -> Result<Option<PathBuf>, ComposeError> {
        validate_stack_name(name)?;
        if self.unavailable {
            return Ok(None);
        }
        let root = match self.existing_root() {
            Ok(r) => r,
            Err(ComposeError::Io(_)) if !self.root.exists() => return Ok(None),
            Err(e) => return Err(e),
        };
        let dir = self.root.join(name);
        let meta = match fs::symlink_metadata(&dir) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(ComposeError::io("stat stack", &e)),
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(ComposeError::Denied(
                "el directorio del stack no es normal".into(),
            ));
        }
        let canon = fs::canonicalize(&dir).map_err(|e| ComposeError::io("resolver stack", &e))?;
        if canon.parent() != Some(root.as_path()) {
            return Err(ComposeError::Denied(
                "el stack queda fuera de la raíz".into(),
            ));
        }
        if meta.mode() & 0o077 != 0 && meta.uid() == unsafe { libc::geteuid() } {
            let _ = fs::set_permissions(&canon, fs::Permissions::from_mode(0o700));
        }
        Ok(Some(canon))
    }

    fn kind_of(&self, dir: &Path) -> Result<Kind, ComposeError> {
        let link_path = dir.join(LINK_NAME);
        let has_link = fs::symlink_metadata(&link_path).is_ok();
        let compose = COMPOSE_NAMES
            .iter()
            .map(|n| dir.join(n))
            .find(|p| fs::symlink_metadata(p).is_ok());
        match (has_link, compose) {
            (true, Some(_)) => Err(ComposeError::Denied(
                "el stack tiene compose.yaml y link.json a la vez".into(),
            )),
            (true, None) => {
                let (text, _) = read_regular(&link_path, MAX_LINK_BYTES)?;
                let link: LinkData = serde_json::from_str(&text)
                    .map_err(|_| ComposeError::Denied("link.json inválido".into()))?;
                Ok(Kind::Linked { link })
            }
            (false, Some(compose)) => Ok(Kind::Managed { compose }),
            (false, None) => Err(ComposeError::NotFound(
                "el stack no tiene compose.yaml".into(),
            )),
        }
    }

    /// Revalida TODAS las rutas de un `link.json` (se hace en cada uso).
    fn resolve_link(&self, name: &str, link: &LinkData) -> Result<ResolvedStack, ComposeError> {
        if link.config_files.is_empty() || link.config_files.len() > MAX_LINKED_FILES {
            return Err(ComposeError::Denied(
                "link.json: lista de archivos inválida".into(),
            ));
        }
        let project_dir = validate_external_dir(Path::new(&link.working_dir))?;
        let mut files = Vec::new();
        for f in &link.config_files {
            files.push(validate_confined_file(
                Path::new(f),
                &project_dir,
                MAX_YAML_BYTES,
                true,
            )?);
        }
        let env_file = match &link.env_file {
            Some(e) => Some(validate_confined_file(
                Path::new(e),
                &project_dir,
                MAX_ENV_BYTES,
                false,
            )?),
            None => None,
        };
        Ok(ResolvedStack {
            name: name.to_string(),
            origin: StackOrigin::Linked,
            project_dir,
            editable: files.len() == 1,
            config_files: files,
            env_file,
        })
    }

    /// Resuelve un stack managed/linked a rutas validadas.
    pub fn resolve(&self, name: &str) -> Result<ResolvedStack, ComposeError> {
        let dir = self
            .stack_dir(name)?
            .ok_or_else(|| ComposeError::NotFound("stack no encontrado".into()))?;
        match self.kind_of(&dir)? {
            Kind::Managed { compose } => {
                let env = dir.join(ENV_NAME);
                let env_file = match fs::symlink_metadata(&env) {
                    Ok(m) if m.is_file() => Some(env),
                    Ok(_) => {
                        return Err(ComposeError::Denied(".env no es un archivo regular".into()));
                    }
                    Err(_) => None,
                };
                Ok(ResolvedStack {
                    name: name.to_string(),
                    origin: StackOrigin::Managed,
                    project_dir: dir,
                    config_files: vec![compose],
                    env_file,
                    editable: true,
                })
            }
            Kind::Linked { link } => self.resolve_link(name, &link),
        }
    }

    /// Lista los stacks existentes (managed o linked), sin validar rutas externas.
    pub fn list(&self) -> Vec<StoredStack> {
        let Ok(root) = self.existing_root() else {
            return Vec::new();
        };
        let Ok(rd) = fs::read_dir(&root) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for entry in rd.flatten().take(MAX_STACKS) {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if validate_stack_name(&name).is_err() {
                continue;
            }
            let Ok(Some(dir)) = self.stack_dir(&name) else {
                continue;
            };
            match self.kind_of(&dir) {
                Ok(Kind::Managed { compose }) => out.push(StoredStack {
                    name,
                    origin: StackOrigin::Managed,
                    config_files: vec![compose.to_string_lossy().into_owned()],
                    working_dir: Some(dir.to_string_lossy().into_owned()),
                }),
                Ok(Kind::Linked { link }) => out.push(StoredStack {
                    name,
                    origin: StackOrigin::Linked,
                    config_files: link.config_files.clone(),
                    working_dir: Some(link.working_dir.clone()),
                }),
                Err(_) => {}
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// Marca barata (solo `stat`) del estado de los archivos de un stack resuelto.
    pub fn revision_of(r: &ResolvedStack) -> String {
        let mut parts = Vec::new();
        for p in r.config_files.iter().chain(r.env_file.iter()) {
            match fs::metadata(p) {
                Ok(m) => parts.push(stamp(&m)),
                Err(_) => parts.push("-".into()),
            }
        }
        parts.join("|")
    }

    pub fn read(&self, name: &str) -> Result<StackFiles, ComposeError> {
        let r = self.resolve(name)?;
        let (yaml, y_stamp) = read_regular(&r.config_files[0], MAX_YAML_BYTES)?;
        let (env, e_stamp) = match &r.env_file {
            Some(p) => read_regular(p, MAX_ENV_BYTES)?,
            None => (String::new(), "-".into()),
        };
        Ok(StackFiles {
            name: r.name,
            origin: r.origin,
            yaml,
            env,
            path: r.config_files[0].to_string_lossy().into_owned(),
            env_path: r
                .env_file
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            editable: r.editable,
            config_files: r
                .config_files
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
            revision: format!("{y_stamp}|{e_stamp}"),
        })
    }

    /// Crea un stack propio. `Conflict` si el nombre ya existe (managed o linked).
    pub fn create(&self, name: &str, yaml: &str, env: &str) -> Result<StackFiles, ComposeError> {
        validate_stack_name(name)?;
        check_text(yaml, MAX_YAML_BYTES, "compose")?;
        check_text(env, MAX_ENV_BYTES, ".env")?;
        self.ensure_root()?;
        let dir = self.root.join(name);
        match DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(ComposeError::Conflict(
                    "ya existe un stack con ese nombre".into(),
                ));
            }
            Err(e) => return Err(ComposeError::io("crear directorio del stack", &e)),
        }
        let result = (|| {
            write_atomic(&dir, COMPOSE_NAMES[0], yaml.as_bytes(), 0o600)?;
            write_atomic(&dir, ENV_NAME, env.as_bytes(), 0o600)
        })();
        if let Err(e) = result {
            // Limpieza de lo que acabamos de crear (solo nuestros archivos conocidos).
            let limpieza = [
                borrar_creado(
                    "borrar compose",
                    fs::remove_file(dir.join(COMPOSE_NAMES[0])),
                ),
                borrar_creado("borrar .env", fs::remove_file(dir.join(ENV_NAME))),
                borrar_creado("borrar directorio", fs::remove_dir(&dir)),
            ];
            return Err(anotar_limpieza(e, limpieza));
        }
        self.read(name)
    }

    /// Guarda compose y `.env` (managed o linked editable). `expected_revision` distinta de la
    /// actual → `StateChanged`.
    pub fn save(
        &self,
        name: &str,
        yaml: &str,
        env: &str,
        expected_revision: Option<&str>,
    ) -> Result<StackFiles, ComposeError> {
        check_text(yaml, MAX_YAML_BYTES, "compose")?;
        check_text(env, MAX_ENV_BYTES, ".env")?;
        let current = self.read(name)?;
        if !current.editable {
            return Err(ComposeError::Denied(
                "este stack no es editable (varios archivos compose)".into(),
            ));
        }
        if let Some(exp) = expected_revision
            && exp != current.revision
        {
            return Err(ComposeError::StateChanged(
                "el archivo cambió en disco desde que lo abriste".into(),
            ));
        }
        let r = self.resolve(name)?;
        let compose = &r.config_files[0];
        let dir = compose
            .parent()
            .ok_or_else(|| ComposeError::Internal("sin directorio".into()))?;
        let fname = compose
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| ComposeError::Internal("nombre de archivo".into()))?;
        let mode = |p: &Path| fs::metadata(p).map(|m| m.mode() & 0o777).unwrap_or(0o600);
        let yaml_mode = if r.origin == StackOrigin::Managed {
            0o600
        } else {
            mode(compose)
        };
        write_atomic(dir, fname, yaml.as_bytes(), yaml_mode)?;
        match &r.env_file {
            Some(p) => {
                let edir = p
                    .parent()
                    .ok_or_else(|| ComposeError::Internal("sin directorio".into()))?;
                let ename = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| ComposeError::Internal("nombre de archivo".into()))?;
                let m = if r.origin == StackOrigin::Managed {
                    0o600
                } else {
                    mode(p)
                };
                write_atomic(edir, ename, env.as_bytes(), m)?;
            }
            None if env.is_empty() => {}
            None if r.origin == StackOrigin::Managed => {
                write_atomic(&r.project_dir, ENV_NAME, env.as_bytes(), 0o600)?;
            }
            None => {
                return Err(ComposeError::InvalidInput(
                    "este stack vinculado no tiene un archivo .env asociado".into(),
                ));
            }
        }
        self.read(name)
    }

    /// Borra los archivos de un stack MANAGED: solo los dos conocidos + `remove_dir`
    /// (falla si el usuario dejó otros archivos ahí).
    pub fn delete_managed(&self, name: &str) -> Result<(), ComposeError> {
        let dir = self
            .stack_dir(name)?
            .ok_or_else(|| ComposeError::NotFound("stack no encontrado".into()))?;
        let Kind::Managed { compose } = self.kind_of(&dir)? else {
            return Err(ComposeError::Denied(
                "un stack vinculado se desvincula, no se borra".into(),
            ));
        };
        // Antes de borrar nada: si hay archivos ajenos (del usuario) no se toca nada.
        let known = [
            compose.file_name().map(|n| n.to_os_string()),
            Some(ENV_NAME.into()),
        ];
        // Una entrada que no se puede leer cuenta como ajena: se rechaza el borrado en vez de
        // ignorarla (ignorarla podía dejar borrar un directorio con archivos del usuario).
        let mut foreign = false;
        for entrada in fs::read_dir(&dir).map_err(|e| ComposeError::io("listar stack", &e))? {
            let entrada = entrada.map_err(|e| ComposeError::io("listar stack", &e))?;
            if !known.iter().flatten().any(|k| *k == entrada.file_name()) {
                foreign = true;
            }
        }
        if foreign {
            return Err(ComposeError::Conflict(
                "el directorio del stack contiene otros archivos".into(),
            ));
        }
        for p in [compose, dir.join(ENV_NAME)] {
            match fs::symlink_metadata(&p) {
                Ok(m) if m.is_file() => {
                    fs::remove_file(&p).map_err(|e| ComposeError::io("borrar archivo", &e))?
                }
                Ok(_) => {
                    return Err(ComposeError::Denied(
                        "entrada inesperada en el stack".into(),
                    ));
                }
                Err(_) => {}
            }
        }
        fs::remove_dir(&dir).map_err(|_| {
            ComposeError::Conflict("el directorio del stack contiene otros archivos".into())
        })
    }

    /// Vincula archivos externos como stack. NO copia ni modifica los archivos del usuario.
    pub fn link(
        &self,
        name: &str,
        files: &[PathBuf],
        working_dir: Option<&Path>,
        env_file: Option<&Path>,
    ) -> Result<StackFiles, ComposeError> {
        validate_stack_name(name)?;
        if files.is_empty() || files.len() > MAX_LINKED_FILES {
            return Err(ComposeError::InvalidInput(
                "cantidad de archivos inválida".into(),
            ));
        }
        let first = validate_external_file(&files[0], MAX_YAML_BYTES, true)?;
        let wd = match working_dir {
            Some(d) => validate_external_dir(d)?,
            None => first
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| ComposeError::InvalidInput("sin directorio padre".into()))?,
        };
        let mut canon_files = Vec::new();
        for f in files {
            canon_files.push(validate_confined_file(f, &wd, MAX_YAML_BYTES, true)?);
        }
        let env = match env_file {
            Some(e) => Some(validate_confined_file(e, &wd, MAX_ENV_BYTES, false)?),
            // Autodetección: un `.env` symlink o fuera del proyecto simplemente se ignora.
            None => validate_confined_file(&wd.join(ENV_NAME), &wd, MAX_ENV_BYTES, false).ok(),
        };
        self.ensure_root()?;
        let dir = self.root.join(name);
        match DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(ComposeError::Conflict(
                    "ya existe un stack con ese nombre".into(),
                ));
            }
            Err(e) => return Err(ComposeError::io("crear directorio del stack", &e)),
        }
        let data = LinkData {
            config_files: canon_files
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
            working_dir: wd.to_string_lossy().into_owned(),
            env_file: env.as_ref().map(|p| p.to_string_lossy().into_owned()),
            created_at: rfc3339_now(),
        };
        let json =
            serde_json::to_vec_pretty(&data).map_err(|e| ComposeError::Internal(e.to_string()))?;
        if let Err(e) = write_atomic(&dir, LINK_NAME, &json, 0o600) {
            let limpieza = [borrar_creado("borrar directorio", fs::remove_dir(&dir))];
            return Err(anotar_limpieza(e, limpieza));
        }
        self.read(name)
    }

    /// Desvincula: borra `link.json` y el directorio. No toca los archivos del usuario.
    pub fn unlink(&self, name: &str) -> Result<(), ComposeError> {
        let dir = self
            .stack_dir(name)?
            .ok_or_else(|| ComposeError::NotFound("stack no encontrado".into()))?;
        let Kind::Linked { .. } = self.kind_of(&dir)? else {
            return Err(ComposeError::Denied(
                "solo se desvinculan stacks vinculados".into(),
            ));
        };
        fs::remove_file(dir.join(LINK_NAME))
            .map_err(|e| ComposeError::io("borrar link.json", &e))?;
        fs::remove_dir(&dir).map_err(|_| {
            ComposeError::Conflict("el directorio del stack contiene otros archivos".into())
        })
    }

    pub fn origin_of(&self, name: &str) -> Result<Option<StackOrigin>, ComposeError> {
        let Some(dir) = self.stack_dir(name)? else {
            return Ok(None);
        };
        Ok(Some(match self.kind_of(&dir)? {
            Kind::Managed { .. } => StackOrigin::Managed,
            Kind::Linked { .. } => StackOrigin::Linked,
        }))
    }
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::PathBuf;

    /// Directorio temporal propio del test (se borra al soltar; nunca fuera de `temp_dir`).
    pub struct TempDir(pub PathBuf);
    impl TempDir {
        pub fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "dockinng-compose-test-{}",
                uuid::Uuid::now_v7().simple()
            ));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        pub fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod limpieza_tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    #[test]
    fn ausente_en_la_limpieza_no_es_un_fallo() {
        assert_eq!(
            borrar_creado("x", Err(Error::from(ErrorKind::NotFound))),
            None
        );
        assert_eq!(borrar_creado("x", Ok(())), None);
    }

    #[test]
    fn fallo_real_de_limpieza_se_registra_sin_rutas() {
        let nota = borrar_creado("borrar .env", Err(Error::from(ErrorKind::PermissionDenied)))
            .expect("debe registrarse");
        assert!(nota.contains("borrar .env"));
        assert!(nota.contains("PermissionDenied"));
        assert!(!nota.contains('/'), "sin rutas: {nota}");
    }

    #[test]
    fn la_nota_se_anade_sin_cambiar_la_variante_del_error() {
        let limpieza = [
            None,
            Some("borrar directorio (PermissionDenied)".to_string()),
        ];
        let e = anotar_limpieza(ComposeError::Conflict("ocupado".into()), limpieza);
        assert_eq!(
            e,
            ComposeError::Conflict(
                "ocupado; limpieza incompleta: borrar directorio (PermissionDenied)".into()
            )
        );
    }

    #[test]
    fn sin_fallos_de_limpieza_el_error_queda_intacto() {
        let original = ComposeError::Io("escribir: Other".into());
        assert_eq!(anotar_limpieza(original.clone(), [None, None]), original);
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::TempDir;
    use super::*;
    use std::os::unix::fs::symlink;

    const YAML: &str = "services:\n  a:\n    image: alpine\n";

    fn store(t: &TempDir) -> StackStore {
        StackStore::new(t.path().join("stacks"))
    }

    fn mode(p: &Path) -> u32 {
        fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn crea_lee_con_permisos_0700_y_0600() {
        let t = TempDir::new();
        let s = store(&t);
        let f = s.create("web", YAML, "A=1\n").unwrap();
        assert_eq!(f.origin, StackOrigin::Managed);
        assert_eq!(f.yaml, YAML);
        assert_eq!(f.env, "A=1\n");
        assert!(f.editable);
        assert_eq!(mode(s.root()), 0o700);
        assert_eq!(mode(&s.root().join("web")), 0o700);
        assert_eq!(mode(&s.root().join("web/compose.yaml")), 0o600);
        assert_eq!(mode(&s.root().join("web/.env")), 0o600);
        assert!(matches!(
            s.create("web", YAML, ""),
            Err(ComposeError::Conflict(_))
        ));
        assert_eq!(s.list().len(), 1);
    }

    #[test]
    fn nombres_hostiles_no_tocan_disco() {
        let t = TempDir::new();
        let s = store(&t);
        for bad in [
            "../x",
            "a/b",
            ".",
            "..",
            "-x",
            "A",
            "ñ",
            "a\0b",
            "a b",
            "a\nb",
            &"a".repeat(64),
        ] {
            assert!(s.create(bad, YAML, "").is_err(), "{bad:?}");
            assert!(s.read(bad).is_err(), "{bad:?}");
            assert!(s.save(bad, YAML, "", None).is_err(), "{bad:?}");
            assert!(s.delete_managed(bad).is_err(), "{bad:?}");
            assert!(s.unlink(bad).is_err(), "{bad:?}");
            assert!(s.resolve(bad).is_err(), "{bad:?}");
        }
        // Ni siquiera se creó la raíz.
        assert!(!s.root().exists());
    }

    #[test]
    fn revision_vieja_es_state_changed() {
        let t = TempDir::new();
        let s = store(&t);
        let f = s.create("web", YAML, "").unwrap();
        let g = s
            .save("web", "services: {}\n", "X=1", Some(&f.revision))
            .unwrap();
        assert_ne!(g.revision, f.revision);
        assert_eq!(g.env, "X=1");
        assert!(matches!(
            s.save("web", YAML, "", Some(&f.revision)),
            Err(ComposeError::StateChanged(_))
        ));
        // Sin revisión esperada guarda.
        s.save("web", YAML, "", None).unwrap();
    }

    #[test]
    fn limites_de_contenido() {
        let t = TempDir::new();
        let s = store(&t);
        assert!(s.create("a", &"x".repeat(MAX_YAML_BYTES + 1), "").is_err());
        assert!(s.create("a", YAML, &"x".repeat(MAX_ENV_BYTES + 1)).is_err());
        assert!(s.create("a", "x\0y", "").is_err());
        assert!(s.create("a", YAML, "K=\0").is_err());
        assert!(!s.root().join("a").exists());
        s.create("a", &"x".repeat(MAX_YAML_BYTES), "").unwrap();
    }

    #[test]
    fn compose_symlink_no_se_lee_ni_se_escribe() {
        let t = TempDir::new();
        let s = store(&t);
        s.create("web", YAML, "").unwrap();
        let victim = t.path().join("victima.txt");
        fs::write(&victim, "secreto").unwrap();
        let c = s.root().join("web/compose.yaml");
        fs::remove_file(&c).unwrap();
        symlink(&victim, &c).unwrap();
        assert!(s.read("web").is_err());
        assert!(s.save("web", "x: 1\n", "", None).is_err());
        assert_eq!(fs::read_to_string(&victim).unwrap(), "secreto");
    }

    #[test]
    fn env_symlink_rechazado() {
        let t = TempDir::new();
        let s = store(&t);
        s.create("web", YAML, "").unwrap();
        let victim = t.path().join("victima.txt");
        fs::write(&victim, "secreto").unwrap();
        let e = s.root().join("web/.env");
        fs::remove_file(&e).unwrap();
        symlink(&victim, &e).unwrap();
        assert!(
            s.resolve("web").is_err(),
            ".env symlink: se rechaza al resolver"
        );
        assert!(s.read("web").is_err());
        assert!(s.save("web", YAML, "A=1", None).is_err());
        assert_eq!(fs::read_to_string(&victim).unwrap(), "secreto");
    }

    #[test]
    fn dir_del_stack_o_raiz_symlink_rechazados() {
        let t = TempDir::new();
        let s = store(&t);
        s.create("web", YAML, "").unwrap();
        let outside = t.path().join("fuera");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("compose.yaml"), YAML).unwrap();
        symlink(&outside, s.root().join("evil")).unwrap();
        assert!(matches!(s.read("evil"), Err(ComposeError::Denied(_))));
        assert!(s.list().iter().all(|x| x.name != "evil"));
        // Raíz symlink.
        let t2 = TempDir::new();
        symlink(&outside, t2.path().join("stacks")).unwrap();
        let s2 = StackStore::new(t2.path().join("stacks"));
        assert!(matches!(
            s2.create("a", YAML, ""),
            Err(ComposeError::Denied(_))
        ));
        assert!(fs::read_dir(&outside).unwrap().count() == 1);
    }

    #[test]
    fn escritura_atomica_no_deja_temporales() {
        let t = TempDir::new();
        let s = store(&t);
        s.create("web", YAML, "").unwrap();
        for i in 0..5 {
            s.save("web", &format!("# {i}\n{YAML}"), "", None).unwrap();
        }
        let names: Vec<_> = fs::read_dir(s.root().join("web"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    #[test]
    fn borrar_managed_solo_archivos_conocidos() {
        let t = TempDir::new();
        let s = store(&t);
        s.create("web", YAML, "").unwrap();
        fs::write(s.root().join("web/extra.txt"), "del usuario").unwrap();
        assert!(matches!(
            s.delete_managed("web"),
            Err(ComposeError::Conflict(_))
        ));
        assert!(s.root().join("web/extra.txt").exists());
        assert!(
            s.root().join("web/compose.yaml").exists(),
            "no se borró nada"
        );
        fs::remove_file(s.root().join("web/extra.txt")).unwrap();
        s.delete_managed("web").unwrap();
        assert!(!s.root().join("web").exists());
        assert!(matches!(
            s.delete_managed("web"),
            Err(ComposeError::NotFound(_))
        ));
    }

    // ---- stacks vinculados ----

    fn project(t: &TempDir) -> PathBuf {
        let p = t.path().join("proyecto");
        fs::create_dir_all(&p).unwrap();
        fs::write(p.join("compose.yaml"), YAML).unwrap();
        fs::write(p.join(".env"), "SECRETO=abc\n").unwrap();
        p
    }

    #[test]
    fn vincular_edita_y_desvincula_sin_tocar_el_resto() {
        let t = TempDir::new();
        let s = store(&t);
        let p = project(&t);
        let f = s
            .link("mi-proyecto", &[p.join("compose.yaml")], None, None)
            .unwrap();
        assert_eq!(f.origin, StackOrigin::Linked);
        assert!(f.editable);
        assert_eq!(f.env, "SECRETO=abc\n");
        assert_eq!(mode(&s.root().join("mi-proyecto/link.json")), 0o600);
        assert!(matches!(
            s.link("mi-proyecto", &[p.join("compose.yaml")], None, None),
            Err(ComposeError::Conflict(_))
        ));
        // Guardar escribe en el archivo del usuario con expectedRevision.
        let g = s
            .save(
                "mi-proyecto",
                "services: {}\n",
                "SECRETO=z\n",
                Some(&f.revision),
            )
            .unwrap();
        assert_eq!(
            fs::read_to_string(p.join("compose.yaml")).unwrap(),
            "services: {}\n"
        );
        assert_eq!(fs::read_to_string(p.join(".env")).unwrap(), "SECRETO=z\n");
        assert!(matches!(
            s.save("mi-proyecto", YAML, "", Some(&f.revision)),
            Err(ComposeError::StateChanged(_))
        ));
        assert_ne!(g.revision, f.revision);
        // No se puede borrar como managed; desvincular respeta los archivos.
        assert!(matches!(
            s.delete_managed("mi-proyecto"),
            Err(ComposeError::Denied(_))
        ));
        s.unlink("mi-proyecto").unwrap();
        assert!(p.join("compose.yaml").exists() && p.join(".env").exists());
        assert!(!s.root().join("mi-proyecto").exists());
        assert!(matches!(
            s.unlink("mi-proyecto"),
            Err(ComposeError::NotFound(_))
        ));
    }

    #[test]
    fn vincular_rechaza_rutas_peligrosas() {
        let t = TempDir::new();
        let s = store(&t);
        let p = project(&t);
        let big = p.join("grande.yaml");
        fs::write(&big, "x".repeat(5 * 1024 * 1024)).unwrap();
        fs::write(p.join("nota.txt"), "x").unwrap();
        let etc_link = p.join("evil.yaml");
        symlink("/etc/passwd", &etc_link).unwrap();
        for bad in [
            PathBuf::from("/etc/passwd"),
            PathBuf::from("/proc/self/environ"),
            PathBuf::from("/dev/null"),
            p.clone(),          // directorio
            big.clone(),        // 5 MiB
            p.join("nota.txt"), // extensión
            etc_link.clone(),   // symlink → /etc/passwd (canonical sin .yaml)
            PathBuf::from("relativo/compose.yaml"),
            PathBuf::from("/no/existe/compose.yaml"),
            PathBuf::from("/tmp/a\0b.yaml"),
        ] {
            assert!(
                s.link("x", std::slice::from_ref(&bad), None, None).is_err(),
                "{bad:?}"
            );
            assert!(!s.root().join("x").exists(), "no deja directorios: {bad:?}");
        }
        assert!(s.link("x", &[], None, None).is_err());
        assert!(
            s.link(
                "x",
                &[p.join("compose.yaml")],
                Some(Path::new("/proc")),
                None
            )
            .is_err()
        );
        assert!(
            s.link(
                "x",
                &[p.join("compose.yaml")],
                None,
                Some(Path::new("/etc/passwd"))
            )
            .is_err(),
            "un env_file fuera del proyecto se rechaza"
        );
    }

    #[test]
    fn env_symlink_en_stack_vinculado_no_se_lee_ni_se_escribe() {
        let t = TempDir::new();
        let s = store(&t);
        let p = project(&t);
        let victim = t.path().join("victim.txt");
        fs::write(&victim, "SECRETO_AJENO").unwrap();
        // 1) Al vincular: `.env -> victim` se ignora (no se autodetecta).
        fs::remove_file(p.join(".env")).unwrap();
        symlink(&victim, p.join(".env")).unwrap();
        let f = s
            .link("proy", &[p.join("compose.yaml")], None, None)
            .unwrap();
        assert_eq!(f.env, "");
        assert_eq!(f.env_path, "");
        assert!(s.save("proy", YAML, "X=1", None).is_err());
        assert_eq!(fs::read_to_string(&victim).unwrap(), "SECRETO_AJENO");
        // 2) Explícito hacia un symlink: rechazado.
        s.unlink("proy").unwrap();
        assert!(
            s.link(
                "proy",
                &[p.join("compose.yaml")],
                None,
                Some(&p.join(".env"))
            )
            .is_err()
        );
        // 3) `.env` legítimo que luego se cambia por un symlink: se rechaza al resolver y save no toca nada.
        fs::remove_file(p.join(".env")).unwrap();
        fs::write(p.join(".env"), "A=1\n").unwrap();
        s.link("proy", &[p.join("compose.yaml")], None, None)
            .unwrap();
        fs::remove_file(p.join(".env")).unwrap();
        symlink(&victim, p.join(".env")).unwrap();
        assert!(s.read("proy").is_err());
        assert!(s.save("proy", YAML, "X=1", None).is_err());
        assert_eq!(fs::read_to_string(&victim).unwrap(), "SECRETO_AJENO");
    }

    #[test]
    fn compose_symlink_o_fuera_del_proyecto_se_rechaza() {
        let t = TempDir::new();
        let s = store(&t);
        let p = project(&t);
        let victim = t.path().join("ajeno.yaml");
        fs::write(&victim, YAML).unwrap();
        symlink(&victim, p.join("enlace.yaml")).unwrap();
        assert!(s.link("a", &[p.join("enlace.yaml")], None, None).is_err());
        // Dos archivos donde el segundo vive fuera del directorio del primero.
        assert!(
            s.link("b", &[p.join("compose.yaml"), victim.clone()], None, None)
                .is_err()
        );
        // Vinculado y luego sustituido por un enlace: se rechaza y el destino queda intacto.
        s.link("c", &[p.join("compose.yaml")], None, None).unwrap();
        fs::remove_file(p.join("compose.yaml")).unwrap();
        symlink(&victim, p.join("compose.yaml")).unwrap();
        assert!(s.save("c", "x: 1\n", "", None).is_err());
        assert_eq!(fs::read_to_string(&victim).unwrap(), YAML);
    }

    #[test]
    fn sin_directorio_de_datos_es_un_error_claro() {
        let s = StackStore::unavailable();
        assert!(s.list().is_empty());
        assert_eq!(s.origin_of("web").unwrap(), None);
        for r in [s.create("web", YAML, "").map(|_| ()), s.require_available()] {
            let e = r.unwrap_err();
            assert!(
                e.to_string()
                    .contains("no se pudo determinar el directorio de datos"),
                "{e}"
            );
        }
        assert!(s.read("web").is_err());
    }

    #[test]
    fn tilde() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(
            expand_tilde("~/a/b.yaml").unwrap(),
            PathBuf::from(&home).join("a/b.yaml")
        );
        assert_eq!(expand_tilde("~").unwrap(), PathBuf::from(&home));
        assert_eq!(expand_tilde("~/").unwrap(), PathBuf::from(&home));
        assert!(expand_tilde("~/../x").is_err());
        assert!(expand_tilde("~/a/../../x").is_err());
        // `~usuario` no se expande: sigue siendo relativa y la validación la rechaza.
        assert_eq!(expand_tilde("~root/x").unwrap(), PathBuf::from("~root/x"));
        assert!(validate_external_file(&expand_tilde("~root/x.yaml").unwrap(), 10, true).is_err());
        assert_eq!(expand_tilde("/abs").unwrap(), PathBuf::from("/abs"));
    }

    #[test]
    fn link_json_manipulado_se_revalida_en_cada_uso() {
        let t = TempDir::new();
        let s = store(&t);
        let p = project(&t);
        s.link("proy", &[p.join("compose.yaml")], None, None)
            .unwrap();
        let lj = s.root().join("proy/link.json");
        for evil in ["/etc/passwd", "/proc/self/environ", "/tmp", "relativo.yaml"] {
            let data = LinkData {
                config_files: vec![evil.into()],
                working_dir: p.to_string_lossy().into_owned(),
                env_file: None,
                created_at: rfc3339_now(),
            };
            fs::write(&lj, serde_json::to_vec(&data).unwrap()).unwrap();
            assert!(s.read("proy").is_err(), "{evil}");
            assert!(s.resolve("proy").is_err(), "{evil}");
            assert!(s.save("proy", "x: 1\n", "", None).is_err(), "{evil}");
        }
        // env_file hostil.
        let data = LinkData {
            config_files: vec![p.join("compose.yaml").to_string_lossy().into_owned()],
            working_dir: "/proc".into(),
            env_file: None,
            created_at: String::new(),
        };
        fs::write(&lj, serde_json::to_vec(&data).unwrap()).unwrap();
        assert!(s.resolve("proy").is_err());
        // JSON roto.
        fs::write(&lj, "{roto").unwrap();
        assert!(s.read("proy").is_err());
        // link.json enorme.
        fs::write(&lj, "x".repeat(MAX_LINK_BYTES + 1)).unwrap();
        assert!(s.read("proy").is_err());
        // Ningún archivo ajeno fue tocado.
        assert_eq!(fs::read_to_string(p.join("compose.yaml")).unwrap(), YAML);
    }

    #[test]
    fn varios_archivos_es_solo_lectura() {
        let t = TempDir::new();
        let s = store(&t);
        let p = project(&t);
        fs::write(p.join("override.yaml"), YAML).unwrap();
        let f = s
            .link(
                "multi",
                &[p.join("compose.yaml"), p.join("override.yaml")],
                None,
                None,
            )
            .unwrap();
        assert!(!f.editable);
        assert_eq!(f.config_files.len(), 2);
        assert!(matches!(
            s.save("multi", "x: 1\n", "", None),
            Err(ComposeError::Denied(_))
        ));
    }

    #[test]
    fn stack_con_compose_y_link_a_la_vez_se_rechaza() {
        let t = TempDir::new();
        let s = store(&t);
        let p = project(&t);
        s.link("dual", &[p.join("compose.yaml")], None, None)
            .unwrap();
        fs::write(s.root().join("dual/compose.yaml"), YAML).unwrap();
        assert!(s.read("dual").is_err());
        assert!(s.list().iter().all(|x| x.name != "dual"));
    }

    #[test]
    fn lectura_externa_de_solo_lectura() {
        let t = TempDir::new();
        let p = project(&t);
        assert_eq!(
            read_external_readonly(&p.join("compose.yaml")).unwrap(),
            YAML
        );
        assert!(read_external_readonly(Path::new("/etc/passwd")).is_err());
        assert!(read_external_readonly(Path::new("/proc/self/environ")).is_err());
    }

    #[test]
    fn rfc3339() {
        let s = rfc3339_now();
        assert_eq!(s.len(), 20);
        assert!(s.ends_with('Z') && s.starts_with("20"));
    }

    #[test]
    fn lista_ordenada_y_mezcla_origenes() {
        let t = TempDir::new();
        let s = store(&t);
        let p = project(&t);
        s.create("zeta", YAML, "").unwrap();
        s.link("alfa", &[p.join("compose.yaml")], None, None)
            .unwrap();
        let l = s.list();
        assert_eq!(
            l.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(),
            ["alfa", "zeta"]
        );
        assert_eq!(l[0].origin, StackOrigin::Linked);
        assert_eq!(l[1].origin, StackOrigin::Managed);
        assert_eq!(s.origin_of("zeta").unwrap(), Some(StackOrigin::Managed));
        assert_eq!(s.origin_of("nada").unwrap(), None);
    }
}
