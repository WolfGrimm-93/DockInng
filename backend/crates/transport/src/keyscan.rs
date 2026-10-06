//! Sondeo de la clave de servidor y confianza explícita (TOFU con huella visible).
//!
//! Primer contacto = NUNCA silencioso: `probe` solo LEE la clave pública del servidor
//! (`ssh-keyscan`) y calcula su huella (`ssh-keygen -lf -`); nada se escribe. `trust` solo
//! escribe en el `known_hosts` propio si la huella que vio el usuario coincide con lo que el
//! servidor presenta ahora y la clave no ha cambiado respecto a una previa.

use std::path::Path;
use std::time::Duration;

use engine_core::{ConnectionCause, EngineError, HostKeyProbe, HostKeyState, SshMode};

use crate::known_hosts::{self, HostKey};
use crate::proc::run_capture;
use crate::ssh_args::{SshTarget, keyscan_args, resolve_alias_args};

const SCAN_TIMEOUT: Duration = Duration::from_secs(12);
const KEYGEN_TIMEOUT: Duration = Duration::from_secs(5);

/// Clave sondeada con su huella y etiqueta legible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedKey {
    pub key: HostKey,
    /// `SHA256:...`.
    pub fingerprint: String,
    /// `ED25519`, `ECDSA`, `RSA`.
    pub label: String,
}

/// Orden de preferencia para mostrar (la más robusta primero).
fn preference(key_type: &str) -> u8 {
    match key_type {
        "ssh-ed25519" => 0,
        t if t.starts_with("ecdsa-") => 1,
        _ => 2,
    }
}

/// Interpreta la salida de `ssh-keyscan`: líneas `host tipo base64` (los `#` se ignoran).
pub fn parse_keyscan_output(out: &str) -> Vec<HostKey> {
    let mut keys: Vec<HostKey> = Vec::new();
    for line in out.lines() {
        if let Some(e) = known_hosts::parse_line(line)
            && !keys.contains(&e.key)
        {
            keys.push(e.key);
        }
    }
    keys
}

/// Extrae las huellas de la salida de `ssh-keygen -lf -`: `256 SHA256:xxx host (ED25519)`.
pub fn parse_keygen_output(out: &str) -> Vec<(String, String)> {
    out.lines()
        .filter_map(|l| {
            let fp = l.split_whitespace().find(|t| t.starts_with("SHA256:"))?;
            let ok = fp.len() > 7
                && fp.len() < 80
                && fp[7..]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='));
            if !ok {
                return None;
            }
            let label = l
                .rsplit_once('(')
                .and_then(|(_, r)| r.strip_suffix(')'))
                .unwrap_or("?")
                .to_string();
            Some((fp.to_string(), label))
        })
        .collect()
}

/// Host y puerto reales a sondear. En modo alias se resuelve con `ssh -G` (solo por gesto
/// explícito del usuario: es el único caso en que se lee la configuración de ssh).
async fn scan_address(target: &SshTarget) -> Result<(String, u16), EngineError> {
    if target.mode == SshMode::Explicit {
        return Ok((target.host.clone(), target.port.unwrap_or(22)));
    }
    let args = resolve_alias_args(&target.host)?;
    let out = run_capture("ssh", &args, None, Duration::from_secs(5)).await?;
    parse_alias_resolution(&out.stdout)
}

