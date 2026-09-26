//! Crear contenedor / volumen / red: modelos (contrato con la UI), validación estricta pura,
//! detección de riesgos y servicio plan -> ticket -> crear.
//!
//! Reglas de seguridad: nunca hace pull; sin `privileged`, `cap_add`, `devices`, `pid=host`,
//! `user` ni `security_opt`; el comando se parte con `shlex` (jamás pasa por un shell);
//! los binds se resuelven (symlinks, `..`) ANTES de evaluar su sensibilidad y el backend
//! re-valida y re-planifica siempre al crear.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::actions::PlanDecision;
use crate::api::{ApiError, ApiErrorCode};
use crate::broker::{Broker, Clock, RedeemError, SystemClock, TICKET_TTL};
use crate::client::EngineClient;
use crate::error::EngineError;
use crate::policy::{Action, Decision, Interactivity, decide};
use crate::resources::{Network, Volume};

pub const MAX_PORTS: usize = 64;
pub const MAX_VOLUMES: usize = 64;
pub const MAX_ENV: usize = 256;
pub const MAX_ENV_VALUE: usize = 32 * 1024;
pub const MAX_ENV_TOTAL: usize = 128 * 1024;
pub const MAX_LABELS: usize = 32;
pub const MAX_LABEL_VALUE: usize = 4 * 1024;
pub const MAX_COMMAND_ARGS: usize = 64;
pub const MAX_COMMAND_BYTES: usize = 32 * 1024;
/// Etiqueta de origen que se añade siempre a lo creado por DockInng.
pub const CREATED_LABEL: &str = "dev.dockinng.created";
/// Prefijos de etiquetas reservados: nadie puede falsificar pertenencia a Compose/OCI.
pub const RESERVED_LABEL_PREFIXES: &[&str] = &["com.docker.", "io.docker.", "org.opencontainers."];
/// IP de publicación por defecto (decisión D2: solo este equipo).
pub const DEFAULT_HOST_IP: &str = "127.0.0.1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortProtocol {
    Tcp,
    Udp,
}

