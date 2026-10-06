//! Contrato de conexiones remotas, grupos y preferencias que comparten la app y la CLI.
//! Solo tipos serde y validación pura: sin E/S (la persistencia vive en el crate `store` y
//! el transporte en `transport`). Nunca contiene contenido de llaves: solo RUTAS.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::api::ApiError;
use crate::connection::ConnectionCause;
use crate::error::EngineError;
use crate::model::EngineInfo;

/// Id reservado del motor local integrado (excepción documentada: no es un id generado).
pub const LOCAL_CONNECTION_ID: &str = "local";
pub const MAX_NAME: usize = 40;
pub const MAX_GROUPS: usize = 500;
pub const MAX_ASSIGNMENTS: usize = 20_000;
pub const MAX_PATH: usize = 4096;

/// Cómo se resuelve el destino SSH.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SshMode {
    /// host/usuario/puerto explícitos; no se lee ninguna configuración de ssh (`-F /dev/null`).
    Explicit,
    /// `host` es un alias de `~/.ssh/config` que resuelve el propio `ssh`.
    Alias,
}

/// Identidad SSH: agente o ruta de llave (nunca su contenido).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SshIdentity {
    Agent,
    File { path: String },
}

/// Especificación de una conexión remota tal como llega de la UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConnSpec {
    Ssh {
        name: String,
        host: String,
        port: u32,
        user: String,
        mode: SshMode,
        identity: SshIdentity,
    },
    Tls {
        name: String,
        host: String,
        port: u32,
        ca_path: String,
        cert_path: String,
        key_path: String,
    },
}

impl ConnSpec {
    pub fn name(&self) -> &str {
        match self {
            ConnSpec::Ssh { name, .. } | ConnSpec::Tls { name, .. } => name,
        }
    }

    pub fn host(&self) -> &str {
        match self {
            ConnSpec::Ssh { host, .. } | ConnSpec::Tls { host, .. } => host,
        }
    }

    pub fn port(&self) -> u32 {
        match self {
            ConnSpec::Ssh { port, .. } | ConnSpec::Tls { port, .. } => *port,
        }
    }
}

/// Perfil guardado. Las conexiones reales nunca son simuladas.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionProfile {
    /// UUID v7.
    pub id: String,
    #[serde(flatten)]
    pub spec: ConnSpec,
    /// Siempre `true` para perfiles guardados (el local no se persiste).
    pub remote: bool,
    /// Huella SHA256 de la clave de servidor en la que se confió (solo SSH).
    pub host_key_fp: Option<String>,
    pub simulated: bool,
}

/// Estado de la clave de servidor frente al `known_hosts` propio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostKeyState {
    Unknown,
    Trusted,
    Changed,
}

/// Resultado de sondear la clave de un servidor (primer contacto explícito, TOFU).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostKeyProbe {
    pub key_type: String,
    pub fingerprint_sha256: String,
    pub state: HostKeyState,
}

/// Resultado de probar una conexión.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnTestResult {
    pub ok: bool,
    pub server: Option<EngineInfo>,
    pub error: Option<ApiError>,
    pub cause: Option<ConnectionCause>,
}

// ---------------------------------------------------------------------------------------
// Validación de campos (frontera de confianza: todo lo que llegue de la UI pasa por aquí).
// ---------------------------------------------------------------------------------------

fn invalid(msg: impl Into<String>) -> EngineError {
    EngineError::InvalidInput(msg.into())
}

/// Caracteres de control C0/DEL y de control bidireccional: no se admiten en nombres.
fn has_forbidden_chars(t: &str) -> bool {
    t.chars().any(|c| {
        let n = c as u32;
        n <= 0x1f || n == 0x7f || (0x202a..=0x202e).contains(&n) || (0x2066..=0x2069).contains(&n)
    })
}

/// Nombre visible de grupo o conexión: recortado, 1..=40 caracteres, sin controles ni bidi.
/// Devuelve el nombre normalizado (sin espacios en los extremos).
pub fn validate_display_name(name: &str) -> Result<String, EngineError> {
    let t = name.trim();
    if t.is_empty() {
        return Err(invalid("escribe un nombre"));
    }
    if t.chars().count() > MAX_NAME {
        return Err(invalid(format!("máximo {MAX_NAME} caracteres")));
    }
    if has_forbidden_chars(t) {
        return Err(invalid("el nombre tiene caracteres no permitidos"));
    }
    Ok(t.to_string())
}

/// Matiz 0..=359.
pub fn validate_hue(hue: i64) -> Result<u16, EngineError> {
    u16::try_from(hue)
        .ok()
        .filter(|h| *h < 360)
        .ok_or_else(|| invalid("el matiz debe estar entre 0 y 359"))
}

