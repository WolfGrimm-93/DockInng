//! Análisis informativo de riesgos de un compose ya resuelto (`config --format json`).

use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use crate::types::StackRisk;

/// Normaliza sin tocar el disco: resuelve `.` y `..` y colapsa `//`.
pub fn normalize_path(path: &str) -> PathBuf {
    let mut out = PathBuf::from("/");
    for comp in Path::new(path).components() {
        match comp {
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(p) => out.push(p),
        }
    }
    out
}

/// `true` si montar `path` (bind) expone algo sensible del host: es la raíz o un ancestro de un
/// directorio sensible, o está dentro de uno de los directorios de sistema/secretos.
pub fn is_sensitive_bind(path: &str, home: Option<&str>) -> bool {
    let p = normalize_path(path);
    let mut inside: Vec<PathBuf> = [
        "/etc",
        "/root",
        "/boot",
        "/dev",
        "/proc",
        "/sys",
        "/run",
        "/var/run",
        "/var/lib/docker",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    let mut ancestors: Vec<PathBuf> = vec![PathBuf::from("/"), PathBuf::from("/home")];
    if let Some(h) = home.filter(|h| h.starts_with('/')) {
        let h = normalize_path(h);
        for d in [".ssh", ".gnupg", ".aws", ".kube"] {
            inside.push(h.join(d));
        }
        ancestors.push(h);
    }
    if inside.iter().any(|s| p.starts_with(s)) {
        return true;
    }
    // Es (o contiene a) un ancestro sensible: `/`, `/home`, `$HOME`, y los propios directorios.
    ancestors
        .iter()
        .chain(inside.iter())
        .any(|s| s.starts_with(&p))
}

fn is_socket(path: &str) -> bool {
    let name = normalize_path(path);
    matches!(
        name.file_name().and_then(|n| n.to_str()),
        Some("docker.sock" | "podman.sock")
    )
}

/// Riesgos por servicio.
pub fn analyze(config: &Value, home: Option<&str>) -> Vec<StackRisk> {
    let mut out = Vec::new();
    let Some(services) = config.get("services").and_then(Value::as_object) else {
        return out;
    };
    for (name, def) in services {
        let _ = name;
        if def.get("privileged").and_then(Value::as_bool) == Some(true) {
            out.push(StackRisk::Privileged);
        }
        if def.get("network_mode").and_then(Value::as_str) == Some("host") {
            out.push(StackRisk::HostNetwork);
        }
        if def.get("pid").and_then(Value::as_str) == Some("host") {
            out.push(StackRisk::PidHost);
        }
        if let Some(caps) = def.get("cap_add").and_then(Value::as_array)
            && caps.iter().filter_map(Value::as_str).any(|c| {
                c.trim_start_matches("CAP_")
                    .eq_ignore_ascii_case("SYS_ADMIN")
            })
        {
            out.push(StackRisk::CapAddSysAdmin);
        }
        if let Some(vols) = def.get("volumes").and_then(Value::as_array) {
            for v in vols {
                let bind = v.get("type").and_then(Value::as_str) == Some("bind");
                let src = v.get("source").and_then(Value::as_str);
                if let (true, Some(src)) = (bind, src) {
                    if is_socket(src) {
                        out.push(StackRisk::DockerSock);
                    } else if is_sensitive_bind(src, home) {
                        out.push(StackRisk::SensitiveBind {
                            path: src.to_string(),
                        });
                    }
                }
            }
        }
    }
    // Sin duplicados (varios servicios con el mismo riesgo), orden estable.
    let mut seen = Vec::new();
    out.retain(|r| {
        if seen.contains(r) {
            false
        } else {
            seen.push(r.clone());
            true
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HOME: Option<&str> = Some("/home/user");

    #[test]
    fn rutas_sensibles() {
        for p in [
            "/",
            "/etc",
            "/etc/ssh",
            "/root",
            "/home",
            "/home/user",
            "/boot",
            "/dev/sda",
            "/proc",
            "/sys/fs",
            "/run",
            "/var/run/docker.sock",
            "/var/lib/docker",
            "/home/user/.ssh",
            "/home/user/.aws/credentials",
            "//etc//",
            "/srv/../etc",
            "/var",
            "/var/lib",
        ] {
            assert!(is_sensitive_bind(p, HOME), "{p}");
        }
        for p in [
            "/srv/datos",
            "/home/user/proyecto",
            "/opt/app",
            "/tmp/x",
            "/var/www",
        ] {
            assert!(!is_sensitive_bind(p, HOME), "{p}");
        }
    }

    #[test]
    fn analiza_config_real_sin_riesgos() {
        let cfg: Value =
            serde_json::from_str(include_str!("../tests/fixtures/config.json")).unwrap();
        assert!(analyze(&cfg, HOME).is_empty());
    }

    #[test]
    fn detecta_riesgos() {
        let cfg = json!({"services": {
            "a": {"privileged": true, "network_mode": "host", "pid": "host", "cap_add": ["CAP_SYS_ADMIN"],
                  "volumes": [
                    {"type":"bind","source":"/var/run/docker.sock","target":"/x"},
                    {"type":"bind","source":"/etc","target":"/e"},
                    {"type":"bind","source":"/srv/ok","target":"/o"},
                    {"type":"volume","source":"/etc","target":"/v"}
                  ]},
            "b": {"image": "x"}
        }});
        let r = analyze(&cfg, HOME);
        assert!(r.contains(&StackRisk::Privileged));
        assert!(r.contains(&StackRisk::HostNetwork));
        assert!(r.contains(&StackRisk::PidHost));
        assert!(r.contains(&StackRisk::CapAddSysAdmin));
        assert!(r.contains(&StackRisk::DockerSock));
        assert!(r.contains(&StackRisk::SensitiveBind {
            path: "/etc".into()
        }));
        assert_eq!(r.len(), 6);
        assert!(analyze(&json!({}), HOME).is_empty());
    }
}
