//! Lectura y armado de la cookie de sesión. Sin librería de cookies: el formato es fijo y
//! simple (un solo valor, `HttpOnly`, sin atributos que el navegador necesite negociar).

use axum::http::HeaderMap;
use axum::http::header::COOKIE;

pub const COOKIE_NAME: &str = "dockinng_session";

/// El valor de la cookie `dockinng_session`, si vino en el pedido.
pub fn read_session_cookie(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(COOKIE)?.to_str().ok()?;
    raw.split(';').find_map(|pair| {
        let (k, v) = pair.trim().split_once('=')?;
        (k == COOKIE_NAME).then(|| v.to_string())
    })
}

/// Cabecera `Set-Cookie` para fijar la sesión. `insecure` solo debe ser `true` en desarrollo
/// local por HTTP sin TLS (`DOCKINNG_SERVER_INSECURE_COOKIES=1`); en producción el atributo
/// `Secure` es obligatorio.
pub fn set_cookie_header(token: &str, insecure: bool, max_age_secs: u64) -> String {
    let secure = if insecure { "" } else { "; Secure" };
    format!("{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict{secure}; Max-Age={max_age_secs}")
}

/// Cabecera `Set-Cookie` que borra la sesión del navegador (logout).
pub fn clear_cookie_header(insecure: bool) -> String {
    let secure = if insecure { "" } else { "; Secure" };
    format!("{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict{secure}; Max-Age=0")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers_with(raw: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(COOKIE, HeaderValue::from_str(raw).unwrap());
        h
    }

    #[test]
    fn lee_la_cookie_entre_otras() {
        let h = headers_with("otra=1; dockinng_session=abc123; tercera=xyz");
        assert_eq!(read_session_cookie(&h), Some("abc123".to_string()));
    }

    #[test]
    fn sin_cabecera_cookie_da_none() {
        assert_eq!(read_session_cookie(&HeaderMap::new()), None);
    }

    #[test]
    fn cookie_ausente_entre_otras_da_none() {
        let h = headers_with("otra=1; tercera=xyz");
        assert_eq!(read_session_cookie(&h), None);
    }

    #[test]
    fn set_cookie_lleva_secure_salvo_en_modo_inseguro() {
        assert!(set_cookie_header("tok", false, 60).contains("; Secure"));
        assert!(!set_cookie_header("tok", true, 60).contains("; Secure"));
        assert!(set_cookie_header("tok", false, 60).contains("HttpOnly"));
    }

    #[test]
    fn set_cookie_caduca_en_el_navegador_con_la_vida_maxima_de_la_sesion() {
        assert!(set_cookie_header("tok", false, 43200).ends_with("; Max-Age=43200"));
    }

    #[test]
    fn clear_cookie_vacia_el_valor_y_expira() {
        let c = clear_cookie_header(false);
        assert!(c.starts_with(&format!("{COOKIE_NAME}=;")));
        assert!(c.contains("Max-Age=0"));
    }
}
