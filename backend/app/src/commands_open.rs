//! Abrir un puerto publicado en el navegador (Ola 3).
//!
//!   open_port_in_browser{id, port, scheme} -> ()   scheme: "http" | "https"
//!
//! La webview solo aporta `{id, port, scheme}`: el BACKEND construye la URL a partir de los
//! puertos que ese contenedor tiene realmente publicados, así que el renderizador nunca puede
//! elegir host, ruta, esquema ni un puerto ajeno. Solo motor local; el navegador se abre con
//! `xdg-open` (argumentos separados, sin shell, entorno reducido) y la webview nunca navega.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use engine_core::{ApiError, ApiErrorCode, ContainerState, EngineClient, PortMapping};
use tauri::State;

use crate::state::AppState;

type ApiResult<T> = Result<T, ApiError>;

/// Variables de entorno que `xdg-open` necesita para localizar la sesión y el navegador
/// (el resto se descarta: p. ej. `LD_LIBRARY_PATH` de un AppImage no debe llegar al navegador).
const OPEN_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "XAUTHORITY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_DESKTOP",
    "XDG_DATA_DIRS",
    "XDG_DATA_HOME",
    "XDG_CONFIG_DIRS",
    "XDG_CONFIG_HOME",
    "DBUS_SESSION_BUS_ADDRESS",
    "DESKTOP_SESSION",
    "KDE_FULL_SESSION",
    "KDE_SESSION_VERSION",
    "BROWSER",
];

/// Tiempo máximo que se espera a `xdg-open` antes de matarlo (evita procesos colgados).
const OPEN_TIMEOUT: Duration = Duration::from_secs(30);

fn invalid(msg: &str) -> ApiError {
    ApiError::new(ApiErrorCode::InvalidInput, msg)
}

/// Host de destino a partir del enlace (`bind`) del puerto: comodines y loopback abren
/// `127.0.0.1`; una IP concreta solo si es loopback o privada; nunca un nombre DNS.
fn host_for_binding(ip: Option<&str>) -> ApiResult<String> {
    let Some(raw) = ip.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok("127.0.0.1".into());
    };
    let addr: IpAddr = raw
        .parse()
        .map_err(|_| invalid("el puerto está enlazado a una dirección no válida"))?;
    match addr {
        IpAddr::V4(a) if a.is_unspecified() || a == Ipv4Addr::LOCALHOST => Ok("127.0.0.1".into()),
        IpAddr::V4(a) if a.is_loopback() || a.is_private() => Ok(a.to_string()),
        IpAddr::V6(a) if a.is_unspecified() => Ok("127.0.0.1".into()),
        IpAddr::V6(a) if a.is_loopback() => Ok(format!("[{a}]")),
        // ULA (fc00::/7). El enlace local (fe80::/10) exige un identificador de zona: no sirve.
        IpAddr::V6(a) if is_unique_local(&a) => Ok(format!("[{a}]")),
        _ => Err(invalid(
            "el puerto está enlazado a una dirección que no es local ni privada",
        )),
    }
}

fn is_unique_local(a: &Ipv6Addr) -> bool {
    (a.segments()[0] & 0xfe00) == 0xfc00
}

/// URL a abrir para un puerto publicado (función pura; toda la política vive aquí).
/// - `scheme`: solo `http`/`https`.
/// - `remote`: solo motor local (en remoto el puerto no está en este equipo).
/// - `running`: el contenedor debe estar en marcha.
/// - `port`: debe ser un puerto TCP realmente publicado por ese contenedor.
pub fn resolve_open_url(
    ports: &[PortMapping],
    remote: bool,
    running: bool,
    port: u16,
    scheme: &str,
) -> ApiResult<String> {
    if scheme != "http" && scheme != "https" {
        return Err(invalid("esquema no permitido (solo http o https)"));
    }
    if remote {
        return Err(invalid("Solo se puede abrir en el equipo local"));
    }
    if !running {
        return Err(invalid("el contenedor no está en marcha"));
    }
    let mut candidates = ports
        .iter()
        .filter(|p| p.public_port == Some(port) && p.protocol.eq_ignore_ascii_case("tcp"))
        .peekable();
    if candidates.peek().is_none() {
        return Err(invalid(
            "ese puerto TCP no está publicado por el contenedor",
        ));
    }
    // Un puerto puede estar publicado en IPv4 e IPv6: sirve el primero con host válido.
    let mut first_err = None;
    for p in candidates {
        match host_for_binding(p.ip.as_deref()) {
            Ok(host) => return Ok(format!("{scheme}://{host}:{port}/")),
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
    }
    Err(first_err.unwrap_or_else(|| invalid("puerto no publicado")))
}

/// Destino de la URL ya validada.
pub trait UrlOpener: Send + Sync {
    fn open(&self, url: &str) -> ApiResult<()>;
}

/// Abre con `xdg-open`: un solo argumento (la URL), sin shell, stdio nulo y entorno reducido.
pub struct XdgOpen;

impl UrlOpener for XdgOpen {
    fn open(&self, url: &str) -> ApiResult<()> {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(url)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for key in OPEN_ENV {
            if let Some(v) = std::env::var_os(key) {
                cmd.env(key, v);
            }
        }
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ApiError::new(ApiErrorCode::Internal, "xdg-open no está instalado")
            } else {
                ApiError::new(ApiErrorCode::Internal, "no se pudo lanzar xdg-open")
            }
        })?;
        // Recoge el proceso (sin zombis) y lo mata si se cuelga.
        std::thread::spawn(move || {
            let started = Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(_)) | Err(_) => return,
                    Ok(None) if started.elapsed() >= OPEN_TIMEOUT => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return;
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(250)),
                }
            }
        });
        Ok(())
    }
}

