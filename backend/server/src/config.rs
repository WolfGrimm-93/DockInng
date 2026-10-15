//! Configuración del servidor, leída del entorno al arrancar.

use std::net::SocketAddr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    /// Sin login: todo pedido entra como un administrador sintético («local»). Mismo supuesto
    /// de confianza que hoy usan la app de escritorio y la CLI (red/host ya confiable) —
    /// pensado para una LAN propia o un túnel, no para exponerse a Internet.
    Single,
    /// Requiere sesión; habilita `/api/auth/*` y la gestión de usuarios.
    Multi,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub auth_mode: AuthMode,
    /// Usuario y contraseña (en claro, solo al arrancar) del administrador inicial, si no hay
    /// ninguno todavía. `None` = no crear ninguno (el servidor arranca pero nadie puede entrar
    /// hasta que se cree a mano).
    pub bootstrap_admin: Option<(String, String)>,
    /// Cookies sin `Secure` (solo desarrollo local por HTTP, nunca en producción).
    pub insecure_cookies: bool,
}

/// `DOCKINNG_AUTH_MODE`: sin default silencioso. Si no se exige `single` a propósito, el
/// servidor pide autenticación (seguro por defecto).
pub fn parse_auth_mode(raw: Option<&str>) -> Result<AuthMode, String> {
    match raw {
        None => Ok(AuthMode::Multi),
        Some("single") => Ok(AuthMode::Single),
        Some("multi") => Ok(AuthMode::Multi),
        Some(other) => Err(format!(
            "DOCKINNG_AUTH_MODE inválido: «{other}» (usar «single» o «multi»)"
        )),
    }
}

pub fn parse_bind(raw: Option<&str>) -> Result<SocketAddr, String> {
    raw.unwrap_or("127.0.0.1:8080")
        .parse()
        .map_err(|e| format!("DOCKINNG_SERVER_BIND inválido: {e}"))
}

pub fn parse_bootstrap_admin(user: Option<String>, pass: Option<String>) -> Option<(String, String)> {
    match (user, pass) {
        (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => Some((u, p)),
        _ => None,
    }
}

pub fn parse_insecure_cookies(raw: Option<&str>) -> bool {
    raw == Some("1")
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Ok(Self {
            bind: parse_bind(std::env::var("DOCKINNG_SERVER_BIND").ok().as_deref())?,
            auth_mode: parse_auth_mode(std::env::var("DOCKINNG_AUTH_MODE").ok().as_deref())?,
            bootstrap_admin: parse_bootstrap_admin(
                std::env::var("DOCKINNG_BOOTSTRAP_ADMIN_USER").ok(),
                std::env::var("DOCKINNG_BOOTSTRAP_ADMIN_PASSWORD").ok(),
            ),
            insecure_cookies: parse_insecure_cookies(
                std::env::var("DOCKINNG_SERVER_INSECURE_COOKIES").ok().as_deref(),
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modo_sin_variable_es_multi_seguro_por_defecto() {
        assert_eq!(parse_auth_mode(None).unwrap(), AuthMode::Multi);
    }

    #[test]
    fn modo_single_y_multi_explicitos() {
        assert_eq!(parse_auth_mode(Some("single")).unwrap(), AuthMode::Single);
        assert_eq!(parse_auth_mode(Some("multi")).unwrap(), AuthMode::Multi);
    }

    #[test]
    fn modo_invalido_es_error() {
        assert!(parse_auth_mode(Some("")).is_err());
        assert!(parse_auth_mode(Some("SINGLE")).is_err());
        assert!(parse_auth_mode(Some("admin")).is_err());
    }

    #[test]
    fn bind_por_defecto_y_explicito() {
        assert_eq!(
            parse_bind(None).unwrap(),
            "127.0.0.1:8080".parse().unwrap()
        );
        assert_eq!(
            parse_bind(Some("0.0.0.0:9000")).unwrap(),
            "0.0.0.0:9000".parse().unwrap()
        );
        assert!(parse_bind(Some("no-es-una-direccion")).is_err());
    }

    #[test]
    fn bootstrap_admin_requiere_ambas_variables_no_vacias() {
        assert_eq!(parse_bootstrap_admin(None, None), None);
        assert_eq!(
            parse_bootstrap_admin(Some("ana".into()), None),
            None
        );
        assert_eq!(
            parse_bootstrap_admin(Some("".into()), Some("x".into())),
            None
        );
        assert_eq!(
            parse_bootstrap_admin(Some("ana".into()), Some("x".into())),
            Some(("ana".into(), "x".into()))
        );
    }

    #[test]
    fn insecure_cookies_solo_con_1_exacto() {
        assert!(!parse_insecure_cookies(None));
        assert!(!parse_insecure_cookies(Some("true")));
        assert!(parse_insecure_cookies(Some("1")));
    }
}
