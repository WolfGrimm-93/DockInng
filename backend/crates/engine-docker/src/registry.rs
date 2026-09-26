//! Comprobación de credenciales de un registro con `POST /auth` del daemon.
//!
//! bollard no envuelve ese endpoint, así que se hace una petición HTTP/1.1 mínima sobre el
//! socket Unix del motor (local o túnel SSH). Solo se lanza por gesto explícito del usuario.
//! Las credenciales van en el cuerpo de la petición y nunca en mensajes de error.

use std::time::Duration;

use engine_core::{ApiErrorCode, EngineError, RegistryAuth};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use crate::{DockerEngine, Endpoint};

/// Tope de la respuesta leída.
const MAX_RESPONSE: usize = 64 * 1024;
/// Tiempo máximo de toda la comprobación (el daemon contacta al registro).
const TIMEOUT: Duration = Duration::from_secs(30);

/// Cuerpo JSON de la petición `/auth`.
fn request_body(auth: &RegistryAuth) -> String {
    serde_json::json!({
        "username": auth.username,
        "password": auth.secret.expose(),
        "serveraddress": auth.server,
    })
    .to_string()
}

/// Interpreta la respuesta HTTP cruda: `Ok` con estado 200/204, si no un error clasificado
/// con el mensaje del daemon (sin credenciales).
pub(crate) fn parse_response(raw: &[u8]) -> Result<(), EngineError> {
    let text = String::from_utf8_lossy(raw);
    let status: u16 = text
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .ok_or_else(|| EngineError::Protocol("respuesta HTTP inválida del daemon".into()))?;
    if (200..300).contains(&status) {
        return Ok(());
    }
    // El daemon responde `{"message":"..."}`; se extrae sin depender del framing HTTP.
    let message = text
        .find('{')
        .zip(text.rfind('}'))
        .and_then(|(a, b)| serde_json::from_str::<serde_json::Value>(&text[a..=b]).ok())
        .and_then(|v| v["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("el registro respondió con el estado {status}"));
    let lower = message.to_ascii_lowercase();
    if status == 401
        || lower.contains("unauthorized")
        || lower.contains("incorrect username or password")
        || lower.contains("denied")
    {
        return Err(EngineError::coded(
            ApiErrorCode::AuthRequired,
            "el registro rechazó las credenciales",
        ));
    }
    if lower.contains("no such host")
        || lower.contains("connection refused")
        || lower.contains("timeout")
        || lower.contains("dial tcp")
    {
        return Err(EngineError::coded(
            ApiErrorCode::RegistryUnreachable,
            "no se pudo alcanzar el registro",
        ));
    }
    Err(EngineError::Engine { status, message })
}

/// Ejecuta `POST /auth` en el daemon actual.
pub(crate) async fn check_auth(
    engine: &DockerEngine,
    auth: &RegistryAuth,
) -> Result<(), EngineError> {
    let socket = match engine.endpoint() {
        Endpoint::Unix(p) | Endpoint::Tunnel { socket: p, .. } => p,
        _ => {
            return Err(EngineError::InvalidInput(
                "probar registros solo está disponible con socket local o túnel SSH".into(),
            ));
        }
    };
    let body = request_body(auth);
    let head = format!(
        "POST /auth HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let work = async {
        let mut s = UnixStream::connect(&socket)
            .await
            .map_err(|e| EngineError::Connection {
                cause: crate::error_map::cause_from_io(&e),
                message: e.to_string(),
            })?;
        s.write_all(head.as_bytes())
            .await
            .map_err(|e| EngineError::Internal(e.to_string()))?;
        s.write_all(body.as_bytes())
            .await
            .map_err(|e| EngineError::Internal(e.to_string()))?;
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = s
                .read(&mut chunk)
                .await
                .map_err(|e| EngineError::Internal(e.to_string()))?;
            if n == 0 || buf.len() >= MAX_RESPONSE {
                break;
            }
            buf.extend_from_slice(&chunk[..n.min(MAX_RESPONSE - buf.len())]);
        }
        Ok::<_, EngineError>(buf)
    };
    let raw = tokio::time::timeout(TIMEOUT, work)
        .await
        .map_err(|_| EngineError::Timeout)??;
    parse_response(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::Secret;

    #[test]
    fn respuestas_del_daemon() {
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").is_ok());
        assert!(parse_response(b"HTTP/1.1 204 No Content\r\n\r\n").is_ok());
        let e = parse_response(
            b"HTTP/1.1 401 Unauthorized\r\n\r\n{\"message\":\"Get https://x/v2/: unauthorized: incorrect username or password\"}",
        )
        .unwrap_err();
        assert!(matches!(
            e,
            EngineError::Coded {
                code: ApiErrorCode::AuthRequired,
                ..
            }
        ));
        let e = parse_response(
            b"HTTP/1.1 500 Internal Server Error\r\n\r\n{\"message\":\"Get https://nohost/v2/: dial tcp: lookup nohost: no such host\"}",
        )
        .unwrap_err();
        assert!(matches!(
            e,
            EngineError::Coded {
                code: ApiErrorCode::RegistryUnreachable,
                ..
            }
        ));
        assert!(parse_response(b"basura").is_err());
    }

    #[test]
    fn el_cuerpo_lleva_credenciales_pero_los_errores_no() {
        let a = RegistryAuth {
            server: "ghcr.io".into(),
            username: "bob".into(),
            secret: Secret::new("s3cr3t"),
        };
        assert!(request_body(&a).contains("s3cr3t"));
        let e = parse_response(b"HTTP/1.1 500 x\r\n\r\n{\"message\":\"fallo\"}").unwrap_err();
        assert!(!e.to_string().contains("s3cr3t"));
    }
}