/// Núcleo del comando: localiza el contenedor, valida y abre. Devuelve la URL abierta.
pub async fn open_port_inner(
    engine: &dyn EngineClient,
    opener: &dyn UrlOpener,
    id: &str,
    port: u32,
    scheme: &str,
) -> ApiResult<String> {
    let port = u16::try_from(port)
        .ok()
        .filter(|p| *p != 0)
        .ok_or_else(|| invalid("puerto fuera de rango"))?;
    let remote = engine.is_remote();
    // Se rechaza antes de consultar el motor lo que no depende de él.
    if scheme != "http" && scheme != "https" {
        return Err(invalid("esquema no permitido (solo http o https)"));
    }
    if remote {
        return Err(invalid("Solo se puede abrir en el equipo local"));
    }
    let containers = engine.list_containers(true).await?;
    // Id exacto o nombre exacto: nunca prefijos.
    let container = containers
        .iter()
        .find(|c| c.id == id || c.names.iter().any(|n| n == id))
        .ok_or_else(|| ApiError::new(ApiErrorCode::NotFound, "contenedor no encontrado"))?;
    let url = resolve_open_url(
        &container.ports,
        remote,
        container.state == ContainerState::Running,
        port,
        scheme,
    )?;
    opener.open(&url)?;
    Ok(url)
}