impl PortProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tcp => "tcp",
            Self::Udp => "udp",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortSpec {
    pub host_ip: Option<String>,
    /// `None` = puerto aleatorio del host.
    pub host_port: Option<u16>,
    pub container_port: u16,
    pub protocol: PortProtocol,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VolumeSpec {
    /// Nombre de volumen, ruta absoluta o `~/...`.
    pub source: String,
    pub target: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RestartPolicy {
    #[serde(rename = "no")]
    No,
    #[serde(rename = "always")]
    Always,
    #[serde(rename = "unless-stopped")]
    UnlessStopped,
    #[serde(rename = "on-failure")]
    OnFailure,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateContainerSpec {
    pub image: String,
    pub name: Option<String>,
    #[serde(default)]
    pub ports: Vec<PortSpec>,
    #[serde(default)]
    pub volumes: Vec<VolumeSpec>,
    #[serde(default)]
    pub env: Vec<EnvVar>,
    pub network: Option<String>,
    pub restart: RestartPolicy,
    pub restart_max_retries: Option<u32>,
    /// Sin shell: se parte con `shlex`.
    pub command: Option<String>,
    #[serde(default)]
    pub labels: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldError {
    /// `image`, `name`, `ports[0].host_port`, ... para pintar el error en línea.
    pub field: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CreateWarning {
    SensitiveBind {
        source: String,
        reason: String,
    },
    DockerSocket,
    HostNetwork,
    PortInUse {
        port: u16,
        by: String,
    },
    PublishedAllInterfaces {
        port: u16,
    },
    /// El daemon es remoto: este bind mount se resolverá en el sistema de archivos REMOTO.
    RemoteBind {
        source: String,
    },
}

impl CreateWarning {
    /// ¿Exige confirmación con ticket?
    pub fn needs_confirm(&self) -> bool {
        matches!(
            self,
            Self::SensitiveBind { .. } | Self::DockerSocket | Self::HostNetwork
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreatePlan {
    pub ok: bool,
    pub field_errors: Vec<FieldError>,
    pub warnings: Vec<CreateWarning>,
    pub decision: PlanDecision,
    pub ticket: Option<String>,
    pub expires_in_secs: u32,
    pub normalized: CreateContainerSpec,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateResult {
    pub id: String,
    pub name: String,
    pub started: bool,
    /// Avisos del daemon al crear.
    pub warnings: Vec<String>,
    pub start_error: Option<ApiError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateVolumeSpec {
    pub name: String,
    #[serde(default)]
    pub labels: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateNetworkSpec {
    pub name: String,
    #[serde(default)]
    pub internal: bool,
    pub subnet: Option<String>,
    pub gateway: Option<String>,
    #[serde(default)]
    pub labels: HashMap<String, String>,
}

/// Lo que el motor debe implementar. Recibe siempre specs ya validadas y normalizadas.
#[async_trait]
pub trait CreateEngine: Send + Sync {
    /// Nunca hace pull: imagen ausente => `Coded{image_missing}`.
    async fn create_container(
        &self,
        spec: &CreateContainerSpec,
        start: bool,
    ) -> Result<CreateResult, EngineError>;
    /// Comprueba existencia antes de crear (Docker es idempotente): duplicado => `Conflict`.
    async fn create_volume(&self, spec: &CreateVolumeSpec) -> Result<Volume, EngineError>;
    async fn create_network(&self, spec: &CreateNetworkSpec) -> Result<Network, EngineError>;
}

// ------------------------------------------------------------------ validación pura

fn err(field: impl Into<String>, message: impl Into<String>) -> FieldError {
    FieldError {
        field: field.into(),
        message: message.into(),
    }
}

/// `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$` (regla del daemon para contenedores y redes).
pub fn valid_resource_name(s: &str) -> bool {
    let mut b = s.bytes();
    s.len() <= 128
        && b.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}

fn valid_env_key(k: &str) -> bool {
    let mut b = k.bytes();
    b.next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// `^[a-z0-9][a-z0-9._/-]{0,127}$`.
fn valid_label_key(k: &str) -> bool {
    let mut b = k.bytes();
    k.len() <= 128
        && b.next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && k.bytes().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'/' | b'-')
        })
}

/// Valida etiquetas (contenedor, volumen, red).
pub fn validate_labels(labels: &HashMap<String, String>, field: &str, errs: &mut Vec<FieldError>) {
    if labels.len() > MAX_LABELS {
        errs.push(err(field, format!("máximo {MAX_LABELS} etiquetas")));
        return;
    }
    let mut keys: Vec<&String> = labels.keys().collect();
    keys.sort();
    for k in keys {
        let v = &labels[k];
        if !valid_label_key(k) {
            errs.push(err(format!("{field}.{k}"), "clave de etiqueta no válida"));
        } else if RESERVED_LABEL_PREFIXES.iter().any(|p| k.starts_with(p)) {
            errs.push(err(
                format!("{field}.{k}"),
                "prefijo de etiqueta reservado (com.docker., io.docker., org.opencontainers.)",
            ));
        } else if k == CREATED_LABEL {
            errs.push(err(
                format!("{field}.{k}"),
                "etiqueta reservada por DockInng",
            ));
        } else if v.len() > MAX_LABEL_VALUE || v.contains('\0') {
            errs.push(err(format!("{field}.{k}"), "valor de etiqueta no válido"));
        }
    }
}

/// Normalización léxica de una ruta absoluta: colapsa `//` y `.`; con `resolve_parent`
/// resuelve `..` (solo para orígenes de bind; el destino en el contenedor rechaza `..`).
fn lexical_abs(path: &str, resolve_parent: bool) -> Result<String, &'static str> {
    if path.contains('\0') {
        return Err("la ruta contiene un carácter nulo");
    }
    if !path.starts_with('/') {
        return Err("usa una ruta absoluta (empieza por /)");
    }
    let mut parts: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if !resolve_parent {
                    return Err("la ruta no puede contener ..");
                }
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

fn expand_home(source: &str, home: Option<&Path>) -> Result<String, &'static str> {
    if source == "~" || source.starts_with("~/") {
        let h = home
            .and_then(|h| h.to_str())
            .filter(|h| h.starts_with('/'))
            .ok_or("no se pudo resolver ~ (HOME desconocido)")?;
        return Ok(format!("{}{}", h.trim_end_matches('/'), &source[1..]));
    }
    Ok(source.to_string())
}

/// Valida y normaliza una spec. Pura: solo `home` entra del entorno. No toca el disco ni
/// el motor (la existencia de la red, la sensibilidad de los binds y los puertos ocupados
/// las evalúa `CreateService`).
pub fn validate_create(
    spec: &CreateContainerSpec,
    home: Option<&Path>,
) -> Result<CreateContainerSpec, Vec<FieldError>> {
    let mut errs = Vec::new();
    let mut out = spec.clone();

    // imagen
    let image = spec.image.trim();
    if image.is_empty() {
        errs.push(err("image", "indica una imagen"));
    } else if image.len() > 255 {
        errs.push(err("image", "referencia de imagen demasiado larga"));
    } else if crate::validate::image_reference(image).is_err() {
        errs.push(err(
            "image",
            "referencia de imagen con caracteres no permitidos",
        ));
    }
    out.image = image.to_string();

    // nombre
    out.name = spec
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(String::from);
    if let Some(n) = &out.name
        && !valid_resource_name(n)
    {
        errs.push(err(
            "name",
            "nombre no válido: solo letras, números, _ . - (empieza por letra o número)",
        ));
    }

    // puertos
    if spec.ports.len() > MAX_PORTS {
        errs.push(err("ports", format!("máximo {MAX_PORTS} puertos")));
    }
    let mut seen_ports = HashSet::new();
    for (i, p) in spec.ports.iter().enumerate().take(MAX_PORTS) {
        let f = |s: &str| format!("ports[{i}].{s}");
        if p.container_port == 0 {
            errs.push(err(
                f("container_port"),
                "el puerto del contenedor va de 1 a 65535",
            ));
        }
        // Puerto 0 del host = aleatorio.
        let host_port = p.host_port.filter(|hp| *hp != 0);
        let host_ip = match p
            .host_ip
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            None => DEFAULT_HOST_IP.to_string(),
            Some(ip) => match ip.parse::<IpAddr>() {
                Ok(a) => a.to_string(),
                Err(_) => {
                    errs.push(err(f("host_ip"), "dirección IP no válida"));
                    continue;
                }
            },
        };
        if let Some(hp) = host_port
            && !seen_ports.insert((host_ip.clone(), hp, p.protocol))
        {
            errs.push(err(f("host_port"), "puerto del equipo repetido"));
        }
        out.ports[i] = PortSpec {
            host_ip: Some(host_ip),
            host_port,
            container_port: p.container_port,
            protocol: p.protocol,
        };
    }

    // volúmenes
    if spec.volumes.len() > MAX_VOLUMES {
        errs.push(err("volumes", format!("máximo {MAX_VOLUMES} volúmenes")));
    }
    let mut targets = HashSet::new();
    for (i, v) in spec.volumes.iter().enumerate().take(MAX_VOLUMES) {
        let f = |s: &str| format!("volumes[{i}].{s}");
        match lexical_abs(&v.target, false) {
            Err(m) => errs.push(err(f("target"), m)),
            Ok(t) => {
                if t.contains([',', ':']) {
                    errs.push(err(f("target"), "el destino no puede contener , ni :"));
                } else if !targets.insert(t.clone()) {
                    errs.push(err(f("target"), "destino repetido"));
                }
                out.volumes[i].target = t;
            }
        }
        let src = v.source.trim();
        if src.is_empty() {
            errs.push(err(f("source"), "indica un volumen o una ruta"));
        } else if src.starts_with('/') || src == "~" || src.starts_with("~/") {
            match expand_home(src, home).and_then(|s| lexical_abs(&s, true)) {
                Ok(s) => out.volumes[i].source = s,
                Err(m) => errs.push(err(f("source"), m)),
            }
        } else if src.starts_with('.') || src.contains('/') || src.starts_with('~') {
            errs.push(err(
                f("source"),
                "usa una ruta absoluta (p. ej. /srv/datos) o el nombre de un volumen",
            ));
        } else if crate::validate::volume_name(src).is_err() || src.len() > 128 {
            errs.push(err(f("source"), "nombre de volumen no válido"));
        } else {
            out.volumes[i].source = src.to_string();
        }
    }

    // entorno
    if spec.env.len() > MAX_ENV {
        errs.push(err("env", format!("máximo {MAX_ENV} variables")));
    }
    let mut keys = HashSet::new();
    let mut total = 0usize;
    for (i, e) in spec.env.iter().enumerate().take(MAX_ENV) {
        if !valid_env_key(&e.key) {
            errs.push(err(
                format!("env[{i}].key"),
                "nombre de variable no válido (letras, números y _; no empieza por número)",
            ));
        } else if !keys.insert(e.key.clone()) {
            errs.push(err(format!("env[{i}].key"), "variable repetida"));
        }
        if e.value.contains('\0') || e.value.len() > MAX_ENV_VALUE {
            errs.push(err(
                format!("env[{i}].value"),
                "valor no válido o demasiado largo",
            ));
        }
        total += e.key.len() + e.value.len() + 1;
    }
    if total > MAX_ENV_TOTAL {
        errs.push(err("env", "el entorno total supera 128 KiB"));
    }

    // red (la existencia se comprueba en el servicio)
    out.network = spec
        .network
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(String::from);
    if let Some(n) = &out.network
        && !valid_resource_name(n)
    {
        errs.push(err("network", "nombre de red no válido"));
    }

    // reinicio
    match (spec.restart, spec.restart_max_retries) {
        (RestartPolicy::OnFailure, Some(n)) if n > 100_000 => {
            errs.push(err("restart_max_retries", "máximo 100000 reintentos"));
        }
        (RestartPolicy::OnFailure, _) => {}
        (_, Some(_)) => {
            errs.push(err(
                "restart_max_retries",
                "los reintentos solo valen con on-failure",
            ));
        }
        _ => {}
    }

    // comando (sin shell)
    out.command = spec
        .command
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(String::from);
    if let Some(c) = &out.command {
        match parse_command(c) {
            Ok(_) => {}
            Err(m) => errs.push(err("command", m)),
        }
    }

    validate_labels(&spec.labels, "labels", &mut errs);

    if errs.is_empty() { Ok(out) } else { Err(errs) }
}

/// Parte el comando con `shlex`. Jamás llega a un shell: se pasa como `cmd` (argv) al daemon.
pub fn parse_command(command: &str) -> Result<Vec<String>, String> {
    if command.len() > MAX_COMMAND_BYTES || command.contains('\0') {
        return Err("comando demasiado largo o con caracteres no válidos".into());
    }
    let args = shlex::split(command).ok_or("comillas sin cerrar en el comando")?;
    if args.len() > MAX_COMMAND_ARGS {
        return Err(format!("máximo {MAX_COMMAND_ARGS} argumentos"));
    }
    Ok(args)
}

/// Validación de un volumen nuevo.
pub fn validate_volume(spec: &CreateVolumeSpec) -> Result<(), Vec<FieldError>> {
    let mut errs = Vec::new();
    if spec.name.is_empty() {
        errs.push(err("name", "indica un nombre"));
    } else if spec.name.len() > 128 || crate::validate::volume_name(&spec.name).is_err() {
        errs.push(err(
            "name",
            "nombre no válido: solo letras, números, _ . - (empieza por letra o número)",
        ));
    }
    validate_labels(&spec.labels, "labels", &mut errs);
    if errs.is_empty() { Ok(()) } else { Err(errs) }
}

/// Nombres reservados: redes predefinidas y de sistema de Docker (incluye Swarm).
const RESERVED_NETWORKS: &[&str] = &[
    "bridge",
    "host",
    "none",
    "default",
    "docker0",
    "ingress",
    "docker_gwbridge",
];

/// Validación de una red nueva. Devuelve subred y puerta normalizadas.
pub fn validate_network(spec: &CreateNetworkSpec) -> Result<(), Vec<FieldError>> {
    let mut errs = Vec::new();
    if !valid_resource_name(&spec.name) {
        errs.push(err(
            "name",
            "nombre no válido: solo letras, números, _ . - (empieza por letra o número)",
        ));
    } else if RESERVED_NETWORKS.contains(&spec.name.to_ascii_lowercase().as_str()) {
        errs.push(err("name", "nombre reservado del sistema"));
    }
    let mut subnet = None;
    if let Some(s) = spec
        .subnet
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        match parse_cidr(s) {
            Ok(v) => subnet = Some(v),
            Err(m) => errs.push(err("subnet", m)),
        }
    }
    if let Some(g) = spec
        .gateway
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        match (g.parse::<IpAddr>(), subnet) {
            (Err(_), _) => errs.push(err("gateway", "dirección IP no válida")),
            (Ok(_), None) => errs.push(err("gateway", "la puerta de enlace requiere una subred")),
            (Ok(ip), Some((net, prefix))) => {
                if !cidr_contains(net, prefix, ip) {
                    errs.push(err(
                        "gateway",
                        "la puerta de enlace debe estar dentro de la subred",
                    ));
                }
            }
        }
    }
    validate_labels(&spec.labels, "labels", &mut errs);
    if errs.is_empty() { Ok(()) } else { Err(errs) }
}

/// CIDR válido con prefijo razonable (IPv4 /8-/30, IPv6 /16-/126).
pub fn parse_cidr(s: &str) -> Result<(IpAddr, u8), &'static str> {
    let (ip, prefix) = s
        .split_once('/')
        .ok_or("usa notación CIDR (p. ej. 172.30.0.0/24)")?;
    let ip: IpAddr = ip.parse().map_err(|_| "subred no válida")?;
    let prefix: u8 = prefix.parse().map_err(|_| "prefijo de subred no válido")?;
    let ok = match ip {
        IpAddr::V4(_) => (8..=30).contains(&prefix),
        IpAddr::V6(_) => (16..=126).contains(&prefix),
    };
    if !ok {
        return Err("prefijo fuera de rango (IPv4 /8 a /30, IPv6 /16 a /126)");
    }
    // Solo rangos privados: loopback, link-local, multicast, reservados y direcciones
    // públicas (p. ej. 1.1.1.0/24) romperían el enrutamiento del equipo.
    let private: &[(IpAddr, u8)] = &[
        (IpAddr::from([10, 0, 0, 0]), 8),
        (IpAddr::from([172, 16, 0, 0]), 12),
        (IpAddr::from([192, 168, 0, 0]), 16),
        (IpAddr::from([0xfc00u16, 0, 0, 0, 0, 0, 0, 0]), 7),
    ];
    if !private
        .iter()
        .any(|(net, p)| prefix >= *p && cidr_contains(*net, *p, ip))
    {
        return Err("usa un rango privado (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 o fc00::/7)");
    }
    Ok((ip, prefix))
}

fn cidr_contains(net: IpAddr, prefix: u8, ip: IpAddr) -> bool {
    match (net, ip) {
        (IpAddr::V4(n), IpAddr::V4(i)) => {
            let mask = u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0);
            u32::from(n) & mask == u32::from(i) & mask
        }
        (IpAddr::V6(n), IpAddr::V6(i)) => {
            let mask = u128::MAX.checked_shl(128 - u32::from(prefix)).unwrap_or(0);
            u128::from(n) & mask == u128::from(i) & mask
        }
        _ => false,
    }
}

// ------------------------------------------------------------- sensibilidad de rutas

/// Rutas del sistema cuyo INTERIOR es sensible: un bind de `/etc/ssl` sigue exponiendo `/etc`,
/// y uno de `/usr/bin` escribible da persistencia desde el contenedor.
const SYSTEM_TREES: &[&str] = &[
    "/etc",
    "/root",
    "/boot",
    "/dev",
    "/proc",
    "/sys",
    "/run",
    "/var/run",
    "/var/lib/docker",
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib32",
    "/lib64",
    "/libx32",
];

/// Rutas sensibles solo si el bind las IGUALA o las CONTIENE (montar `/opt` entero expone
/// todo, pero `/opt/app` o `/srv/datos` son datos legítimos).
const SYSTEM_ROOTS: &[&str] = &["/", "/home", "/opt", "/srv"];

/// Subrutas de `$HOME` con credenciales, configuración o arranque de shell: montarlas
/// (sobre todo en escritura) expone secretos o da persistencia.
const HOME_TREES: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".config",
    ".docker",
    ".local",
    ".mozilla",
    ".cache",
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".bash_logout",
    ".profile",
    ".zshrc",
    ".zshenv",
    ".zprofile",
    ".zlogin",
];

/// Minúsculas: en sistemas de archivos insensibles a mayúsculas `/ETC` es `/etc`.
fn lower(p: &Path) -> PathBuf {
    PathBuf::from(p.to_string_lossy().to_lowercase())
}

/// ¿Es el socket del daemon (docker/podman)?
pub fn is_engine_socket(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == "docker.sock" || n == "podman.sock")
}

/// Motivo por el que un bind (ya normalizado/resuelto) es sensible, o `None`.
pub fn sensitive_reason(path: &Path, home: Option<&Path>) -> Option<String> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Some("ruta no normalizada".into());
    }
    let p = lower(path);
    let home = home.map(lower);

    let mut trees: Vec<PathBuf> = SYSTEM_TREES.iter().map(PathBuf::from).collect();
    let mut roots: Vec<PathBuf> = SYSTEM_ROOTS.iter().map(PathBuf::from).collect();
    if let Some(h) = &home {
        roots.push(h.clone());
        trees.extend(HOME_TREES.iter().map(|t| h.join(t)));
        // Todo `/home` fuera de `$HOME` (otros usuarios) es sensible, también por dentro.
        if p.starts_with("/home") && !p.starts_with(h) {
            return Some("está dentro del directorio de otro usuario".into());
        }
    } else if p.starts_with("/home") {
        return Some("está dentro de /home".into());
    }
    for root in trees.iter().chain(roots.iter()) {
        if p == *root {
            return Some(format!("es {}", root.display()));
        }
        // El bind CONTIENE a la ruta sensible.
        if root.starts_with(&p) {
            return Some(format!("contiene {}", root.display()));
        }
    }
    for tree in &trees {
        if p.starts_with(tree) {
            return Some(format!("está dentro de {}", tree.display()));
        }
    }
    None
}