/// Interpreta la salida de `ssh -G <alias>`. Si el alias usa `ProxyJump` o `ProxyCommand`,
/// `ssh-keyscan` NO llegaría al mismo servidor que `ssh` (sondearía el host directo, no el
/// que se alcanza tras el salto): se falla cerrado en vez de ofrecer una huella engañosa.
pub fn parse_alias_resolution(stdout: &str) -> Result<(String, u16), EngineError> {
    let mut host = None;
    let mut port = None;
    for line in stdout.lines() {
        let mut fields = line.split_whitespace();
        let Some(key) = fields.next() else { continue };
        let value = fields.collect::<Vec<_>>().join(" ");
        match key {
            "hostname" => host = Some(value),
            "port" => port = value.parse::<u16>().ok(),
            "proxyjump" | "proxycommand" if !value.eq_ignore_ascii_case("none") => {
                return Err(EngineError::InvalidInput(
                    "el alias usa ProxyJump/ProxyCommand: no se puede verificar la huella del servidor final. Usa el modo agente o archivo con host, usuario y puerto explícitos".into(),
                ));
            }
            _ => {}
        }
    }
    let host = host.ok_or_else(|| {
        EngineError::InvalidInput("no se pudo resolver el alias con ssh -G".into())
    })?;
    // El hostname resuelto sale de un archivo de configuración: se revalida.
    engine_core::connections::validate_host(&host)
        .or_else(|_| engine_core::connections::validate_host(&format!("[{host}]")))?;
    Ok((host, port.unwrap_or(22)))
}

/// Sondea las claves del servidor y calcula sus huellas. No escribe nada.
pub async fn scan(target: &SshTarget) -> Result<Vec<ScannedKey>, EngineError> {
    let (host, port) = scan_address(target).await?;
    let args = keyscan_args(&host, port)?;
    let out = run_capture("ssh-keyscan", &args, None, SCAN_TIMEOUT).await?;
    let keys = parse_keyscan_output(&out.stdout);
    if keys.is_empty() {
        return Err(EngineError::Connection {
            cause: ConnectionCause::Unreachable,
            message: "no se pudo leer la clave del servidor (¿host o puerto incorrectos, o el servidor no responde?)".into(),
        });
    }
    // `ssh-keygen -lf -` recibe las líneas en formato known_hosts.
    let input: String = keys
        .iter()
        .map(|k| known_hosts::format_line("x", k))
        .collect();
    let fp = run_capture(
        "ssh-keygen",
        &["-l".into(), "-f".into(), "-".into()],
        Some(input.as_bytes()),
        KEYGEN_TIMEOUT,
    )
    .await?;
    let prints = parse_keygen_output(&fp.stdout);
    if prints.len() != keys.len() {
        return Err(EngineError::Internal(
            "no se pudieron calcular las huellas de la clave del servidor".into(),
        ));
    }
    let mut scanned: Vec<ScannedKey> = keys
        .into_iter()
        .zip(prints)
        .map(|(key, (fingerprint, label))| ScannedKey {
            key,
            fingerprint,
            label,
        })
        .collect();
    scanned.sort_by_key(|s| preference(&s.key.key_type));
    Ok(scanned)
}

/// Estado de las claves sondeadas frente al `known_hosts` propio y la clave a mostrar.
pub fn evaluate(
    known_hosts_path: &Path,
    name: &str,
    scanned: &[ScannedKey],
) -> Result<(HostKeyState, ScannedKey), EngineError> {
    let entries = known_hosts::read(known_hosts_path)?;
    let keys: Vec<HostKey> = scanned.iter().map(|s| s.key.clone()).collect();
    let state = known_hosts::state_for(&entries, name, &keys);
    // Se muestra la clave coincidente si ya es de confianza; si no, la preferida.
    let shown = if state == HostKeyState::Trusted {
        scanned
            .iter()
            .find(|s| {
                entries.iter().any(|e| {
                    e.names.iter().any(|n| *n == name.to_ascii_lowercase()) && e.key == s.key
                })
            })
            .or(scanned.first())
    } else {
        scanned.first()
    }
    .cloned()
    .ok_or_else(|| EngineError::Internal("sin claves sondeadas".into()))?;
    Ok((state, shown))
}

/// Sondea el servidor y devuelve huella, tipo y estado. Solo lectura.
pub async fn probe(
    target: &SshTarget,
    known_hosts_path: &Path,
) -> Result<HostKeyProbe, EngineError> {
    let scanned = scan(target).await?;
    let (state, shown) = evaluate(known_hosts_path, &target.known_hosts_name(), &scanned)?;
    Ok(HostKeyProbe {
        key_type: shown.label,
        fingerprint_sha256: shown.fingerprint,
        state,
    })
}