#[tauri::command]
pub async fn open_port_in_browser(
    state: State<'_, AppState>,
    id: String,
    port: u32,
    scheme: String,
) -> ApiResult<()> {
    open_port_inner(state.engine.as_ref(), &XdgOpen, &id, port, &scheme).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use engine_core::testing::MockEngine;

    use super::*;

    fn pm(ip: Option<&str>, public: Option<u16>, private: u16, proto: &str) -> PortMapping {
        PortMapping {
            ip: ip.map(String::from),
            private_port: private,
            public_port: public,
            protocol: proto.into(),
        }
    }

    fn url(ports: &[PortMapping], port: u16) -> ApiResult<String> {
        resolve_open_url(ports, false, true, port, "http")
    }

    #[test]
    fn comodines_y_loopback_abren_127_0_0_1() {
        for ip in [
            None,
            Some(""),
            Some("0.0.0.0"),
            Some("::"),
            Some("127.0.0.1"),
        ] {
            assert_eq!(
                url(&[pm(ip, Some(8080), 80, "tcp")], 8080).unwrap(),
                "http://127.0.0.1:8080/",
                "{ip:?}"
            );
        }
        assert_eq!(
            url(&[pm(Some("::1"), Some(8080), 80, "tcp")], 8080).unwrap(),
            "http://[::1]:8080/"
        );
        assert_eq!(
            url(&[pm(Some("127.0.0.2"), Some(9), 9, "tcp")], 9).unwrap(),
            "http://127.0.0.2:9/"
        );
    }

    #[test]
    fn ip_privada_se_acepta_y_publica_o_dns_se_rechaza() {
        for ip in ["10.1.2.3", "172.16.0.5", "192.168.1.20", "fd12:3456::1"] {
            let u = url(&[pm(Some(ip), Some(80), 80, "tcp")], 80).unwrap();
            assert!(u.starts_with("http://"), "{ip}");
            assert!(u.ends_with(":80/"), "{ip}");
        }
        assert_eq!(
            url(&[pm(Some("fd12:3456::1"), Some(80), 80, "tcp")], 80).unwrap(),
            "http://[fd12:3456::1]:80/"
        );
        for ip in [
            "8.8.8.8",
            "172.32.0.1",
            "2001:4860:4860::8888",
            "fe80::1",
            "example.com",
            "localhost",
            "127.0.0.1@evil.com",
            "1.2.3.4/x",
        ] {
            let e = url(&[pm(Some(ip), Some(80), 80, "tcp")], 80).unwrap_err();
            assert_eq!(e.code, ApiErrorCode::InvalidInput, "{ip}");
        }
    }

    #[test]
    fn esquema_solo_http_o_https() {
        let p = [pm(None, Some(443), 443, "tcp")];
        assert_eq!(
            resolve_open_url(&p, false, true, 443, "https").unwrap(),
            "https://127.0.0.1:443/"
        );
        for bad in ["file", "javascript", "ftp", "HTTP", "http://", "", "http:"] {
            let e = resolve_open_url(&p, false, true, 443, bad).unwrap_err();
            assert_eq!(e.code, ApiErrorCode::InvalidInput, "{bad}");
        }
    }

    #[test]
    fn remoto_y_contenedor_detenido_se_rechazan() {
        let p = [pm(None, Some(80), 80, "tcp")];
        let e = resolve_open_url(&p, true, true, 80, "http").unwrap_err();
        assert!(e.message.contains("local"));
        let e = resolve_open_url(&p, false, false, 80, "http").unwrap_err();
        assert_eq!(e.code, ApiErrorCode::InvalidInput);
    }

    #[test]
    fn solo_puertos_tcp_realmente_publicados() {
        let ports = [
            pm(None, Some(8080), 80, "tcp"),
            pm(None, Some(5353), 53, "udp"),
            pm(None, None, 3000, "tcp"),
        ];
        assert!(url(&ports, 8080).is_ok());
        // UDP, solo expuesto (sin puerto público) y un puerto ajeno.
        for p in [5353, 3000, 80, 22, 65535] {
            assert!(url(&ports, p).is_err(), "{p}");
        }
        // Sin puertos.
        assert!(url(&[], 80).is_err());
    }

    #[test]
    fn mismo_puerto_en_ipv4_e_ipv6_usa_el_primer_host_valido() {
        let ports = [
            pm(Some("2001:db8::1"), Some(80), 80, "tcp"),
            pm(Some("0.0.0.0"), Some(80), 80, "tcp"),
        ];
        assert_eq!(url(&ports, 80).unwrap(), "http://127.0.0.1:80/");
    }

    #[derive(Default)]
    struct RecordingOpener(Mutex<Vec<String>>);

    impl UrlOpener for RecordingOpener {
        fn open(&self, url: &str) -> ApiResult<()> {
            self.0.lock().unwrap().push(url.into());
            Ok(())
        }
    }

    fn engine_with(state: ContainerState, ports: Vec<PortMapping>) -> Arc<MockEngine> {
        let e = Arc::new(MockEngine::new());
        {
            let mut s = e.state();
            let mut c = MockEngine::container("c1", "web", state, "t");
            c.summary.ports = ports;
            s.containers.push(c);
        }
        e
    }

    #[tokio::test]
    async fn el_comando_abre_solo_la_url_construida_por_el_backend() {
        let e = engine_with(
            ContainerState::Running,
            vec![pm(None, Some(8080), 80, "tcp")],
        );
        let opener = RecordingOpener::default();
        let u = open_port_inner(e.as_ref(), &opener, "c1", 8080, "http")
            .await
            .unwrap();
        assert_eq!(u, "http://127.0.0.1:8080/");
        // También por nombre exacto.
        open_port_inner(e.as_ref(), &opener, "web", 8080, "https")
            .await
            .unwrap();
        assert_eq!(
            *opener.0.lock().unwrap(),
            vec!["http://127.0.0.1:8080/", "https://127.0.0.1:8080/"]
        );
    }

    #[tokio::test]
    async fn caminos_de_rechazo_nunca_llegan_al_lanzador() {
        let e = engine_with(
            ContainerState::Running,
            vec![pm(None, Some(8080), 80, "tcp")],
        );
        let stopped = engine_with(
            ContainerState::Exited,
            vec![pm(None, Some(8080), 80, "tcp")],
        );
        let opener = RecordingOpener::default();
        for (id, port, scheme, code) in [
            ("c1", 8080, "file", ApiErrorCode::InvalidInput),
            ("c1", 8080, "javascript", ApiErrorCode::InvalidInput),
            ("c1", 9999, "http", ApiErrorCode::InvalidInput),
            ("c1", 0, "http", ApiErrorCode::InvalidInput),
            ("c1", 70000, "http", ApiErrorCode::InvalidInput),
            ("nope", 8080, "http", ApiErrorCode::NotFound),
            ("c", 8080, "http", ApiErrorCode::NotFound),
        ] {
            let err = open_port_inner(e.as_ref(), &opener, id, port, scheme)
                .await
                .unwrap_err();
            assert_eq!(err.code, code, "{id} {port} {scheme}");
        }
        let err = open_port_inner(stopped.as_ref(), &opener, "c1", 8080, "http")
            .await
            .unwrap_err();
        assert_eq!(err.code, ApiErrorCode::InvalidInput);
        assert!(opener.0.lock().unwrap().is_empty());
    }
}
