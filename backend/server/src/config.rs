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
    /// Permite `single` (sin login) escuchando fuera de loopback. Por defecto se rechaza: cualquiera
    /// en la red entraría como administrador.
    pub allow_exposed_single: bool,
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

pub fn parse_flag(raw: Option<&str>) -> bool {
    raw == Some("1")
}

pub fn parse_insecure_cookies(raw: Option<&str>) -> bool {
    parse_flag(raw)
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
            allow_exposed_single: parse_flag(
                std::env::var("DOCKINNG_SINGLE_ALLOW_EXPOSED").ok().as_deref(),
            ),
            insecure_cookies: parse_insecure_cookies(
                std::env::var("DOCKINNG_SERVER_INSECURE_COOKIES").ok().as_deref(),
            ),
        })
    }

    /// Rechaza combinaciones inseguras. `single` no autentica a nadie: solo es aceptable en
    /// loopback (o con `DOCKINNG_SINGLE_ALLOW_EXPOSED=1`, asumiendo que algo delante autentica).
    pub fn validate(&self) -> Result<(), String> {
        if self.auth_mode == AuthMode::Single
            && !self.bind.ip().is_loopback()
            && !self.allow_exposed_single
        {
            return Err(format!(
                "DOCKINNG_AUTH_MODE=single no autentica a nadie y escucha en {}, que no es \
                 loopback: cualquiera en la red entraría como administrador. Usa 127.0.0.1, el \
                 modo multi, o fija DOCKINNG_SINGLE_ALLOW_EXPOSED=1 si un proxy o túnel \
                 autentica delante",
                self.bind
            ));
        }
        Ok(())
    }

    /// Avisos de arranque para configuraciones permitidas pero delicadas.
    pub fn warnings(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.auth_mode == AuthMode::Single && !self.bind.ip().is_loopback() {
            out.push(format!(
                "modo single expuesto en {}: no hay login; confía en lo que autentique delante",
                self.bind
            ));
        }
        if self.insecure_cookies && !self.bind.ip().is_loopback() {
            out.push(
                "DOCKINNG_SERVER_INSECURE_COOKIES=1 fuera de loopback: la cookie de sesión viaja sin TLS"
                    .into(),
            );
        }
        out
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

    fn cfg(mode: AuthMode, bind: &str, allow: bool, insecure: bool) -> Config {
        Config {
            bind: bind.parse().unwrap(),
            auth_mode: mode,
            bootstrap_admin: None,
            allow_exposed_single: allow,
            insecure_cookies: insecure,
        }
    }

    #[test]
    fn single_solo_se_acepta_en_loopback() {
        assert!(cfg(AuthMode::Single, "127.0.0.1:8080", false, false).validate().is_ok());
        assert!(cfg(AuthMode::Single, "[::1]:8080", false, false).validate().is_ok());
    }

    #[test]
    fn single_fuera_de_loopback_se_rechaza_salvo_override_explicito() {
        for bind in ["0.0.0.0:8080", "192.168.1.5:8080", "[::]:8080"] {
            let e = cfg(AuthMode::Single, bind, false, false).validate().unwrap_err();
            assert!(e.contains("DOCKINNG_SINGLE_ALLOW_EXPOSED"), "{bind}: {e}");
            assert!(cfg(AuthMode::Single, bind, true, false).validate().is_ok(), "{bind}");
        }
    }

    #[test]
    fn multi_puede_escuchar_en_cualquier_interfaz() {
        assert!(cfg(AuthMode::Multi, "0.0.0.0:8080", false, false).validate().is_ok());
    }

    #[test]
    fn avisa_de_single_expuesto_y_de_cookies_sin_tls_fuera_de_loopback() {
        assert!(cfg(AuthMode::Single, "127.0.0.1:1", false, true).warnings().is_empty());
        let w = cfg(AuthMode::Single, "0.0.0.0:1", true, true).warnings();
        assert_eq!(w.len(), 2);
        assert!(cfg(AuthMode::Multi, "127.0.0.1:1", false, true).warnings().is_empty());
        assert!(cfg(AuthMode::Multi, "10.0.0.1:1", false, false).warnings().is_empty());
    }
}
