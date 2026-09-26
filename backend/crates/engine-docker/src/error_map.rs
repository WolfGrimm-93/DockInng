//! Clasificación de errores de bollard a `EngineError`, por variante y por errno real.

use std::error::Error as StdError;
use std::io;

use bollard::errors::Error as BollardError;
use engine_core::{ConnectionCause, EngineError};

/// Clasifica un `io::Error` de conexión por su errno / kind.
pub fn cause_from_io(e: &io::Error) -> ConnectionCause {
    use io::ErrorKind::*;
    match e.raw_os_error() {
        Some(2) => return ConnectionCause::SocketMissing,
        Some(13) | Some(1) => return ConnectionCause::PermissionDenied,
        Some(111) => return ConnectionCause::DaemonDown,
        _ => {}
    }
    match e.kind() {
        NotFound => ConnectionCause::SocketMissing,
        PermissionDenied => ConnectionCause::PermissionDenied,
        ConnectionRefused | BrokenPipe | ConnectionReset | ConnectionAborted | UnexpectedEof
        | NotConnected => ConnectionCause::DaemonDown,
        _ => ConnectionCause::Other,
    }
}

/// Busca un `io::Error` recorriendo la cadena `source()`.
fn find_io<'a>(e: &'a (dyn StdError + 'static)) -> Option<&'a io::Error> {
    let mut cur: Option<&'a (dyn StdError + 'static)> = Some(e);
    while let Some(err) = cur {
        if let Some(io) = err.downcast_ref::<io::Error>() {
            return Some(io);
        }
        cur = err.source();
    }
    None
}

/// Texto completo de un error y de toda su cadena `source()`.
fn chain_text(e: &(dyn StdError + 'static)) -> String {
    let mut out = e.to_string();
    let mut cur = e.source();
    while let Some(err) = cur {
        out.push_str(": ");
        out.push_str(&err.to_string());
        cur = err.source();
    }
    out
}

/// ¿El texto describe un fallo de TLS/certificados? (Se detecta por texto porque rustls
/// llega envuelto en `io::Error` con `kind` genérico.)
pub fn is_tls_error_text(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    [
        "certificate",
        "handshake",
        "unknownissuer",
        "received fatal alert",
        "close_notify",
        "tls ",
        "rustls",
    ]
    .iter()
    .any(|n| t.contains(n))
}

/// Error de transporte (sin respuesta HTTP del daemon).
fn transport(e: &BollardError) -> EngineError {
    // Un fallo de TLS tiene causa propia (con mensaje guiado) aunque el errno sea genérico.
    let text = chain_text(e);
    if is_tls_error_text(&text) {
        let detail: String = text.chars().filter(|c| !c.is_control()).take(160).collect();
        return EngineError::Connection {
            cause: ConnectionCause::TlsInvalid,
            message: format!(
                "falló la conexión TLS: revisa la CA, el certificado de cliente y que el nombre del servidor esté en su certificado ({detail})"
            ),
        };
    }
    let (cause, detail) = match e {
        BollardError::IOError { err } => (cause_from_io(err), err.to_string()),
        other => match find_io(other) {
            Some(io) => (cause_from_io(io), io.to_string()),
            None => (ConnectionCause::Other, other.to_string()),
        },
    };
    EngineError::Connection {
        cause,
        message: detail,
    }
}

pub fn classify(e: &BollardError) -> EngineError {
    use BollardError::*;
    match e {
        SocketNotFoundError(path) => EngineError::Connection {
            cause: ConnectionCause::SocketMissing,
            message: format!("no existe el socket {path}"),
        },
        DockerResponseServerError {
            status_code,
            message,
        } => from_status(*status_code, message),
        RequestTimeoutError => EngineError::Timeout,
        JsonDataError { .. } | JsonSerdeError { .. } | StrParseError { .. } => {
            EngineError::Protocol(e.to_string())
        }
        IOError { .. } | HyperResponseError { .. } => transport(e),
        // HyperLegacyError (feature `http`) y otros errores de transporte se detectan
        // por la cadena `source()`, sin nombrar la variante.
        other => {
            if find_io(other).is_some() || is_legacy_transport(other) {
                transport(other)
            } else {
                EngineError::Internal(other.to_string())
            }
        }
    }
}

fn is_legacy_transport(e: &BollardError) -> bool {
    // La variante con el cliente hyper describe "hyper legacy client" en su texto.
    matches!(e, BollardError::HyperLegacyError { .. })
}

pub fn from_status(status: u16, message: &str) -> EngineError {
    match status {
        404 => EngineError::NotFound(message.to_string()),
        409 => EngineError::Conflict(message.to_string()),
        400 => EngineError::InvalidInput(message.to_string()),
        s => EngineError::Engine {
            status: s,
            message: message.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detecta_texto_de_tls() {
        assert!(is_tls_error_text("invalid peer certificate: UnknownIssuer"));
        assert!(is_tls_error_text("received fatal alert: BadCertificate"));
        assert!(is_tls_error_text(
            "peer closed connection without sending TLS close_notify"
        ));
        assert!(!is_tls_error_text("Connection refused (os error 111)"));
        assert!(!is_tls_error_text("No such file or directory"));
    }

    #[test]
    fn http_a_dominio() {
        assert!(matches!(from_status(404, "x"), EngineError::NotFound(_)));
        assert!(matches!(from_status(409, "x"), EngineError::Conflict(_)));
        assert!(matches!(
            from_status(400, "x"),
            EngineError::InvalidInput(_)
        ));
        assert!(matches!(
            from_status(500, "x"),
            EngineError::Engine { status: 500, .. }
        ));
        assert!(matches!(
            from_status(403, "x"),
            EngineError::Engine { status: 403, .. }
        ));
    }

    fn cause(kind: io::Error) -> ConnectionCause {
        match classify(&BollardError::IOError { err: kind }) {
            EngineError::Connection { cause, .. } => cause,
            other => panic!("no es Connection: {other:?}"),
        }
    }

    #[test]
    fn errno_reales_a_causa() {
        assert_eq!(
            cause(io::Error::from_raw_os_error(2)),
            ConnectionCause::SocketMissing
        );
        assert_eq!(
            cause(io::Error::from_raw_os_error(13)),
            ConnectionCause::PermissionDenied
        );
        assert_eq!(
            cause(io::Error::from_raw_os_error(111)),
            ConnectionCause::DaemonDown
        );
        assert_eq!(
            cause(io::Error::from(io::ErrorKind::BrokenPipe)),
            ConnectionCause::DaemonDown
        );
        assert_eq!(
            cause(io::Error::from_raw_os_error(28)),
            ConnectionCause::Other
        );
    }

    #[test]
    fn otros_errores_no_se_disfrazan_de_conexion() {
        assert_eq!(
            classify(&BollardError::RequestTimeoutError),
            EngineError::Timeout
        );
        let json_err = serde_json::from_str::<u8>("x").unwrap_err();
        assert!(matches!(
            classify(&BollardError::JsonSerdeError { err: json_err }),
            EngineError::Protocol(_)
        ));
        assert!(matches!(
            classify(&BollardError::SocketNotFoundError("/x".into())),
            EngineError::Connection {
                cause: ConnectionCause::SocketMissing,
                ..
            }
        ));
        assert!(matches!(
            classify(&BollardError::APIVersionParseError {}),
            EngineError::Internal(_)
        ));
    }
}