/// Verdadero si `id` es un UUID v7 en forma canónica.
pub fn is_uuid_v7(id: &str) -> bool {
    id.len() == 36
        && uuid::Uuid::parse_str(id).is_ok_and(|u| u.get_version_num() == 7)
        && id == id.to_ascii_lowercase()
}

/// Host: `[A-Za-z0-9._-]{1,253}` sin `-` inicial, o IPv6 entre corchetes.
pub fn validate_host(host: &str) -> Result<(), EngineError> {
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        let ok = !inner.is_empty()
            && inner.len() <= 45
            && inner.contains(':')
            && inner
                .chars()
                .all(|c| c.is_ascii_hexdigit() || matches!(c, ':' | '.'));
        return if ok {
            Ok(())
        } else {
            Err(invalid("host IPv6 inválido"))
        };
    }
    let ok = !host.is_empty()
        && host.len() <= 253
        && !host.starts_with('-')
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(invalid(
            "host inválido (solo letras, números, '.', '_' y '-')",
        ))
    }
}

/// Usuario de SSH: letras, dígitos, `_`, `-` y `.`; no empieza por `-` ni `.`; máx. 32. Sin
/// metacaracteres de shell ni de ssh (`@`, `%`, espacios, `;`...).
pub fn validate_user(user: &str) -> Result<(), EngineError> {
    let ok = !user.is_empty()
        && user.len() <= 32
        && !user.starts_with(['-', '.'])
        && user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
    if ok {
        Ok(())
    } else {
        Err(invalid("usuario inválido"))
    }
}

/// Puerto 1..=65535.
pub fn validate_port(port: u32) -> Result<u16, EngineError> {
    u16::try_from(port)
        .ok()
        .filter(|p| *p != 0)
        .ok_or_else(|| invalid("puerto inválido (1-65535)"))
}

/// Ruta absoluta, sin NUL ni saltos de línea, de largo acotado. NO comprueba existencia.
pub fn validate_abs_path(path: &str, what: &str) -> Result<(), EngineError> {
    if path.is_empty()
        || path.len() > MAX_PATH
        || !path.starts_with('/')
        || path.chars().any(|c| c == '\0' || c == '\n' || c == '\r')
    {
        return Err(invalid(format!(
            "{what}: debe ser una ruta absoluta válida"
        )));
    }
    Ok(())
}

/// Ruta que se pasará a `ssh` (`-i`, `-o UserKnownHostsFile=`): además de absoluta, sin `%`
/// (ssh expande `%h`, `%d`...), espacios ni comillas, que alteran el análisis de `-o`.
pub fn validate_ssh_path(path: &str, what: &str) -> Result<(), EngineError> {
    validate_abs_path(path, what)?;
    if path
        .chars()
        .any(|c| c == '%' || c.is_whitespace() || c == '"' || c == '\'' || c == '\\')
    {
        return Err(invalid(format!(
            "{what}: la ruta no puede contener '%', espacios ni comillas"
        )));
    }
    Ok(())
}

/// Valida toda la especificación (sin tocar el sistema de archivos).
pub fn validate_spec(spec: &ConnSpec) -> Result<(), EngineError> {
    validate_display_name(spec.name())?;
    validate_host(spec.host())?;
    match spec {
        ConnSpec::Ssh {
            port,
            user,
            mode,
            identity,
            ..
        } => {
            // En modo alias, usuario y puerto pueden venir de la configuración de ssh.
            if *mode == SshMode::Alias && user.is_empty() {
                // sin usuario explícito
            } else {
                validate_user(user)?;
            }
            if !(*mode == SshMode::Alias && *port == 0) {
                validate_port(*port)?;
            }
            if let SshIdentity::File { path } = identity {
                validate_ssh_path(path, "llave privada")?;
            }
        }
        ConnSpec::Tls {
            port,
            ca_path,
            cert_path,
            key_path,
            ..
        } => {
            validate_port(*port)?;
            validate_abs_path(ca_path, "CA")?;
            validate_abs_path(cert_path, "certificado de cliente")?;
            validate_abs_path(key_path, "llave de cliente")?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Grupos y preferencias.
// ---------------------------------------------------------------------------------------

/// Grupo propio del usuario para la tabla de contenedores.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub hue: u16,
}

/// Asignación de un contenedor (por nombre y por conexión) a un grupo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupAssignment {
    pub connection_id: String,
    pub container_name: String,
    pub group_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct GroupsSnapshot {
    pub groups: Vec<Group>,
    pub assignments: Vec<GroupAssignment>,
    pub stack_hues: BTreeMap<String, u16>,
    pub legacy_imported: bool,
}

/// Mutaciones atómicas de grupos. Devuelven el snapshot completo resultante.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GroupOp {
    CreateGroup {
        name: String,
        hue: Option<i64>,
    },
    RenameGroup {
        id: String,
        name: String,
    },
    SetGroupHue {
        id: String,
        hue: i64,
    },
    DeleteGroup {
        id: String,
    },
    Assign {
        connection_id: String,
        names: Vec<String>,
        group_id: Option<String>,
    },
    SetStackHue {
        project: String,
        hue: Option<i64>,
    },
    /// Quita las asignaciones de una conexión cuyo contenedor ya no existe. `live_names` debe ser
    /// la lista COMPLETA de contenedores de esa conexión: sin ella no se sabe qué sobra.
    PruneAssignments {
        connection_id: String,
        live_names: Vec<String>,
    },
}

/// Grupo tal como lo guardaba el frontend en `localStorage` (`dockinng.groups.v1`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LegacyGroup {
    pub id: String,
    pub name: String,
    pub hue: i64,
}