// ------------------------------------------------------------------------- servicio

#[derive(Debug, Clone)]
struct CreatePayload {
    spec: CreateContainerSpec,
}

pub struct CreateService {
    engine: Arc<dyn EngineClient>,
    creator: Arc<dyn CreateEngine>,
    broker: Broker<CreatePayload>,
    home: Option<PathBuf>,
}

struct Evaluation {
    normalized: CreateContainerSpec,
    field_errors: Vec<FieldError>,
    warnings: Vec<CreateWarning>,
    decision: Decision,
}

impl CreateService {
    pub fn new(engine: Arc<dyn EngineClient>, creator: Arc<dyn CreateEngine>) -> Self {
        Self::with_clock(
            engine,
            creator,
            Arc::new(SystemClock::new()),
            std::env::var_os("HOME").map(PathBuf::from),
        )
    }

    pub fn with_clock(
        engine: Arc<dyn EngineClient>,
        creator: Arc<dyn CreateEngine>,
        clock: Arc<dyn Clock>,
        home: Option<PathBuf>,
    ) -> Self {
        Self {
            engine,
            creator,
            broker: Broker::new(clock),
            home,
        }
    }

    pub fn invalidate_all(&self) {
        self.broker.clear();
    }

    pub fn pending_tickets(&self) -> usize {
        self.broker.pending()
    }

