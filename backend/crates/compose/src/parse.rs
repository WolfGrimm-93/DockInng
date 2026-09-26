//! Parsers de la salida REAL de `docker compose` (`version`, `ls`, `ps`, `config`).
//! Tolerantes: campos desconocidos se ignoran; `ps` acepta NDJSON (5.x) y array (antiguo).

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use crate::error::ComposeError;

/// Versión de Compose y si la soportamos (v2+; v1 legado no tiene `--progress json`).
pub fn parse_version(stdout: &str) -> Option<(String, bool)> {
    let text = stdout.trim();
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        let ver = v
            .get("version")?
            .as_str()?
            .trim_start_matches('v')
            .to_string();
        let supported = major(&ver).is_some_and(|m| m >= 2);
        return Some((ver, supported));
    }
    // Texto legado: "docker-compose version 1.29.2, build 5becea4c" o "Docker Compose version v2.x".
    let lower = text.to_lowercase();
    let pos = lower.find("version")?;
    let rest = text[pos + "version".len()..].trim_start();
    let ver: String = rest
        .trim_start_matches('v')
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if ver.is_empty() {
        return None;
    }
    let supported = major(&ver).is_some_and(|m| m >= 2);
    Some((ver, supported))
}

fn major(version: &str) -> Option<u32> {
    version.split('.').next()?.parse().ok()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LsEntry {
    pub name: String,
    pub status: String,
    pub config_files: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawLs {
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    config_files: String,
}

/// `docker compose ls -a --format json` (array JSON).
pub fn parse_ls(stdout: &str) -> Result<Vec<LsEntry>, ComposeError> {
    let text = stdout.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let raw: Vec<RawLs> = serde_json::from_str(text)
        .map_err(|_| ComposeError::Internal("salida de `compose ls` no reconocida".into()))?;
    Ok(raw
        .into_iter()
        .map(|r| LsEntry {
            name: r.name,
            status: r.status,
            config_files: r
                .config_files
                .split(',')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
        })
        .collect())
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PsEntry {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub service: String,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub image: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub health: String,
    #[serde(default, rename = "ID")]
    pub id: String,
}

/// `docker compose ps -a --format json`: NDJSON (5.x), array (versiones anteriores) o vacío.
pub fn parse_ps(stdout: &str) -> Result<Vec<PsEntry>, ComposeError> {
    let text = stdout.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let bad = |_| ComposeError::Internal("salida de `compose ps` no reconocida".into());
    if text.starts_with('[') {
        return serde_json::from_str(text).map_err(bad);
    }
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).map_err(bad))
        .collect()
}

/// Servicio tal como lo resuelve `config --format json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigService {
    pub name: String,
    pub image: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigInfo {
    pub name: Option<String>,
    pub services: Vec<ConfigService>,
    /// JSON completo, para el análisis de riesgos.
    pub raw: Value,
}

/// `docker compose config --format json` (un objeto).
pub fn parse_config(stdout: &str) -> Result<ConfigInfo, ComposeError> {
    let raw: Value = serde_json::from_str(stdout.trim())
        .map_err(|_| ComposeError::Internal("salida de `compose config` no reconocida".into()))?;
    let name = raw.get("name").and_then(Value::as_str).map(str::to_string);
    let mut services = Vec::new();
    if let Some(map) = raw.get("services").and_then(Value::as_object) {
        // serde_json ordena por clave: orden determinista.
        for (svc, def) in map {
            services.push(ConfigService {
                name: svc.clone(),
                image: def.get("image").and_then(Value::as_str).map(str::to_string),
            });
        }
    }
    Ok(ConfigInfo {
        name,
        services,
        raw,
    })
}

/// `config --services`: un nombre por línea; se descartan líneas no válidas.
pub fn parse_services_list(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| crate::validate::validate_service_name(l).is_ok())
        .map(str::to_string)
        .collect()
}

/// Parte la etiqueta `Labels` de `ps` ("k=v,k=v") en un mapa. Solo para paridad de CLI.
pub fn parse_label_string(labels: &str) -> BTreeMap<String, String> {
    labels
        .split(',')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_json_y_legado() {
        let real = include_str!("../tests/fixtures/compose_version.json");
        assert_eq!(parse_version(real), Some(("5.5.1".into(), true)));
        assert_eq!(parse_version("5.5.1\n"), None);
        assert_eq!(
            parse_version("docker-compose version 1.29.2, build 5becea4c"),
            Some(("1.29.2".into(), false))
        );
        assert_eq!(
            parse_version("Docker Compose version v2.20.0"),
            Some(("2.20.0".into(), true))
        );
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("{\"version\":7}"), None);
    }

    #[test]
    fn ls_real() {
        let ls = parse_ls(include_str!("../tests/fixtures/ls_a.json")).unwrap();
        assert_eq!(ls.len(), 3);
        assert_eq!(ls[1].name, "ejemplo-parado");
        assert_eq!(ls[1].config_files.len(), 2);
        assert_eq!(ls[2].status, "exited(6), running(2)");
        assert!(parse_ls("").unwrap().is_empty());
        assert!(parse_ls("basura").is_err());
    }

    #[test]
    fn ps_ndjson_array_y_vacio() {
        let nd = parse_ps(include_str!("../tests/fixtures/ps_a.ndjson")).unwrap();
        assert_eq!(nd.len(), 2);
        assert_eq!(nd[0].service, "second");
        assert_eq!(nd[0].state, "running");
        assert_eq!(nd[1].project, "dockinng-test-recon");
        let arr = format!("[{}]", nd_lines_joined());
        assert_eq!(parse_ps(&arr).unwrap().len(), 2);
        assert!(parse_ps("").unwrap().is_empty());
        assert!(parse_ps("\n\n").unwrap().is_empty());
        assert!(parse_ps("{roto").is_err());
    }

    fn nd_lines_joined() -> String {
        include_str!("../tests/fixtures/ps_a.ndjson")
            .lines()
            .collect::<Vec<_>>()
            .join(",")
    }

    #[test]
    fn config_real() {
        let c = parse_config(include_str!("../tests/fixtures/config.json")).unwrap();
        assert_eq!(c.name.as_deref(), Some("dockinng-test-recon"));
        assert_eq!(
            c.services,
            vec![
                ConfigService {
                    name: "second".into(),
                    image: Some("alpine:latest".into())
                },
                ConfigService {
                    name: "sleeper".into(),
                    image: Some("alpine:latest".into())
                },
            ]
        );
        assert!(parse_config("no json").is_err());
    }

    #[test]
    fn lista_de_servicios_descarta_lineas_hostiles() {
        assert_eq!(
            parse_services_list("web\n--evil\n\ndb\na b\n"),
            vec!["web".to_string(), "db".to_string()]
        );
    }

    #[test]
    fn labels_de_ps() {
        let m = parse_label_string("a=1,b=2=3,solo");
        assert_eq!(m["a"], "1");
        assert_eq!(m["b"], "2=3");
        assert!(!m.contains_key("solo"));
    }
}