/// Payload de migración única: `{v:1, groups, assign, stackHue}` tal cual lo produce el FE.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LegacyGroups {
    pub v: u32,
    pub groups: Vec<LegacyGroup>,
    /// Clave `"<profileId>\0<container>"` -> id de grupo.
    #[serde(default)]
    pub assign: BTreeMap<String, String>,
    #[serde(default, rename = "stackHue")]
    pub stack_hue: BTreeMap<String, i64>,
}

/// Resultado de importar un archivo exportado con «Exportar grupos».
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ExportImportReport {
    pub groups_created: u32,
    /// Grupos del archivo que ya existían con ese nombre (se reutilizan, no se duplican).
    pub groups_reused: u32,
    pub assignments_imported: u32,
    /// Asignaciones descartadas: conexión que no existe aquí, grupo sin correspondencia o nombre inválido.
    pub assignments_skipped: u32,
    pub stack_hues_imported: u32,
}

/// Resultado de la migración de grupos.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct LegacyImportReport {
    pub already_imported: bool,
    pub imported_groups: u32,
    pub imported_assignments: u32,
    /// Asignaciones descartadas (perfil desconocido, grupo inexistente, nombre inválido).
    pub dropped_assignments: u32,
    pub snapshot: GroupsSnapshot,
}

/// Claves de preferencias permitidas (lista blanca validada en Rust).
pub const PREF_KEYS: &[&str] = &[
    "polling",
    "last_connection_id",
    "notify_enabled",
    "notify_events",
    "tray_enabled",
    "close_to_tray",
    "window_decorations",
    "start_minimized",
];

/// Preferencias cuyo valor es un booleano (o `null` para volver al valor por defecto).
pub const BOOL_PREF_KEYS: &[&str] = &[
    "notify_enabled",
    "tray_enabled",
    "close_to_tray",
    "window_decorations",
    "start_minimized",
];