    async fn evaluate(&self, spec: &CreateContainerSpec) -> Result<Evaluation, ApiError> {
        // Con un daemon remoto el `$HOME` local no aplica (ni `~`, ni symlinks locales).
        let remote = self.engine.is_remote();
        let home = if remote { None } else { self.home.as_deref() };
        let (mut normalized, mut field_errors) = match validate_create(spec, home) {
            Ok(n) => (n, Vec::new()),
            Err(e) => (spec.clone(), e),
        };
        let mut warnings = Vec::new();
        if !field_errors.is_empty() {
            return Ok(Evaluation {
                normalized,
                field_errors,
                warnings,
                decision: Decision::Allow,
            });
        }

        // Red: debe existir (el daemon aceptaría una inexistente al crear y fallaría al iniciar).
        if let Some(n) = normalized.network.clone() {
            match n.as_str() {
                "host" => warnings.push(CreateWarning::HostNetwork),
                "bridge" | "none" | "default" => {}
                other => {
                    let nets = self.engine.list_networks().await?;
                    if !nets.iter().any(|x| x.name == other) {
                        field_errors.push(err("network", format!("la red {other} no existe")));
                    }
                }
            }
        }

        // Puertos del equipo ya publicados por contenedores en ejecución (informativo).
        if normalized.ports.iter().any(|p| p.host_port.is_some()) {
            // Informativo: si el motor no responde, el aviso simplemente no se emite.
            let containers = self.engine.list_containers(false).await.unwrap_or_default();
            for p in &normalized.ports {
                let Some(hp) = p.host_port else { continue };
                if let Some(c) = containers.iter().find(|c| {
                    c.ports.iter().any(|m| {
                        m.public_port == Some(hp)
                            && m.protocol.eq_ignore_ascii_case(p.protocol.as_str())
                    })
                }) {
                    warnings.push(CreateWarning::PortInUse {
                        port: hp,
                        by: c.names.first().cloned().unwrap_or_else(|| c.id.clone()),
                    });
                }
            }
        }
        for p in &normalized.ports {
            if let (Some(ip), Some(port)) = (&p.host_ip, p.host_port.or(Some(0)))
                && ip.parse::<IpAddr>().is_ok_and(|a| a.is_unspecified())
            {
                warnings.push(CreateWarning::PublishedAllInterfaces { port });
            }
        }

        // Binds: se resuelven symlinks ANTES de evaluar; lo confirmado es lo que se monta.
        for v in &mut normalized.volumes {
            if !v.source.starts_with('/') {
                continue;
            }
            if remote {
                // La ruta pertenece al servidor: no se canonicaliza en local ni se evalúa contra
                // el `$HOME` local, pero `/`, los árboles de sistema y el socket del motor
                // siguen exigiendo confirmación. `RemoteBind` es un aviso ADICIONAL.
                let p = Path::new(&v.source);
                if is_engine_socket(p) {
                    if !warnings.contains(&CreateWarning::DockerSocket) {
                        warnings.push(CreateWarning::DockerSocket);
                    }
                } else {
                    if let Some(reason) = sensitive_reason(p, None) {
                        warnings.push(CreateWarning::SensitiveBind {
                            source: v.source.clone(),
                            reason,
                        });
                    }
                    warnings.push(CreateWarning::RemoteBind {
                        source: v.source.clone(),
                    });
                }
                continue;
            }
            let resolved = std::fs::canonicalize(&v.source)
                .ok()
                .and_then(|p| p.to_str().map(String::from));
            if let Some(r) = resolved {
                v.source = r;
            }
            let p = Path::new(&v.source);
            if is_engine_socket(p) {
                if !warnings.contains(&CreateWarning::DockerSocket) {
                    warnings.push(CreateWarning::DockerSocket);
                }
            } else if let Some(reason) = sensitive_reason(p, home) {
                warnings.push(CreateWarning::SensitiveBind {
                    source: v.source.clone(),
                    reason,
                });
            }
        }

        let decision = if warnings.iter().any(CreateWarning::needs_confirm) {
            decide(&Action::CreateSensitive, Interactivity::Interactive, false)
        } else {
            Decision::Allow
        };
        Ok(Evaluation {
            normalized,
            field_errors,
            warnings,
            decision,
        })
    }

    /// Valida, evalúa riesgos y, si hace falta confirmar, emite un ticket ligado a la spec.
    pub async fn plan(&self, spec: CreateContainerSpec) -> Result<CreatePlan, ApiError> {
        let ev = self.evaluate(&spec).await?;
        let ok = ev.field_errors.is_empty();
        let needs_ticket = ok && !matches!(ev.decision, Decision::Allow | Decision::Deny(_));
        let ticket = if needs_ticket {
            Some(
                self.broker
                    .issue(
                        CreatePayload {
                            spec: ev.normalized.clone(),
                        },
                        ev.decision.clone(),
                    )
                    .map_err(|_| {
                        ApiError::new(
                            ApiErrorCode::Conflict,
                            "demasiados planes pendientes: confirma o cancela alguno antes de crear otro",
                        )
                    })?,
            )
        } else {
            None
        };
        Ok(CreatePlan {
            ok,
            field_errors: ev.field_errors,
            warnings: ev.warnings,
            decision: PlanDecision::from(&ev.decision),
            ticket,
            expires_in_secs: TICKET_TTL.as_secs() as u32,
            normalized: ev.normalized,
        })
    }

    /// Re-valida y re-planifica SIEMPRE; si la decisión no es `Allow` exige un ticket del
    /// MISMO spec normalizado. Nunca hace pull.
    pub async fn create(
        &self,
        spec: CreateContainerSpec,
        start: bool,
        ticket: Option<&str>,
    ) -> Result<CreateResult, ApiError> {
        let ev = self.evaluate(&spec).await?;
        if !ev.field_errors.is_empty() {
            let msg = ev
                .field_errors
                .iter()
                .map(|e| format!("{}: {}", e.field, e.message))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(ApiError::new(ApiErrorCode::InvalidInput, msg));
        }
        let mut redeemed: Option<(String, Decision)> = None;
        if !matches!(ev.decision, Decision::Allow) {
            if matches!(ev.decision, Decision::Deny(_)) {
                return Err(ApiError::new(
                    ApiErrorCode::PolicyDenied,
                    "la política no permite esta acción",
                ));
            }
            let t = ticket.ok_or_else(|| {
                ApiError::new(
                    ApiErrorCode::TicketInvalid,
                    "esta configuración requiere confirmación: planifica y confirma primero",
                )
            })?;
            let (payload, redeemed_decision) =
                self.broker.redeem(t, None).map_err(|e| match e {
                    RedeemError::Invalid => ApiError::new(
                        ApiErrorCode::TicketInvalid,
                        "el ticket no existe o ya se usó",
                    ),
                    RedeemError::Expired => {
                        ApiError::new(ApiErrorCode::TicketExpired, "el ticket expiró")
                    }
                    RedeemError::TypedMismatch => ApiError::new(
                        ApiErrorCode::TypedMismatch,
                        "la confirmación escrita no coincide",
                    ),
                })?;
            if payload.spec != ev.normalized {
                return Err(ApiError::new(
                    ApiErrorCode::TicketInvalid,
                    "el ticket corresponde a otra configuración",
                ));
            }
            redeemed = Some((t.to_string(), redeemed_decision));
        }
        match self.creator.create_container(&ev.normalized, start).await {
            Ok(r) => Ok(r),
            Err(e) => {
                // Un error aquí significa que NO se creó nada (el fallo de arranque no llega
                // como `Err`): el ticket no se consume. Así `image_missing` -> pull -> reintento
                // con el mismo ticket funciona (la UI además puede volver a planificar).
                if let Some((t, d)) = redeemed {
                    self.broker.restore(
                        &t,
                        CreatePayload {
                            spec: ev.normalized.clone(),
                        },
                        d,
                    );
                }
                Err(e.into())
            }
        }
    }

    pub async fn create_volume(&self, spec: CreateVolumeSpec) -> Result<Volume, ApiError> {
        if let Err(e) = validate_volume(&spec) {
            return Err(field_errors_to_api(&e));
        }
        Ok(self.creator.create_volume(&spec).await?)
    }

    pub async fn create_network(&self, spec: CreateNetworkSpec) -> Result<Network, ApiError> {
        if let Err(e) = validate_network(&spec) {
            return Err(field_errors_to_api(&e));
        }
        Ok(self.creator.create_network(&spec).await?)
    }
}