/// Confía en la clave cuya huella vio el usuario. Re-sondea y exige coincidencia exacta;
/// una clave cambiada NUNCA se acepta por esta vía. Devuelve la clave en la que se confió.
pub async fn trust(
    target: &SshTarget,
    known_hosts_path: &Path,
    fingerprint: &str,
) -> Result<HostKeyProbe, EngineError> {
    let scanned = scan(target).await?;
    let name = target.known_hosts_name();
    let (state, _) = evaluate(known_hosts_path, &name, &scanned)?;
    let chosen = scanned
        .iter()
        .find(|s| s.fingerprint == fingerprint)
        .ok_or_else(|| {
            EngineError::Conflict(
                "la huella del servidor cambió desde que la viste: vuelve a sondear".into(),
            )
        })?;
    let trusted = HostKeyProbe {
        key_type: chosen.label.clone(),
        fingerprint_sha256: chosen.fingerprint.clone(),
        state: HostKeyState::Trusted,
    };
    match state {
        HostKeyState::Changed => Err(EngineError::Connection {
            cause: ConnectionCause::HostKeyChanged,
            message: "la clave del servidor cambió respecto a la de confianza: no se acepta automáticamente".into(),
        }),
        HostKeyState::Trusted => Ok(trusted),
        HostKeyState::Unknown => {
            known_hosts::append(known_hosts_path, &known_hosts::format_line(&name, &chosen.key))?;
            Ok(trusted)
        }
    }
}

/// Olvida la clave de confianza guardada para el destino, solo en el `known_hosts` PROPIO.
/// No confía en nada: el host queda como desconocido y la siguiente conexión vuelve a exigir
/// confirmar la huella que presente el servidor. Devuelve cuántas entradas se quitaron.
pub fn forget(known_hosts_path: &Path, target: &SshTarget) -> Result<usize, EngineError> {
    known_hosts::remove_name(known_hosts_path, &target.known_hosts_name())
}

