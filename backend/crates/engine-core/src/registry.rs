//! Registros de imágenes: secreto redactado, credenciales para el pull y resolución del
//! servidor a partir de una referencia. Puro: sin E/S ni llavero (eso vive en el crate `store`).

use std::fmt;

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::error::EngineError;

/// Servidor por defecto de Docker Hub tal como lo espera la API (`serveraddress`).
pub const DOCKER_HUB_SERVER: &str = "https://index.docker.io/v1/";
/// Largo máximo aceptado para servidor, usuario y secreto.
pub const MAX_SERVER: usize = 253;
pub const MAX_USERNAME: usize = 256;
pub const MAX_SECRET: usize = 4096;

/// Cadena secreta: `Debug`/`Display` redactados y puesta a cero al soltarse. Solo se lee con
/// `expose`, en el punto exacto donde se entrega al daemon o al llavero.
#[derive(Default)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Único acceso al valor en claro.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Igualdad en tiempo constante respecto al contenido (sin cortocircuito por el primer byte
/// distinto).
impl PartialEq for Secret {
    fn eq(&self, other: &Self) -> bool {
        let (a, b) = (self.0.as_bytes(), other.0.as_bytes());
        let mut diff = a.len() ^ b.len();
        for i in 0..a.len().max(b.len()) {
            diff |= usize::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
        }
        diff == 0
    }
}

impl Eq for Secret {}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(***)")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Deserializa desde IPC (única dirección permitida: un secreto nunca se serializa).
impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d).map(Secret)
    }
}

/// Credenciales listas para un pull.
#[derive(Debug, PartialEq, Eq)]
pub struct RegistryAuth {
    /// Valor de `serveraddress` (p. ej. `https://index.docker.io/v1/` o `ghcr.io`).
    pub server: String,
    pub username: String,
    pub secret: Secret,
}

/// Fila visible de un registro guardado (jamás incluye el secreto).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistrySummary {
    pub id: String,
    pub server: String,
    pub username: String,
}

/// Servidor de registro al que apunta una referencia de imagen. Sin host explícito (o
/// `docker.io`/`index.docker.io`/`registry-1.docker.io`) es Docker Hub.
pub fn registry_server_for_reference(reference: &str) -> String {
    let name = reference.split('@').next().unwrap_or(reference);
    let first = name.split('/').next().unwrap_or("");
    let has_host =
        name.contains('/') && (first.contains('.') || first.contains(':') || first == "localhost");
    if !has_host {
        return DOCKER_HUB_SERVER.to_string();
    }
    match first {
        "docker.io" | "index.docker.io" | "registry-1.docker.io" => DOCKER_HUB_SERVER.to_string(),
        other => other.to_string(),
    }
}

/// Normaliza y valida el servidor que introduce el usuario: `host[:puerto]` sin esquema ni
/// ruta (o la URL de Docker Hub). Devuelve la forma canónica en minúsculas.
pub fn normalize_server(input: &str) -> Result<String, EngineError> {
    let t = input.trim();
    if t.is_empty() || t.len() > MAX_SERVER {
        return Err(EngineError::InvalidInput(
            "el servidor del registro está vacío o es demasiado largo".into(),
        ));
    }
    let bare = t
        .strip_prefix("https://")
        .or_else(|| t.strip_prefix("http://"))
        .unwrap_or(t)
        .trim_end_matches('/');
    let lower = bare.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "docker.io" | "index.docker.io" | "registry-1.docker.io" | "index.docker.io/v1"
    ) {
        return Ok(DOCKER_HUB_SERVER.to_string());
    }
    let ok = !lower.is_empty()
        && !lower.starts_with(['-', '.'])
        && lower
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
        && lower.matches(':').count() <= 1;
    if !ok {
        return Err(EngineError::InvalidInput(
            "servidor de registro inválido (usa host[:puerto], sin rutas)".into(),
        ));
    }
    if let Some((_, port)) = lower.split_once(':')
        && port.parse::<u16>().map_or(true, |p| p == 0)
    {
        return Err(EngineError::InvalidInput(
            "puerto del registro inválido".into(),
        ));
    }
    Ok(lower)
}

/// Valida el usuario: sin caracteres de control y de largo acotado.
pub fn validate_username(username: &str) -> Result<(), EngineError> {
    if username.is_empty()
        || username.len() > MAX_USERNAME
        || username.chars().any(|c| c.is_control())
    {
        return Err(EngineError::InvalidInput(
            "usuario del registro inválido".into(),
        ));
    }
    Ok(())
}

/// Valida el secreto sin revelarlo en el mensaje.
pub fn validate_secret(secret: &Secret) -> Result<(), EngineError> {
    let v = secret.expose();
    if v.is_empty() || v.len() > MAX_SECRET || v.chars().any(|c| c.is_control()) {
        return Err(EngineError::InvalidInput(
            "contraseña o token inválido (vacío, demasiado largo o con caracteres de control)"
                .into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_redactado_en_debug_y_display() {
        let s = Secret::new("hunter2");
        assert_eq!(format!("{s:?}"), "Secret(***)");
        assert_eq!(format!("{s}"), "***");
        let auth = RegistryAuth {
            server: "ghcr.io".into(),
            username: "u".into(),
            secret: s,
        };
        assert!(!format!("{auth:?}").contains("hunter2"));
    }

    #[test]
    fn igualdad_de_secretos_por_contenido() {
        assert_eq!(Secret::new("abc"), Secret::new("abc"));
        assert_ne!(Secret::new("abc"), Secret::new("abd"));
        assert_ne!(Secret::new("abc"), Secret::new("abcd"));
        assert_ne!(Secret::new(""), Secret::new("a"));
    }

    #[test]
    fn servidor_de_la_referencia() {
        let hub = DOCKER_HUB_SERVER;
        assert_eq!(registry_server_for_reference("nginx"), hub);
        assert_eq!(registry_server_for_reference("library/nginx:1"), hub);
        assert_eq!(registry_server_for_reference("user/app:latest"), hub);
        assert_eq!(registry_server_for_reference("docker.io/user/app"), hub);
        assert_eq!(
            registry_server_for_reference("ghcr.io/user/app:1"),
            "ghcr.io"
        );
        assert_eq!(
            registry_server_for_reference("localhost:54109/x:1"),
            "localhost:54109"
        );
        assert_eq!(registry_server_for_reference("localhost/x"), "localhost");
        assert_eq!(
            registry_server_for_reference("reg.io/a@sha256:abc"),
            "reg.io"
        );
    }

    #[test]
    fn normaliza_y_rechaza_servidores() {
        assert_eq!(normalize_server("GHCR.io").unwrap(), "ghcr.io");
        assert_eq!(normalize_server("https://ghcr.io/").unwrap(), "ghcr.io");
        assert_eq!(normalize_server("docker.io").unwrap(), DOCKER_HUB_SERVER);
        assert_eq!(
            normalize_server("reg.local:5000").unwrap(),
            "reg.local:5000"
        );
        for bad in [
            "",
            "a b",
            "-x",
            "a/b",
            "host:0",
            "host:99999",
            "h:1:2",
            "x?y",
        ] {
            assert!(normalize_server(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn valida_usuario_y_secreto() {
        assert!(validate_username("bob").is_ok());
        assert!(validate_username("").is_err());
        assert!(validate_username("a\nb").is_err());
        assert!(validate_secret(&Secret::new("tok")).is_ok());
        assert!(validate_secret(&Secret::new("")).is_err());
        let err = validate_secret(&Secret::new("bad\nsecret")).unwrap_err();
        assert!(!err.to_string().contains("bad"));
    }
}