/// Eventos notificables de `notify_events` (objeto con estas claves booleanas, todas opcionales).
pub const NOTIFY_EVENT_KEYS: &[&str] = &["die", "oom", "unhealthy", "op_done"];

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh(host: &str, user: &str, port: u32) -> ConnSpec {
        ConnSpec::Ssh {
            name: "srv".into(),
            host: host.into(),
            port,
            user: user.into(),
            mode: SshMode::Explicit,
            identity: SshIdentity::Agent,
        }
    }

    #[test]
    fn hosts_validos_e_invalidos() {
        for ok in ["example.com", "10.0.0.1", "my_host-1", "[::1]", "[fe80::1]"] {
            assert!(validate_host(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "-oProxyCommand=x",
            "a b",
            "a;b",
            "a/b",
            "[]",
            "[abc]",
            "[::1",
            "ho$t",
            "a\nb",
            "-host",
        ] {
            assert!(validate_host(bad).is_err(), "{bad}");
        }
        assert!(validate_host(&"a".repeat(254)).is_err());
    }

    #[test]
    fn usuarios_y_puertos() {
        for ok in [
            "root",
            "deploy",
            "_svc",
            "a-b_c9",
            "Administrator",
            "9a",
            "svc.user",
        ] {
            assert!(validate_user(ok).is_ok(), "{ok}");
        }
        for bad in ["", "a b", "-a", ".a", "a;b", "a@b", "a%h", &"a".repeat(33)] {
            assert!(validate_user(bad).is_err(), "{bad}");
        }
        assert!(validate_port(22).is_ok());
        assert!(validate_port(65535).is_ok());
        assert!(validate_port(0).is_err());
        assert!(validate_port(65536).is_err());
    }

    #[test]
    fn spec_ssh_serde_y_validacion() {
        let json = serde_json::json!({
            "kind": "ssh", "name": "prod", "host": "example.com", "port": 22,
            "user": "deploy", "mode": "explicit", "identity": {"type": "file", "path": "/k/id"}
        });
        let spec: ConnSpec = serde_json::from_value(json.clone()).unwrap();
        assert!(validate_spec(&spec).is_ok());
        assert_eq!(serde_json::to_value(&spec).unwrap(), json);
        assert!(validate_spec(&ssh("-x", "u", 22)).is_err());
        assert!(validate_spec(&ssh("h", "Bad User", 22)).is_err());
        assert!(validate_spec(&ssh("h", "u", 0)).is_err());
        // Ruta de llave relativa: rechazada.
        let rel = ConnSpec::Ssh {
            name: "n".into(),
            host: "h".into(),
            port: 22,
            user: "u".into(),
            mode: SshMode::Explicit,
            identity: SshIdentity::File { path: "id".into() },
        };
        assert!(validate_spec(&rel).is_err());
    }

    #[test]
    fn spec_alias_admite_sin_usuario_ni_puerto() {
        let s = ConnSpec::Ssh {
            name: "n".into(),
            host: "miserver".into(),
            port: 0,
            user: String::new(),
            mode: SshMode::Alias,
            identity: SshIdentity::Agent,
        };
        assert!(validate_spec(&s).is_ok());
    }

    #[test]
    fn spec_tls_exige_rutas_absolutas() {
        let mut spec = ConnSpec::Tls {
            name: "t".into(),
            host: "h.example".into(),
            port: 2376,
            ca_path: "/c/ca.pem".into(),
            cert_path: "/c/cert.pem".into(),
            key_path: "/c/key.pem".into(),
        };
        assert!(validate_spec(&spec).is_ok());
        if let ConnSpec::Tls { ca_path, .. } = &mut spec {
            *ca_path = "ca.pem".into();
        }
        assert!(validate_spec(&spec).is_err());
    }

    #[test]
    fn rutas_para_ssh_rechazan_percent_espacios_y_comillas() {
        assert!(validate_ssh_path("/home/u/.ssh/id_ed25519", "k").is_ok());
        for bad in [
            "/a/%h/id", "/a b/id", "/a/\"id", "/a/'id", "/a/\\id", "rel/id", "/a\tb",
        ] {
            assert!(validate_ssh_path(bad, "k").is_err(), "{bad}");
        }
        // TLS admite espacios (no pasa por -o de ssh).
        let tls = ConnSpec::Tls {
            name: "t".into(),
            host: "h".into(),
            port: 2376,
            ca_path: "/c d/ca.pem".into(),
            cert_path: "/c d/cert.pem".into(),
            key_path: "/c d/key.pem".into(),
        };
        assert!(validate_spec(&tls).is_ok());
    }

    #[test]
    fn nombres_y_matices() {
        assert_eq!(validate_display_name("  Web  ").unwrap(), "Web");
        assert!(validate_display_name("").is_err());
        assert!(validate_display_name(&"x".repeat(41)).is_err());
        assert!(validate_display_name("a\u{202e}b").is_err());
        assert!(validate_display_name("a\u{7f}").is_err());
        assert_eq!(validate_hue(359).unwrap(), 359);
        assert!(validate_hue(360).is_err());
        assert!(validate_hue(-1).is_err());
    }

    #[test]
    fn uuid_v7_reconocido() {
        let v7 = uuid::Uuid::now_v7().to_string();
        assert!(is_uuid_v7(&v7));
        assert!(!is_uuid_v7("550e8400-e29b-41d4-a716-446655440000"));
        assert!(!is_uuid_v7("local"));
        assert!(!is_uuid_v7(&v7.to_uppercase()));
    }

    #[test]
    fn perfil_aplana_la_especificacion() {
        let p = ConnectionProfile {
            id: uuid::Uuid::now_v7().to_string(),
            spec: ssh("h", "u", 22),
            remote: true,
            host_key_fp: Some("SHA256:abc".into()),
            simulated: false,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["kind"], "ssh");
        assert_eq!(v["host"], "h");
        assert_eq!(v["remote"], true);
        assert_eq!(v["simulated"], false);
        let back: ConnectionProfile = serde_json::from_value(v).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn legacy_deserializa_forma_del_frontend() {
        let v = serde_json::json!({
            "v": 1,
            "groups": [{"id": "x", "name": "A", "hue": 10}],
            "assign": {"local\u{0}web": "x"},
            "stackHue": {"proj": 200}
        });
        let l: LegacyGroups = serde_json::from_value(v).unwrap();
        assert_eq!(l.stack_hue["proj"], 200);
        assert_eq!(l.assign["local\u{0}web"], "x");
    }
}
