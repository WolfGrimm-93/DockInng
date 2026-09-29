//! Clasificación PURA del stderr de `ssh` (y del `docker` remoto) en causas de conexión.
//! Se prueba con fixtures de mensajes reales de OpenSSH.

use engine_core::ConnectionCause;

/// Fallo clasificado: causa para la UI y mensaje guiado (español).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub cause: ConnectionCause,
    pub message: String,
}

/// Última línea útil del stderr, sin caracteres de control (el remoto es no confiable) y
/// acotada.
pub fn sanitize_detail(stderr: &str) -> String {
    let line = stderr
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("");
    line.chars().filter(|c| !c.is_control()).take(200).collect()
}

/// Clasifica el stderr de un intento de conexión. `None` si no se reconoce ningún patrón.
pub fn classify_ssh_stderr(stderr: &str) -> Option<Failure> {
    let s = stderr;
    let has = |needle: &str| s.contains(needle);
    let detail = sanitize_detail(s);
    let f = |cause, msg: &str| {
        Some(Failure {
            cause,
            message: if detail.is_empty() {
                msg.to_string()
            } else {
                format!("{msg} ({detail})")
            },
        })
    };
    // La clave cambiada se comprueba ANTES que la desconocida: ambas terminan en
    // "Host key verification failed.".
    if has("REMOTE HOST IDENTIFICATION HAS CHANGED")
        || has("Offending")
        || has("Host key for") && has("has changed")
    {
        return f(
            ConnectionCause::HostKeyChanged,
            "la clave del servidor cambió: podría ser un ataque de intermediario. Verifícala con el administrador y elimina la entrada antigua del known_hosts de DockInng",
        );
    }
    if has("host key is known for") || has("Host key verification failed") {
        return f(
            ConnectionCause::HostKeyUnknown,
            "el servidor aún no es de confianza: confirma su huella antes de conectar",
        );
    }
    if has("UNPROTECTED PRIVATE KEY FILE") || has("Bad owner or permissions") {
        return f(
            ConnectionCause::AuthFailed,
            "la llave privada tiene permisos demasiado abiertos (usa chmod 600)",
        );
    }
    if has("Permission denied (")
        || has("Enter passphrase for key")
        || has("incorrect passphrase")
        || has("Load key") && has("incorrect passphrase")
    {
        return f(
            ConnectionCause::AuthFailed,
            "el servidor rechazó la autenticación (si la llave tiene passphrase, cárgala con ssh-add)",
        );
    }
    if has("Connection refused")
        || has("Connection timed out")
        || has("Operation timed out")
        || has("No route to host")
        || has("Network is unreachable")
        || has("Could not resolve hostname")
        || has("Connection closed by")
        || has("Connection reset by")
        || has("kex_exchange_identification")
    {
        return f(
            ConnectionCause::Unreachable,
            "no se pudo alcanzar el servidor",
        );
    }
    let lower = s.to_ascii_lowercase();
    if lower.contains("permission denied while trying to connect to the docker")
        || lower.contains("got permission denied while trying to connect")
    {
        return f(
            ConnectionCause::PermissionDenied,
            "el usuario remoto no tiene permiso sobre el socket de Docker (¿grupo docker?)",
        );
    }
    if lower.contains("cannot connect to the docker daemon")
        || lower.contains("is the docker daemon running")
    {
        return f(
            ConnectionCause::DaemonDown,
            "el daemon de Docker remoto no está en ejecución",
        );
    }
    if lower.contains("docker")
        && (lower.contains("command not found")
            || lower.contains(": not found")
            || lower.contains("no such file or directory")
            || lower.contains("unknown command"))
    {
        return f(
            ConnectionCause::RemoteDockerMissing,
            "Docker no está en el PATH del usuario remoto (se requiere la CLI 18.09 o superior)",
        );
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use ConnectionCause::*;

    fn cause(s: &str) -> Option<ConnectionCause> {
        classify_ssh_stderr(s).map(|f| f.cause)
    }

    #[test]
    fn clave_desconocida_con_modo_estricto() {
        let s = "No ED25519 host key is known for 127.0.0.1 and you have requested strict checking.\nHost key verification failed.\n";
        assert_eq!(cause(s), Some(HostKeyUnknown));
        assert_eq!(
            cause("Host key verification failed.\n"),
            Some(HostKeyUnknown)
        );
    }

    #[test]
    fn clave_cambiada_tiene_prioridad_sobre_desconocida() {
        let s = "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n\
                 @    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n\
                 Offending ED25519 key in /tmp/kh:1\nHost key verification failed.\n";
        assert_eq!(cause(s), Some(HostKeyChanged));
    }

    #[test]
    fn autenticacion() {
        assert_eq!(
            cause("deploy@example.com: Permission denied (publickey).\n"),
            Some(AuthFailed)
        );
        assert_eq!(
            cause("Permission denied (publickey,password).\n"),
            Some(AuthFailed)
        );
        assert_eq!(
            cause("@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @\nBad permissions"),
            Some(AuthFailed)
        );
        assert_eq!(
            cause("Enter passphrase for key '/home/u/.ssh/id_ed25519':\n"),
            Some(AuthFailed)
        );
        assert_eq!(
            cause(
                "Load key \"/home/u/.ssh/id_ed25519\": incorrect passphrase supplied to decrypt private key"
            ),
            Some(AuthFailed)
        );
    }

    #[test]
    fn inalcanzable() {
        for s in [
            "ssh: connect to host 127.0.0.1 port 1: Connection refused",
            "ssh: connect to host 10.255.255.1 port 22: Connection timed out",
            "ssh: connect to host h port 22: No route to host",
            "ssh: Could not resolve hostname nope.invalid: Name or service not known",
            "Connection closed by 10.0.0.1 port 22",
            "kex_exchange_identification: read: Connection reset by peer",
        ] {
            assert_eq!(cause(s), Some(Unreachable), "{s}");
        }
    }

    #[test]
    fn docker_remoto() {
        for s in [
            "bash: docker: command not found\n",
            "sh: 1: docker: not found\n",
            "fish: Unknown command: docker\n",
            "zsh:1: command not found: docker",
        ] {
            let c = cause(s);
            // fish usa "Unknown command"; el resto "not found".
            assert_eq!(c, Some(RemoteDockerMissing), "{s}");
        }
        assert_eq!(
            cause(
                "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock"
            ),
            Some(PermissionDenied)
        );
        assert_eq!(
            cause(
                "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"
            ),
            Some(DaemonDown)
        );
    }

    #[test]
    fn sin_patron_conocido_es_none_y_el_detalle_se_sanea() {
        assert_eq!(cause("todo bien"), None);
        assert_eq!(cause(""), None);
        let f = classify_ssh_stderr("\u{1b}[31mPermission denied (publickey).\u{7}\n").unwrap();
        assert!(!f.message.contains('\u{1b}') && !f.message.contains('\u{7}'));
        assert!(f.message.chars().count() < 400);
    }
}