fn field_errors_to_api(errs: &[FieldError]) -> ApiError {
    let msg = errs
        .iter()
        .map(|e| format!("{}: {}", e.field, e.message))
        .collect::<Vec<_>>()
        .join("; ");
    ApiError::new(ApiErrorCode::InvalidInput, msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::tests::FakeClock;
    use crate::testing::MockEngine;
    use crate::testing_create::MockCreate;

    fn spec(image: &str) -> CreateContainerSpec {
        CreateContainerSpec {
            image: image.into(),
            name: None,
            ports: vec![],
            volumes: vec![],
            env: vec![],
            network: None,
            restart: RestartPolicy::No,
            restart_max_retries: None,
            command: None,
            labels: HashMap::new(),
        }
    }

    fn vol(source: &str, target: &str) -> VolumeSpec {
        VolumeSpec {
            source: source.into(),
            target: target.into(),
            read_only: false,
        }
    }

    fn fields(r: Result<CreateContainerSpec, Vec<FieldError>>) -> Vec<String> {
        r.expect_err("debía fallar")
            .into_iter()
            .map(|e| e.field)
            .collect()
    }

    const HOME: &str = "/home/tester";

    fn v(s: &CreateContainerSpec) -> Result<CreateContainerSpec, Vec<FieldError>> {
        validate_create(s, Some(Path::new(HOME)))
    }

    #[test]
    fn spec_minima_valida_y_puerto_por_defecto_en_loopback() {
        let mut s = spec("alpine:latest");
        s.ports.push(PortSpec {
            host_ip: None,
            host_port: Some(8080),
            container_port: 80,
            protocol: PortProtocol::Tcp,
        });
        let n = v(&s).expect("válida");
        assert_eq!(n.ports[0].host_ip.as_deref(), Some("127.0.0.1"));
        // Puerto de host 0 = aleatorio (None).
        s.ports[0].host_port = Some(0);
        assert_eq!(v(&s).expect("ok").ports[0].host_port, None);
    }

    #[test]
    fn imagen_y_nombre() {
        for bad in ["", "  ", "a b", "--x", "a/../b", "x\ny"] {
            assert_eq!(fields(v(&spec(bad))), ["image"], "{bad:?}");
        }
        assert_eq!(fields(v(&spec(&"a".repeat(256)))), ["image"]);
        let mut s = spec("alpine");
        for bad in ["a/b", "..", "-x", "a b", "a?b", "ñ", &"a".repeat(129)] {
            s.name = Some(bad.into());
            assert_eq!(fields(v(&s)), ["name"], "{bad:?}");
        }
        s.name = Some("web_1.a-b".into());
        assert!(v(&s).is_ok());
        // Nombre en blanco = sin nombre.
        s.name = Some("  ".into());
        assert_eq!(v(&s).expect("ok").name, None);
    }

    #[test]
    fn puertos_invalidos() {
        let p = |ip: Option<&str>, hp: Option<u16>, cp: u16| PortSpec {
            host_ip: ip.map(String::from),
            host_port: hp,
            container_port: cp,
            protocol: PortProtocol::Tcp,
        };
        let mut s = spec("alpine");
        s.ports = vec![p(None, Some(80), 0)];
        assert_eq!(fields(v(&s)), ["ports[0].container_port"]);
        s.ports = vec![p(Some("999.1.1.1"), Some(80), 80)];
        assert_eq!(fields(v(&s)), ["ports[0].host_ip"]);
        s.ports = vec![p(Some("0.0.0.0; rm"), None, 80)];
        assert_eq!(fields(v(&s)), ["ports[0].host_ip"]);
        s.ports = vec![p(None, Some(80), 80), p(Some("127.0.0.1"), Some(80), 81)];
        assert_eq!(fields(v(&s)), ["ports[1].host_port"]);
        // Mismo puerto en IPs distintas: válido.
        s.ports = vec![
            p(Some("127.0.0.1"), Some(80), 80),
            p(Some("::1"), Some(80), 80),
        ];
        assert!(v(&s).is_ok());
        s.ports = (0..65).map(|_| p(None, None, 80)).collect();
        assert!(fields(v(&s)).contains(&"ports".to_string()));
    }

    #[test]
    fn volumenes_validacion() {
        let mut s = spec("alpine");
        // El ejemplo relativo de la UI debe fallar con mensaje claro.
        s.volumes = vec![vol("./datos", "/data")];
        let e = v(&s).expect_err("relativa");
        assert_eq!(e[0].field, "volumes[0].source");
        assert!(e[0].message.contains("ruta absoluta"));
        s.volumes = vec![vol("datos/x", "/data")];
        assert_eq!(fields(v(&s)), ["volumes[0].source"]);
        s.volumes = vec![vol("mi-vol", "relativo")];
        assert_eq!(fields(v(&s)), ["volumes[0].target"]);
        for bad in ["/a/../b", "/a,b", "/a:b", "/a\0b"] {
            s.volumes = vec![vol("mi-vol", bad)];
            assert_eq!(fields(v(&s)), ["volumes[0].target"], "{bad:?}");
        }
        s.volumes = vec![vol("a", "/d"), vol("b", "/d/")];
        assert_eq!(fields(v(&s)), ["volumes[1].target"]);
        s.volumes = vec![vol("bad name", "/d")];
        assert_eq!(fields(v(&s)), ["volumes[0].source"]);
        s.volumes = vec![vol("~otro/x", "/d")];
        assert_eq!(fields(v(&s)), ["volumes[0].source"]);
        // Normalización.
        s.volumes = vec![
            vol("/srv//datos/./x/../y", "//data//sub/"),
            vol("~/proy", "/p"),
        ];
        let n = v(&s).expect("ok");
        assert_eq!(n.volumes[0].source, "/srv/datos/y");
        assert_eq!(n.volumes[0].target, "/data/sub");
        assert_eq!(n.volumes[1].source, "/home/tester/proy");
        // Sin HOME, `~` no se resuelve.
        assert!(validate_create(&s, None).is_err());
        s.volumes = (0..65).map(|i| vol("v", &format!("/t{i}"))).collect();
        assert!(fields(v(&s)).contains(&"volumes".to_string()));
    }

    #[test]
    fn entorno_validacion() {
        let e = |k: &str, val: &str| EnvVar {
            key: k.into(),
            value: val.into(),
        };
        let mut s = spec("alpine");
        for bad in ["A=B", "1A", "A B", "", "A-B", "ñ"] {
            s.env = vec![e(bad, "x")];
            assert_eq!(fields(v(&s)), ["env[0].key"], "{bad:?}");
        }
        s.env = vec![e("A", "1"), e("A", "2")];
        assert_eq!(fields(v(&s)), ["env[1].key"]);
        s.env = vec![e("A", "a\0b")];
        assert_eq!(fields(v(&s)), ["env[0].value"]);
        s.env = vec![e("A", &"x".repeat(MAX_ENV_VALUE + 1))];
        assert_eq!(fields(v(&s)), ["env[0].value"]);
        s.env = (0..5)
            .map(|i| e(&format!("K{i}"), &"x".repeat(MAX_ENV_VALUE)))
            .collect();
        assert!(fields(v(&s)).contains(&"env".to_string()));
        s.env = (0..257).map(|i| e(&format!("K{i}"), "1")).collect();
        assert!(fields(v(&s)).contains(&"env".to_string()));
        s.env = vec![e("_OK1", "a=b=c")];
        assert!(v(&s).is_ok());
    }

    #[test]
    fn reinicio_y_comando() {
        let mut s = spec("alpine");
        s.restart = RestartPolicy::Always;
        s.restart_max_retries = Some(3);
        assert_eq!(fields(v(&s)), ["restart_max_retries"]);
        s.restart = RestartPolicy::OnFailure;
        assert!(v(&s).is_ok());
        s.restart_max_retries = Some(100_001);
        assert_eq!(fields(v(&s)), ["restart_max_retries"]);
        s.restart_max_retries = None;
        s.command = Some("sleep 'sin cerrar".into());
        assert_eq!(fields(v(&s)), ["command"]);
        s.command = Some(
            (0..65)
                .map(|i| format!("a{i}"))
                .collect::<Vec<_>>()
                .join(" "),
        );
        assert_eq!(fields(v(&s)), ["command"]);
        s.command = Some("   ".into());
        assert_eq!(v(&s).expect("ok").command, None);
    }

    #[test]
    fn el_comando_se_parte_sin_shell() {
        // Metacaracteres de shell quedan como argumentos literales.
        assert_eq!(
            parse_command("echo hola; rm -rf /").expect("ok"),
            ["echo", "hola;", "rm", "-rf", "/"]
        );
        assert_eq!(
            parse_command("echo $(id) `id`").expect("ok"),
            ["echo", "$(id)", "`id`"]
        );
        assert_eq!(
            parse_command("sh -c \"echo a b\"").expect("ok"),
            ["sh", "-c", "echo a b"]
        );
        assert!(parse_command("a 'b").is_err());
    }

    #[test]
    fn etiquetas_reservadas_y_limites() {
        let mut s = spec("alpine");
        for bad in [
            "com.docker.compose.project",
            "io.docker.x",
            "org.opencontainers.image.x",
            "dev.dockinng.created",
            "A",
            "a=b",
            "-x",
            "",
        ] {
            s.labels = HashMap::from([(bad.to_string(), "1".to_string())]);
            assert!(v(&s).is_err(), "{bad:?}");
        }
        s.labels = HashMap::from([("dev.dockinng.test".to_string(), "1".to_string())]);
        assert!(v(&s).is_ok());
        s.labels = HashMap::from([("k".to_string(), "x".repeat(MAX_LABEL_VALUE + 1))]);
        assert!(v(&s).is_err());
        s.labels = (0..33)
            .map(|i| (format!("k{i}"), "1".to_string()))
            .collect();
        assert!(v(&s).is_err());
    }

    #[test]
    fn volumen_y_red_validacion() {
        let vs = |n: &str| CreateVolumeSpec {
            name: n.into(),
            labels: HashMap::new(),
        };
        assert!(validate_volume(&vs("datos_1")).is_ok());
        for bad in ["", "a b", "a/b", "-x", "..", &"a".repeat(129)] {
            assert!(validate_volume(&vs(bad)).is_err(), "{bad:?}");
        }
        let ns = |n: &str, sub: Option<&str>, gw: Option<&str>| CreateNetworkSpec {
            name: n.into(),
            internal: false,
            subnet: sub.map(String::from),
            gateway: gw.map(String::from),
            labels: HashMap::new(),
        };
        assert!(validate_network(&ns("mi-red", Some("172.30.0.0/24"), Some("172.30.0.1"))).is_ok());
        for reserved in [
            "bridge",
            "HOST",
            "None",
            "default",
            "docker0",
            "Ingress",
            "docker_gwbridge",
        ] {
            assert!(
                validate_network(&ns(reserved, None, None)).is_err(),
                "{reserved}"
            );
        }
        for bad_subnet in [
            "127.0.0.0/8",
            "169.254.0.0/16",
            "224.0.0.0/24",
            "1.1.1.0/24",
            "0.0.0.0/8",
            "172.0.0.0/8",
            "172.32.0.0/16",
            "fe80::/64",
            "ff00::/16",
            "2001:db8::/32",
            "999.1.1.0/24",
            "172.30.0.0",
            "172.30.0.0/7",
            "172.30.0.0/31",
            "x/24",
        ] {
            assert!(
                validate_network(&ns("r", Some(bad_subnet), None)).is_err(),
                "{bad_subnet}"
            );
        }
        assert!(validate_network(&ns("r", Some("fd00::/64"), Some("fd00::1"))).is_ok());
        assert!(validate_network(&ns("r", Some("172.30.0.0/24"), Some("10.0.0.1"))).is_err());
        assert!(validate_network(&ns("r", None, Some("10.0.0.1"))).is_err());
        assert!(validate_network(&ns("r", Some("172.30.0.0/24"), Some("fd00::1"))).is_err());
        assert!(validate_network(&ns("bad name", None, None)).is_err());
    }

    #[test]
    fn rutas_sensibles() {
        let home = Some(Path::new(HOME));
        for p in [
            "/",
            "/etc",
            "/etc/ssl",
            "/root",
            "/home",
            "/home/tester",
            "/boot",
            "/dev",
            "/proc",
            "/sys/kernel",
            "/run",
            "/var/run",
            "/var/lib/docker",
            "/var/lib",
            "/var",
            "/home/tester/.ssh",
            "/home/tester/.ssh/keys",
            "/home/tester/.aws",
            "/home/tester/.kube",
            "/home/tester/.gnupg",
            // Ampliación de la ronda 1: escritura peligrosa / persistencia / credenciales.
            "/usr",
            "/usr/bin",
            "/usr/local/share",
            "/bin",
            "/sbin",
            "/lib",
            "/lib64",
            "/opt",
            "/srv",
            "/home/otro",
            "/home/otro/proyectos",
            "/home/otro/.ssh",
            "/home/tester/.config",
            "/home/tester/.config/fish",
            "/home/tester/.docker",
            "/home/tester/.docker/config.json",
            "/home/tester/.local/share",
            "/home/tester/.mozilla",
            "/home/tester/.cache",
            "/home/tester/.bashrc",
            "/home/tester/.zshrc",
            "/home/tester/.profile",
            "/home/tester/.bash_profile",
            "/home/tester/.bash_login",
            "/home/tester/.zprofile",
            // Mayúsculas (sistemas de archivos insensibles).
            "/ETC",
            "/Usr/Bin",
            "/HOME/Tester/.SSH",
            "/home/TESTER/.Bashrc",
        ] {
            assert!(sensitive_reason(Path::new(p), home).is_some(), "{p}");
        }
        for p in [
            "/srv/datos",
            "/srv/datos/x",
            "/home/tester/proyecto",
            "/home/tester/proyectos/x",
            "/home/tester/.config-no", // no es `.config`
            "/opt/app",
            "/tmp/datos",
            "/tmp/x",
            "/var/www",
            "/mnt/toji",
        ] {
            assert!(sensitive_reason(Path::new(p), home).is_none(), "{p}");
        }
        assert!(is_engine_socket(Path::new("/var/run/docker.sock")));
        assert!(!is_engine_socket(Path::new("/srv/docker.sock.d")));
    }

    /// Sin `$HOME` conocido, todo `/home` se trata como sensible.
    #[test]
    fn sin_home_todo_home_es_sensible() {
        assert!(sensitive_reason(Path::new("/home/x/proy"), None).is_some());
        assert!(sensitive_reason(Path::new("/tmp/x"), None).is_none());
    }

    // ---------------------------------------------------------------- servicio

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dockinng-core-{tag}-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&d).expect("tmp");
        d
    }

    fn svc(engine: &Arc<MockEngine>, creator: &Arc<MockCreate>) -> CreateService {
        CreateService::with_clock(
            engine.clone(),
            creator.clone(),
            Arc::new(FakeClock::default()),
            Some(PathBuf::from(HOME)),
        )
    }

    /// Motor de mentira que se declara REMOTO y delega todo lo demás en `MockEngine`.
    struct RemoteEngine(Arc<MockEngine>);

    #[async_trait::async_trait]
    impl crate::EngineClient for RemoteEngine {
        fn is_remote(&self) -> bool {
            true
        }
        async fn ping(&self) -> Result<(), crate::EngineError> {
            self.0.ping().await
        }
        async fn info(&self) -> Result<crate::EngineInfo, crate::EngineError> {
            self.0.info().await
        }
        async fn diagnose(&self) -> crate::ConnectionStatus {
            self.0.diagnose().await
        }
        async fn reconnect(&self) -> crate::ConnectionStatus {
            self.0.reconnect().await
        }
        async fn list_containers(
            &self,
            all: bool,
        ) -> Result<Vec<crate::Container>, crate::EngineError> {
            self.0.list_containers(all).await
        }
        async fn inspect_container(
            &self,
            id: &str,
        ) -> Result<crate::ContainerDetail, crate::EngineError> {
            self.0.inspect_container(id).await
        }
        async fn start_container(&self, id: &str) -> Result<(), crate::EngineError> {
            self.0.start_container(id).await
        }
        async fn stop_container(&self, id: &str) -> Result<(), crate::EngineError> {
            self.0.stop_container(id).await
        }
        async fn restart_container(&self, id: &str) -> Result<(), crate::EngineError> {
            self.0.restart_container(id).await
        }
        async fn remove_container(&self, id: &str, force: bool) -> Result<(), crate::EngineError> {
            self.0.remove_container(id, force).await
        }
        async fn stats_snapshot(
            &self,
            id: &str,
        ) -> Result<crate::ContainerStats, crate::EngineError> {
            self.0.stats_snapshot(id).await
        }
        async fn list_images(&self) -> Result<Vec<crate::Image>, crate::EngineError> {
            self.0.list_images().await
        }
        async fn remove_image(&self, reference: &str) -> Result<(), crate::EngineError> {
            self.0.remove_image(reference).await
        }
        async fn list_volumes(&self) -> Result<Vec<crate::Volume>, crate::EngineError> {
            self.0.list_volumes().await
        }
        async fn inspect_volume(&self, name: &str) -> Result<crate::Volume, crate::EngineError> {
            self.0.inspect_volume(name).await
        }
        async fn remove_volume(&self, name: &str) -> Result<(), crate::EngineError> {
            self.0.remove_volume(name).await
        }
        async fn list_networks(&self) -> Result<Vec<crate::Network>, crate::EngineError> {
            self.0.list_networks().await
        }
        async fn remove_network(&self, id: &str) -> Result<(), crate::EngineError> {
            self.0.remove_network(id).await
        }
        async fn system_usage(&self) -> Result<crate::SystemUsage, crate::EngineError> {
            self.0.system_usage().await
        }
        fn events(&self) -> crate::EngineStream<crate::EngineEvent> {
            self.0.events()
        }
        fn logs(&self, id: &str, req: crate::LogsRequest) -> crate::EngineStream<crate::LogLine> {
            self.0.logs(id, req)
        }
        fn stats(&self, id: &str) -> crate::EngineStream<crate::ContainerStats> {
            self.0.stats(id)
        }
    }

    fn bind_spec(src: &str) -> CreateContainerSpec {
        let mut s = spec("alpine");
        s.volumes = vec![vol(src, "/mnt/x")];
        s
    }

    /// Con un daemon remoto `/`, los árboles de sistema y el socket del motor SIGUEN exigiendo
    /// confirmación (sin evaluar `$HOME` local); una ruta ordinaria solo avisa `RemoteBind`.
    #[tokio::test]
    async fn binds_en_remoto_mantienen_confirmacion_de_rutas_sensibles() {
        let e = Arc::new(MockEngine::new());
        let c = Arc::new(MockCreate::default());
        let remote: Arc<dyn crate::EngineClient> = Arc::new(RemoteEngine(e.clone()));
        assert!(remote.is_remote());
        let s = CreateService::with_clock(
            remote,
            c.clone(),
            Arc::new(FakeClock::default()),
            Some(PathBuf::from(HOME)),
        );
        for src in [
            "/",
            "/etc",
            "/root",
            "/var/lib/docker",
            "/var/run/docker.sock",
        ] {
            let p = s.plan(bind_spec(src)).await.expect("plan");
            assert!(p.ok, "{src}: {:?}", p.field_errors);
            assert_eq!(p.decision, PlanDecision::Confirm, "{src}");
            assert!(p.ticket.is_some(), "{src}");
        }
        let p = s.plan(bind_spec("/etc")).await.expect("plan");
        assert!(
            p.warnings
                .iter()
                .any(|w| matches!(w, CreateWarning::SensitiveBind { .. }))
        );
        assert!(
            p.warnings
                .iter()
                .any(|w| matches!(w, CreateWarning::RemoteBind { .. }))
        );
        let p = s
            .plan(bind_spec("/var/run/docker.sock"))
            .await
            .expect("plan");
        assert!(p.warnings.contains(&CreateWarning::DockerSocket));
        // Ruta ordinaria: solo el aviso remoto, sin confirmación.
        let p = s.plan(bind_spec("/srv/datos")).await.expect("plan");
        assert_eq!(p.decision, PlanDecision::Allow);
        assert_eq!(
            p.warnings,
            vec![CreateWarning::RemoteBind {
                source: "/srv/datos".into()
            }]
        );
        // En local nunca aparece `RemoteBind`.
        let local = svc(&e, &c);
        let p = local.plan(bind_spec("/srv/datos")).await.expect("plan");
        assert!(
            !p.warnings
                .iter()
                .any(|w| matches!(w, CreateWarning::RemoteBind { .. }))
        );
    }

    #[tokio::test]
    async fn binds_sensibles_exigen_confirmacion_y_srv_no() {
        let e = Arc::new(MockEngine::new());
        let c = Arc::new(MockCreate::default());
        let s = svc(&e, &c);
        for src in [
            "/",
            "/etc",
            "/var/run/docker.sock",
            "/home/tester/.ssh",
            "//etc//",
            "/tmp/../etc",
            "/srv/../",
            "~/.ssh",
        ] {
            let p = s.plan(bind_spec(src)).await.expect("plan");
            assert!(p.ok, "{src}: {:?}", p.field_errors);
            assert_eq!(p.decision, PlanDecision::Confirm, "{src}");
            assert!(p.ticket.is_some(), "{src}");
        }
        let p = s.plan(bind_spec("/srv/datos")).await.expect("plan");
        assert_eq!(p.decision, PlanDecision::Allow);
        assert!(p.ticket.is_none());
        // El socket con :ro (read_only) sigue siendo sensible.
        let mut ro = bind_spec("/var/run/docker.sock");
        ro.volumes[0].read_only = true;
        let p = s.plan(ro).await.expect("plan");
        assert!(p.warnings.contains(&CreateWarning::DockerSocket));
        assert_eq!(p.decision, PlanDecision::Confirm);
    }

    /// Variantes con `..`, `//`, mayúsculas y symlinks hacia rutas de escritura peligrosa.
    #[tokio::test]
    async fn binds_peligrosos_por_variantes_y_symlinks_exigen_confirmacion() {
        let e = Arc::new(MockEngine::new());
        let c = Arc::new(MockCreate::default());
        let s = svc(&e, &c);
        for src in [
            "/usr/bin",
            "/tmp/../usr/bin",
            "//usr//lib/",
            "/opt",
            "/home/otro/.ssh",
            "/home/tester/../otro",
            "~/.bashrc",
            "~/.docker",
            "~/.config/fish",
            "/USR/BIN",
        ] {
            let p = s.plan(bind_spec(src)).await.expect("plan");
            assert_eq!(p.decision, PlanDecision::Confirm, "{src}");
        }
        for src in ["/tmp/datos", "~/proyectos/x", "/srv/datos"] {
            let p = s.plan(bind_spec(src)).await.expect("plan");
            assert_eq!(p.decision, PlanDecision::Allow, "{src}");
        }
        let d = tmp("symlink2");
        for (name, target) in [("a", "/usr/bin"), ("b", "/opt")] {
            let link = d.join(name);
            std::os::unix::fs::symlink(target, &link).expect("symlink");
            let p = s
                .plan(bind_spec(link.to_str().expect("utf8")))
                .await
                .expect("plan");
            assert_eq!(p.decision, PlanDecision::Confirm, "{target}");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn un_symlink_hacia_la_raiz_se_resuelve_antes_de_evaluar() {
        let d = tmp("symlink");
        let link = d.join("x");
        std::os::unix::fs::symlink("/", &link).expect("symlink");
        let e = Arc::new(MockEngine::new());
        let c = Arc::new(MockCreate::default());
        let s = svc(&e, &c);
        let p = s
            .plan(bind_spec(link.to_str().expect("utf8")))
            .await
            .expect("plan");
        assert_eq!(p.decision, PlanDecision::Confirm);
        // Lo que se confirma es la ruta resuelta.
        assert_eq!(p.normalized.volumes[0].source, "/");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn network_host_exige_confirmacion_y_red_inexistente_es_error_de_campo() {
        let e = Arc::new(MockEngine::new());
        e.state()
            .networks
            .push(MockEngine::network("n1", "mi-red", &[], false));
        let c = Arc::new(MockCreate::default());
        let s = svc(&e, &c);
        let mut sp = spec("alpine");
        sp.network = Some("host".into());
        let p = s.plan(sp.clone()).await.expect("plan");
        assert_eq!(p.decision, PlanDecision::Confirm);
        assert!(p.warnings.contains(&CreateWarning::HostNetwork));
        sp.network = Some("mi-red".into());
        assert!(s.plan(sp.clone()).await.expect("plan").ok);
        sp.network = Some("no-existe".into());
        let p = s.plan(sp).await.expect("plan");
        assert!(!p.ok);
        assert_eq!(p.field_errors[0].field, "network");
    }

    #[tokio::test]
    async fn ticket_de_un_uso_y_ligado_a_la_spec() {
        let e = Arc::new(MockEngine::new());
        let c = Arc::new(MockCreate::default());
        let s = svc(&e, &c);
        let sensible = bind_spec("/etc");
        // Sin ticket: rechazado y nada se crea.
        let err = s
            .create(sensible.clone(), false, None)
            .await
            .expect_err("sin ticket");
        assert_eq!(err.code, ApiErrorCode::TicketInvalid);
        assert!(c.calls().is_empty());
        // Con ticket válido: se crea, y el ticket no se reutiliza.
        let t = s
            .plan(sensible.clone())
            .await
            .expect("plan")
            .ticket
            .expect("ticket");
        s.create(sensible.clone(), true, Some(&t))
            .await
            .expect("crea");
        assert_eq!(c.calls().len(), 1);
        let err = s
            .create(sensible.clone(), true, Some(&t))
            .await
            .expect_err("reuso");
        assert_eq!(err.code, ApiErrorCode::TicketInvalid);
        // Ticket de otra spec: rechazado (y consumido).
        let t = s
            .plan(sensible.clone())
            .await
            .expect("plan")
            .ticket
            .expect("ticket");
        let mut otra = sensible.clone();
        otra.volumes[0].source = "/root".into();
        let err = s
            .create(otra, false, Some(&t))
            .await
            .expect_err("otra spec");
        assert_eq!(err.code, ApiErrorCode::TicketInvalid);
        assert_eq!(c.calls().len(), 1);
        // Una spec sin riesgo no necesita ticket.
        s.create(spec("alpine"), false, None).await.expect("libre");
        assert_eq!(c.calls().len(), 2);
    }

    /// `image_missing` no consume el ticket: tras el pull el reintento con el MISMO ticket funciona.
    #[tokio::test]
    async fn un_fallo_previo_a_crear_no_consume_el_ticket() {
        let e = Arc::new(MockEngine::new());
        let c = Arc::new(MockCreate::default());
        let s = svc(&e, &c);
        let sensible = bind_spec("/etc");
        let t = s
            .plan(sensible.clone())
            .await
            .expect("plan")
            .ticket
            .expect("t");
        c.set_fail(Some(EngineError::coded(
            ApiErrorCode::ImageMissing,
            "No such image",
        )));
        let err = s
            .create(sensible.clone(), true, Some(&t))
            .await
            .expect_err("sin imagen");
        assert_eq!(err.code, ApiErrorCode::ImageMissing);
        assert_eq!(s.pending_tickets(), 1, "el ticket sigue vivo");
        // Tras el pull, el mismo ticket sirve; y ahora sí se consume.
        c.set_fail(None);
        s.create(sensible.clone(), true, Some(&t))
            .await
            .expect("reintento");
        let err = s
            .create(sensible, true, Some(&t))
            .await
            .expect_err("consumido");
        assert_eq!(err.code, ApiErrorCode::TicketInvalid);
    }

    /// Camino real de la UI: planifica una spec "sucia", pasa `plan.normalized` (no la cruda)
    /// a `create` con el ticket, y la huella coincide con lo confirmado.
    #[tokio::test]
    async fn el_camino_real_plan_normalized_con_ticket_crea_lo_confirmado() {
        let e = Arc::new(MockEngine::new());
        let c = Arc::new(MockCreate::default());
        let s = svc(&e, &c);
        let d = tmp("norm");
        std::fs::create_dir_all(d.join("sub")).expect("sub");
        let dirty_src = format!("{}//sub/../sub/./", d.display());
        let mut raw = spec("  alpine:latest ");
        raw.name = Some("  web-1 ".into());
        raw.network = Some(" host ".into());
        raw.command = Some("  sleep 5  ".into());
        raw.ports = vec![PortSpec {
            host_ip: None,
            host_port: Some(0),
            container_port: 80,
            protocol: PortProtocol::Tcp,
        }];
        raw.volumes = vec![
            vol(&dirty_src, "//data//x/"),
            vol("~/proyectos/../proyectos/x", "/p"),
        ];
        let plan = s.plan(raw.clone()).await.expect("plan");
        assert!(plan.ok, "{:?}", plan.field_errors);
        assert_eq!(plan.decision, PlanDecision::Confirm);
        let n = plan.normalized.clone();
        assert_eq!(n.image, "alpine:latest");
        assert_eq!(n.name.as_deref(), Some("web-1"));
        assert_eq!(n.network.as_deref(), Some("host"));
        assert_eq!(n.volumes[0].target, "/data/x");
        assert!(n.volumes[0].source.ends_with("/sub") && !n.volumes[0].source.contains(".."));
        assert_eq!(n.volumes[1].source, "/home/tester/proyectos/x");
        assert_eq!(n.ports[0].host_ip.as_deref(), Some("127.0.0.1"));
        assert_eq!(n.ports[0].host_port, None);

        // (d) idempotencia: normalizar dos veces = una.
        let again = s.plan(n.clone()).await.expect("plan 2");
        assert_eq!(again.normalized, n);
        assert_eq!(validate_create(&n, Some(Path::new(HOME))).expect("ok"), n);

        // (b) la spec normalizada + ticket se acepta y crea exactamente lo confirmado.
        let t = plan.ticket.expect("ticket");
        s.create(n.clone(), true, Some(&t)).await.expect("crea");
        assert_eq!(c.specs(), vec![n.clone()]);

        // (c) modificar `normalized` tras el plan invalida la huella del ticket.
        let t2 = s.plan(raw).await.expect("plan").ticket.expect("t2");
        let mut otro_bind = n.clone();
        otro_bind.volumes[1].source = "/root".into();
        let mut otro_puerto = n.clone();
        otro_puerto.ports[0].host_port = Some(54100);
        for tampered in [otro_bind, otro_puerto] {
            let t = s.plan(n.clone()).await.expect("plan").ticket.expect("t");
            let err = s
                .create(tampered, true, Some(&t))
                .await
                .expect_err("huella");
            assert_eq!(err.code, ApiErrorCode::TicketInvalid);
        }
        let _ = t2;
        assert_eq!(c.specs().len(), 1, "nada modificado llegó al motor");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn crear_revalida_y_pasa_la_spec_normalizada() {
        let e = Arc::new(MockEngine::new());
        let c = Arc::new(MockCreate::default());
        let s = svc(&e, &c);
        let err = s
            .create(spec("a b"), false, None)
            .await
            .expect_err("inválida");
        assert_eq!(err.code, ApiErrorCode::InvalidInput);
        assert!(c.calls().is_empty());
        let mut sp = spec("alpine");
        sp.ports.push(PortSpec {
            host_ip: None,
            host_port: Some(54100),
            container_port: 80,
            protocol: PortProtocol::Tcp,
        });
        s.create(sp, false, None).await.expect("ok");
        let calls = c.specs();
        assert_eq!(calls[0].ports[0].host_ip.as_deref(), Some("127.0.0.1"));
    }

    #[tokio::test]
    async fn aviso_de_puerto_ocupado_y_todas_las_interfaces() {
        let e = Arc::new(MockEngine::new());
        {
            let mut d = MockEngine::container("id1", "web", crate::ContainerState::Running, "t");
            d.summary.ports.push(crate::PortMapping {
                ip: Some("0.0.0.0".into()),
                private_port: 80,
                public_port: Some(8080),
                protocol: "tcp".into(),
            });
            e.state().containers.push(d);
        }
        let c = Arc::new(MockCreate::default());
        let s = svc(&e, &c);
        let mut sp = spec("alpine");
        sp.ports.push(PortSpec {
            host_ip: Some("0.0.0.0".into()),
            host_port: Some(8080),
            container_port: 80,
            protocol: PortProtocol::Tcp,
        });
        let p = s.plan(sp).await.expect("plan");
        assert!(p.warnings.contains(&CreateWarning::PortInUse {
            port: 8080,
            by: "web".into()
        }));
        assert!(
            p.warnings
                .contains(&CreateWarning::PublishedAllInterfaces { port: 8080 })
        );
        // Informativos: no exigen confirmación.
        assert_eq!(p.decision, PlanDecision::Allow);
    }

    #[tokio::test]
    async fn volumen_y_red_pasan_por_validacion() {
        let e = Arc::new(MockEngine::new());
        let c = Arc::new(MockCreate::default());
        let s = svc(&e, &c);
        let bad = CreateVolumeSpec {
            name: "a b".into(),
            labels: HashMap::new(),
        };
        assert_eq!(
            s.create_volume(bad).await.expect_err("inválido").code,
            ApiErrorCode::InvalidInput
        );
        assert!(c.calls().is_empty());
        let ok = CreateNetworkSpec {
            name: "mi-red".into(),
            internal: false,
            subnet: None,
            gateway: None,
            labels: HashMap::new(),
        };
        s.create_network(ok).await.expect("ok");
        assert_eq!(c.calls(), ["create_network:mi-red"]);
    }

    #[test]
    fn json_de_la_spec_coincide_con_el_frontend() {
        let j = serde_json::json!({
            "image": "alpine", "name": null,
            "ports": [{"host_ip": null, "host_port": null, "container_port": 80, "protocol": "tcp"}],
            "volumes": [{"source": "v", "target": "/d", "read_only": true}],
            "env": [{"key": "A", "value": "b"}], "network": null,
            "restart": "unless-stopped", "restart_max_retries": null, "command": null, "labels": {}
        });
        let s: CreateContainerSpec = serde_json::from_value(j).expect("de");
        assert_eq!(s.restart, RestartPolicy::UnlessStopped);
        let back = serde_json::to_value(&s).expect("ser");
        assert_eq!(back["restart"], "unless-stopped");
        assert_eq!(back["ports"][0]["protocol"], "tcp");
    }
}