/// Huella de la clave de confianza guardada para un destino, calculada solo con datos
/// locales (sin red). `None` si no hay entrada.
pub async fn stored_fingerprint(
    known_hosts_path: &Path,
    target: &SshTarget,
) -> Result<Option<String>, EngineError> {
    let name = target.known_hosts_name();
    let entries = known_hosts::read(known_hosts_path)?;
    let mut keys: Vec<HostKey> = entries
        .into_iter()
        .filter(|e| e.names.contains(&name))
        .map(|e| e.key)
        .collect();
    keys.sort_by_key(|k| preference(&k.key_type));
    let Some(key) = keys.first() else {
        return Ok(None);
    };
    let input = known_hosts::format_line("x", key);
    let out = run_capture(
        "ssh-keygen",
        &["-l".into(), "-f".into(), "-".into()],
        Some(input.as_bytes()),
        KEYGEN_TIMEOUT,
    )
    .await?;
    Ok(parse_keygen_output(&out.stdout)
        .into_iter()
        .next()
        .map(|(fp, _)| fp))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alias_con_proxy_falla_cerrado() {
        let ok = "user u\nhostname web.example\nport 2200\nproxyjump none\n";
        assert_eq!(
            parse_alias_resolution(ok).unwrap(),
            ("web.example".to_string(), 2200)
        );
        assert_eq!(
            parse_alias_resolution("hostname\tweb.example\nport   2200\nproxyjump\tnone\n")
                .unwrap(),
            ("web.example".to_string(), 2200)
        );
        assert_eq!(
            parse_alias_resolution("hostname h\n").unwrap(),
            ("h".to_string(), 22)
        );
        for bad in [
            "hostname h\nproxyjump bastion\n",
            "hostname h\nproxycommand ssh -W %h:%p x\n",
        ] {
            let e = parse_alias_resolution(bad).unwrap_err();
            assert!(e.to_string().contains("ProxyJump"), "{bad}");
        }
        // Un hostname hostil salido de la configuración no pasa.
        assert!(parse_alias_resolution("hostname -oProxyCommand=x\n").is_err());
        assert!(parse_alias_resolution("port 22\n").is_err());
    }

    #[test]
    fn parsea_salida_de_keyscan() {
        let out = "# 127.0.0.1:22 SSH-2.0-OpenSSH_9.9\n\
                   127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIABC\n\
                   127.0.0.1 ecdsa-sha2-nistp256 AAAAE2VjZHNhAAA\n\
                   127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIABC\n\
                   basura sin formato\n";
        let k = parse_keyscan_output(out);
        assert_eq!(k.len(), 2);
        assert_eq!(k[0].key_type, "ssh-ed25519");
    }

    #[test]
    fn parsea_salida_de_keygen() {
        let out = "256 SHA256:AbC+/def123= x (ED25519)\n3072 SHA256:zzz x (RSA)\nno es huella\n";
        let p = parse_keygen_output(out);
        assert_eq!(p.len(), 2);
        assert_eq!(
            p[0],
            ("SHA256:AbC+/def123=".to_string(), "ED25519".to_string())
        );
        assert_eq!(p[1].1, "RSA");
        assert!(parse_keygen_output("256 SHA256:evil;rm x (RSA)").is_empty());
    }

    #[test]
    fn evaluate_prefiere_la_clave_coincidente_y_detecta_cambio() {
        let d =
            std::env::temp_dir().join(format!("dockinng-test-kh-eval-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("known_hosts");
        let ed = ScannedKey {
            key: HostKey {
                key_type: "ssh-ed25519".into(),
                blob: "AAAAED".into(),
            },
            fingerprint: "SHA256:ed".into(),
            label: "ED25519".into(),
        };
        let rsa = ScannedKey {
            key: HostKey {
                key_type: "ssh-rsa".into(),
                blob: "AAAARSA".into(),
            },
            fingerprint: "SHA256:rsa".into(),
            label: "RSA".into(),
        };
        let scanned = vec![ed.clone(), rsa.clone()];
        let (s, shown) = evaluate(&p, "h", &scanned).unwrap();
        assert_eq!(
            (s, shown.fingerprint.as_str()),
            (HostKeyState::Unknown, "SHA256:ed")
        );
        known_hosts::append(&p, &known_hosts::format_line("h", &rsa.key)).unwrap();
        let (s, shown) = evaluate(&p, "h", &scanned).unwrap();
        assert_eq!(
            (s, shown.fingerprint.as_str()),
            (HostKeyState::Trusted, "SHA256:rsa")
        );
        // El servidor ahora presenta solo otra clave: cambiado.
        let (s, _) = evaluate(&p, "h", &[ed]).unwrap();
        assert_eq!(s, HostKeyState::Changed);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn olvidar_deja_el_host_desconocido_y_no_confia_en_nada() {
        let d =
            std::env::temp_dir().join(format!("dockinng-test-kh-forget-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("known_hosts");
        let vieja = HostKey {
            key_type: "ssh-ed25519".into(),
            blob: "AAAAOLD".into(),
        };
        let nueva = HostKey {
            key_type: "ssh-ed25519".into(),
            blob: "AAAANEW".into(),
        };
        known_hosts::append(&p, &known_hosts::format_line("srv.local", &vieja)).unwrap();
        let escaneada = vec![ScannedKey {
            key: nueva,
            fingerprint: "SHA256:new".into(),
            label: "ED25519".into(),
        }];
        let (antes, _) = evaluate(&p, "srv.local", &escaneada).unwrap();
        assert_eq!(antes, HostKeyState::Changed);
        let target = SshTarget {
            host: "srv.local".into(),
            port: Some(22),
            user: None,
            mode: SshMode::Explicit,
            identity: engine_core::SshIdentity::Agent,
        };
        assert_eq!(forget(&p, &target).unwrap(), 1);
        let (despues, _) = evaluate(&p, "srv.local", &escaneada).unwrap();
        assert_eq!(despues, HostKeyState::Unknown);
        let _ = std::fs::remove_dir_all(&d);
    }
}
