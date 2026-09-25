//! Conversión pura de los modelos de bollard a los del dominio (testeable con JSON real).

use std::collections::{BTreeMap, HashMap};

use bollard::models::{
    ContainerInspectResponse, ContainerSummary, EventMessage, EventMessageTypeEnum, ImageSummary,
    MountPoint, Network as BollardNetwork, PortSummary, Volume as BollardVolume,
};
use engine_core::{
    Container, ContainerDetail, ContainerState, EngineEvent, EngineEventKind, Image, MountInfo,
    MountKind, Network, NetworkEndpoint, PortMapping, Volume,
};
use serde::Deserialize;

pub const COMPOSE_PROJECT_LABEL: &str = "com.docker.compose.project";
pub const COMPOSE_SERVICE_LABEL: &str = "com.docker.compose.service";
const ANONYMOUS_VOLUME_LABEL: &str = "com.docker.volume.anonymous";
const ZERO_DATE: &str = "0001-01-01T00:00:00Z";

fn port_from(p: &PortSummary) -> PortMapping {
    PortMapping {
        ip: p.ip.clone().filter(|s| !s.is_empty()),
        private_port: p.private_port,
        public_port: p.public_port,
        protocol: p
            .typ
            .as_ref()
            .map(|t| t.as_ref().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "tcp".into()),
    }
}

fn mount_from(m: &MountPoint) -> MountInfo {
    let kind = match m.typ.as_deref() {
        Some("volume") => MountKind::Volume,
        Some("bind") => MountKind::Bind,
        Some("tmpfs") => MountKind::Tmpfs,
        _ => MountKind::Other,
    };
    MountInfo {
        kind,
        name: m.name.clone().filter(|s| !s.is_empty()),
        source: m.source.clone().unwrap_or_default(),
        destination: m.destination.clone().unwrap_or_default(),
        read_write: m.rw.unwrap_or(true),
    }
}

pub fn container_from_summary(c: ContainerSummary) -> Container {
    // Ordenar por (público, privado) y quitar duplicados IPv4/IPv6 idénticos.
    let mut ports: Vec<PortMapping> = c.ports.unwrap_or_default().iter().map(port_from).collect();
    ports.sort_by_key(|p| (p.public_port.unwrap_or(0), p.private_port));
    ports.dedup_by(|a, b| {
        a.private_port == b.private_port
            && a.public_port == b.public_port
            && a.protocol == b.protocol
    });
    let mut labels = c.labels.unwrap_or_default();
    let mut networks: Vec<String> = c
        .network_settings
        .and_then(|n| n.networks)
        .map(|n| n.into_keys().collect())
        .unwrap_or_default();
    networks.sort();
    Container {
        id: c.id.unwrap_or_default(),
        names: c
            .names
            .unwrap_or_default()
            .into_iter()
            .map(|n| n.trim_start_matches('/').to_string())
            .collect(),
        image: c.image.unwrap_or_default(),
        image_id: c.image_id.unwrap_or_default(),
        state: c
            .state
            .map(|s| ContainerState::from_engine(s.as_ref()))
            .unwrap_or(ContainerState::Unknown),
        status: c.status.unwrap_or_default(),
        created: c.created.unwrap_or(0),
        compose_project: labels.remove(COMPOSE_PROJECT_LABEL),
        compose_service: labels.remove(COMPOSE_SERVICE_LABEL),
        ports,
        mounts: c
            .mounts
            .unwrap_or_default()
            .iter()
            .map(mount_from)
            .collect(),
        networks,
    }
}

fn real_date(d: Option<String>) -> Option<String> {
    d.filter(|s| !s.is_empty() && s != ZERO_DATE)
}

/// Combina el resultado de `inspect` con la fila de la lista (`summary`).
pub fn detail_from_inspect(summary: Container, i: ContainerInspectResponse) -> ContainerDetail {
    let raw = serde_json::to_value(&i).unwrap_or(serde_json::Value::Null);
    let state = i.state.as_ref();
    let running = state.and_then(|s| s.running).unwrap_or(false);

    let mut networks: Vec<NetworkEndpoint> = i
        .network_settings
        .and_then(|n| n.networks)
        .unwrap_or_default()
        .into_iter()
        .map(|(name, e)| NetworkEndpoint {
            name,
            ip_address: e.ip_address.filter(|s| !s.is_empty()),
            gateway: e.gateway.filter(|s| !s.is_empty()),
        })
        .collect();
    networks.sort_by(|a, b| a.name.cmp(&b.name));
    let ip_address = networks.iter().find_map(|n| n.ip_address.clone());

    let host = i.host_config.as_ref();
    let restart_policy = host
        .and_then(|h| h.restart_policy.as_ref())
        .and_then(|r| serde_json::to_value(r.name.as_ref()?).ok())
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|s| !s.is_empty());

    ContainerDetail {
        summary,
        created_at: i.created.unwrap_or_default(),
        ip_address,
        started_at: real_date(state.and_then(|s| s.started_at.clone())),
        finished_at: real_date(state.and_then(|s| s.finished_at.clone())),
        exit_code: if running {
            None
        } else {
            state.and_then(|s| s.exit_code)
        },
        pid: state.and_then(|s| s.pid).filter(|p| *p > 0),
        oom_killed: state.and_then(|s| s.oom_killed).unwrap_or(false),
        restart_count: i.restart_count.unwrap_or(0),
        error: state
            .and_then(|s| s.error.clone())
            .filter(|s| !s.is_empty()),
        tty: i.config.as_ref().and_then(|c| c.tty).unwrap_or(false),
        restart_policy,
        memory_limit_bytes: host
            .and_then(|h| h.memory)
            .filter(|m| *m > 0)
            .map(|m| m as u64),
        cpu_limit: host
            .and_then(|h| h.nano_cpus)
            .filter(|n| *n > 0)
            .map(|n| n as f64 / 1e9),
        networks,
        raw,
    }
}

/// Una fila por etiqueta. `containers_by_image` sirve de respaldo si el daemon devuelve -1.
pub fn images_from_summary(
    i: ImageSummary,
    containers_by_image: &HashMap<String, u32>,
) -> Vec<Image> {
    let in_use = if i.containers >= 0 {
        i.containers as u32
    } else {
        containers_by_image.get(&i.id).copied().unwrap_or(0)
    };
    let size = i.size.max(0) as u64;
    let tags: Vec<&String> = i
        .repo_tags
        .iter()
        .filter(|t| t.as_str() != "<none>:<none>")
        .collect();
    let mk = |reference: String, repository: String, tag: String, dangling: bool| Image {
        id: i.id.clone(),
        reference,
        repository,
        tag,
        size_bytes: size,
        created: i.created,
        containers: in_use,
        dangling,
    };
    if tags.is_empty() {
        return vec![mk(i.id.clone(), "<none>".into(), "<none>".into(), true)];
    }
    tags.into_iter()
        .map(|t| {
            // "host:5000/repo:tag": el último ':' solo separa la etiqueta si no hay '/' después.
            let (repo, tag) = match t.rsplit_once(':') {
                Some((r, tg)) if !tg.contains('/') => (r.to_string(), tg.to_string()),
                _ => (t.clone(), "latest".to_string()),
            };
            mk(t.clone(), repo, tag, false)
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct DfUsage {
    #[serde(rename = "Size", default)]
    size: i64,
}

#[derive(Debug, Deserialize)]
struct DfVolume {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "UsageData")]
    usage: Option<DfUsage>,
}

/// Decodifica los `items` de `volume_usage` de `/system/df` (sin tipar en bollard 1.53):
/// nombre -> tamaño en bytes (los `-1` = desconocido se descartan).
pub fn volume_sizes_from_df(items: &[serde_json::Value]) -> HashMap<String, u64> {
    items
        .iter()
        .filter_map(|v| serde_json::from_value::<DfVolume>(v.clone()).ok())
        .filter_map(|v| {
            let size = v.usage?.size;
            (size >= 0).then_some((v.name, size as u64))
        })
        .collect()
}

pub fn volume_from(
    v: BollardVolume,
    sizes: &HashMap<String, u64>,
    used_by: &HashMap<String, Vec<String>>,
) -> Volume {
    let size = sizes.get(&v.name).copied().or_else(|| {
        v.usage_data
            .as_ref()
            .filter(|u| u.size >= 0)
            .map(|u| u.size as u64)
    });
    let mut labels = v.labels;
    let compose_project = labels.get(COMPOSE_PROJECT_LABEL).cloned();
    let anonymous = labels.contains_key(ANONYMOUS_VOLUME_LABEL);
    labels.remove(ANONYMOUS_VOLUME_LABEL);
    Volume {
        used_by: used_by.get(&v.name).cloned().unwrap_or_default(),
        name: v.name,
        driver: v.driver,
        mountpoint: v.mountpoint,
        created_at: v.created_at.filter(|s| !s.is_empty()),
        labels,
        compose_project,
        size_bytes: size,
        anonymous,
    }
}

pub fn network_from(n: BollardNetwork, connected: &HashMap<String, Vec<String>>) -> Network {
    let name = n.name.unwrap_or_default();
    let subnets = n
        .ipam
        .and_then(|i| i.config)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|c| c.subnet)
        .filter(|s| !s.is_empty())
        .collect();
    let compose_project = n.labels.and_then(|mut l| l.remove(COMPOSE_PROJECT_LABEL));
    Network {
        id: n.id.unwrap_or_default(),
        // Redes predefinidas y de swarm: no se pueden borrar.
        system: matches!(
            name.as_str(),
            "bridge" | "host" | "none" | "ingress" | "docker_gwbridge"
        ) || n.ingress.unwrap_or(false)
            || n.scope.as_deref() == Some("swarm"),
        connected: connected.get(&name).cloned().unwrap_or_default(),
        name,
        driver: n.driver.unwrap_or_default(),
        scope: n.scope.unwrap_or_default(),
        subnets,
        internal: n.internal.unwrap_or(false),
        compose_project,
    }
}

const EVENT_ATTRS: &[&str] = &[
    "name",
    "image",
    "exitCode",
    "signal",
    COMPOSE_PROJECT_LABEL,
    COMPOSE_SERVICE_LABEL,
];

/// `None` para acciones que son ruido (`exec_*`).
pub fn event_from(m: EventMessage) -> Option<EngineEvent> {
    let action = m.action.unwrap_or_default();
    if action.starts_with("exec_") {
        return None;
    }
    let kind = match m.typ {
        Some(EventMessageTypeEnum::CONTAINER) => EngineEventKind::Container,
        Some(EventMessageTypeEnum::IMAGE) => EngineEventKind::Image,
        Some(EventMessageTypeEnum::VOLUME) => EngineEventKind::Volume,
        Some(EventMessageTypeEnum::NETWORK) => EngineEventKind::Network,
        Some(EventMessageTypeEnum::DAEMON) => EngineEventKind::Daemon,
        _ => EngineEventKind::Other,
    };
    let actor = m.actor.unwrap_or_default();
    let attributes: BTreeMap<String, String> = actor
        .attributes
        .unwrap_or_default()
        .into_iter()
        .filter(|(k, _)| EVENT_ATTRS.contains(&k.as_str()))
        .collect();
    Some(EngineEvent {
        kind,
        action,
        id: actor.id.unwrap_or_default(),
        name: attributes.get("name").cloned(),
        time_nano: m.time_nano.unwrap_or(0),
        attributes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(json: &str) -> ContainerSummary {
        serde_json::from_str(json).expect("json")
    }

    #[test]
    fn contenedor_completo() {
        let c = container_from_summary(summary(
            r#"{"Id":"abc","Names":["/web"],"Image":"nginx","ImageID":"sha256:1","Created":1700000000,
            "State":"running","Status":"Up 3 hours",
            "Ports":[{"IP":"0.0.0.0","PrivatePort":80,"PublicPort":8080,"Type":"tcp"},
                     {"IP":"::","PrivatePort":80,"PublicPort":8080,"Type":"tcp"},
                     {"PrivatePort":443,"Type":"tcp"}],
            "Labels":{"com.docker.compose.project":"tienda","com.docker.compose.service":"web"},
            "NetworkSettings":{"Networks":{"tienda_default":{},"bridge":{}}},
            "Mounts":[{"Type":"volume","Name":"datos","Source":"/v","Destination":"/d","RW":true},
                      {"Type":"bind","Source":"/home/x","Destination":"/x","RW":false}]}"#,
        ));
        assert_eq!(c.names, ["web"]);
        assert_eq!(c.state, ContainerState::Running);
        assert_eq!(c.compose_project.as_deref(), Some("tienda"));
        assert_eq!(c.compose_service.as_deref(), Some("web"));
        // Sin duplicados v4/v6, orden por puerto público.
        assert_eq!(c.ports.len(), 2);
        assert_eq!(c.ports[0].public_port, None);
        assert_eq!(c.networks, ["bridge", "tienda_default"]);
        assert_eq!(c.mounts[0].kind, MountKind::Volume);
        assert_eq!(c.mounts[0].name.as_deref(), Some("datos"));
        assert_eq!(c.mounts[1].kind, MountKind::Bind);
        assert!(!c.mounts[1].read_write);
    }

    #[test]
    fn contenedor_con_campos_ausentes_no_entra_en_panic() {
        let c = container_from_summary(summary("{}"));
        assert_eq!(c.state, ContainerState::Unknown);
        assert!(c.names.is_empty() && c.ports.is_empty() && c.id.is_empty());
        let s = container_from_summary(summary(r#"{"State":"stopping"}"#));
        assert_eq!(s.state, ContainerState::Stopping);
    }

    fn image(json: &str) -> ImageSummary {
        serde_json::from_str(json).expect("json")
    }

    #[test]
    fn imagenes_0_1_n_etiquetas_y_none() {
        let none = HashMap::new();
        let base = |tags: &str| {
            format!(
                r#"{{"Id":"sha256:aa","ParentId":"","RepoTags":{tags},"RepoDigests":[],"Created":5,"Size":1000,"SharedSize":-1,"Labels":{{}},"Containers":2}}"#
            )
        };
        let rows = images_from_summary(image(&base("[]")), &none);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].dangling);
        assert_eq!(rows[0].reference, "sha256:aa");
        assert_eq!(rows[0].containers, 2);
        let rows = images_from_summary(image(&base(r#"["<none>:<none>"]"#)), &none);
        assert!(rows[0].dangling);
        let rows = images_from_summary(
            image(&base(r#"["nginx:1.27","localhost:5000/app/x:2","ubuntu"]"#)),
            &none,
        );
        assert_eq!(rows.len(), 3);
        assert_eq!(
            (rows[0].repository.as_str(), rows[0].tag.as_str()),
            ("nginx", "1.27")
        );
        assert_eq!(
            (rows[1].repository.as_str(), rows[1].tag.as_str()),
            ("localhost:5000/app/x", "2")
        );
        assert_eq!(rows[2].tag, "latest");
        assert!(rows.iter().all(|r| r.id == "sha256:aa" && !r.dangling));
    }

    #[test]
    fn imagen_con_containers_menos_uno_cuenta_por_image_id() {
        let json = r#"{"Id":"sha256:bb","ParentId":"","RepoTags":["a:1"],"RepoDigests":[],"Created":5,"Size":1,"SharedSize":-1,"Labels":{},"Containers":-1}"#;
        let counts: HashMap<String, u32> = [("sha256:bb".to_string(), 3)].into();
        assert_eq!(images_from_summary(image(json), &counts)[0].containers, 3);
    }

    #[test]
    fn volumenes_con_y_sin_usage_data_y_df() {
        let df: Vec<serde_json::Value> = serde_json::from_str(
            r#"[{"Name":"a","UsageData":{"Size":2048,"RefCount":1}},{"Name":"b","UsageData":{"Size":-1,"RefCount":0}},{"Name":"c"},{"basura":1}]"#,
        )
        .expect("json");
        let sizes = volume_sizes_from_df(&df);
        assert_eq!(sizes.len(), 1);
        let vol = |n: &str, extra: &str| -> BollardVolume {
            serde_json::from_str(&format!(
                r#"{{"Name":"{n}","Driver":"local","Mountpoint":"/m","CreatedAt":"2026-01-01T00:00:00Z","Labels":{{{extra}}},"Scope":"local","Options":{{}}}}"#
            ))
            .expect("json")
        };
        let used: HashMap<String, Vec<String>> =
            [("a".to_string(), vec!["web".to_string()])].into();
        let a = volume_from(
            vol("a", r#""com.docker.compose.project":"p""#),
            &sizes,
            &used,
        );
        assert_eq!(a.size_bytes, Some(2048));
        assert_eq!(a.used_by, ["web"]);
        assert_eq!(a.compose_project.as_deref(), Some("p"));
        let b = volume_from(
            vol("b", r#""com.docker.volume.anonymous":"""#),
            &sizes,
            &used,
        );
        assert_eq!(b.size_bytes, None);
        assert!(b.anonymous && b.used_by.is_empty());
    }

    #[test]
    fn redes_con_y_sin_ipam() {
        let net = |json: &str| -> BollardNetwork { serde_json::from_str(json).expect("json") };
        let connected: HashMap<String, Vec<String>> =
            [("app".to_string(), vec!["web".to_string()])].into();
        let n = network_from(
            net(
                r#"{"Name":"app","Id":"n1","Driver":"bridge","Scope":"local","Internal":false,
                 "IPAM":{"Driver":"default","Config":[{"Subnet":"172.20.0.0/16"}]}}"#,
            ),
            &connected,
        );
        assert_eq!(n.subnets, ["172.20.0.0/16"]);
        assert_eq!(n.connected, ["web"]);
        assert!(!n.system);
        let h = network_from(net(r#"{"Name":"host","Id":"n2"}"#), &connected);
        assert!(h.system && h.subnets.is_empty());
        for json in [
            r#"{"Name":"ingress","Id":"i","Scope":"swarm","Ingress":true}"#,
            r#"{"Name":"docker_gwbridge","Id":"g"}"#,
            r#"{"Name":"overlay-x","Id":"o","Scope":"swarm","Driver":"overlay"}"#,
            r#"{"Name":"raro","Id":"r","Ingress":true}"#,
        ] {
            assert!(network_from(net(json), &connected).system, "{json}");
        }
        assert!(
            !network_from(
                net(r#"{"Name":"mia","Id":"m","Scope":"local"}"#),
                &connected
            )
            .system
        );
    }

    #[test]
    fn eventos_filtran_atributos_y_ruido() {
        let ev = |json: &str| -> EventMessage { serde_json::from_str(json).expect("json") };
        let e = event_from(ev(
            r#"{"Type":"container","Action":"die","Actor":{"ID":"abc","Attributes":{"name":"web","image":"nginx","exitCode":"1","secreto":"x","com.docker.compose.project":"p"}},"timeNano":42}"#,
        ))
        .expect("evento");
        assert_eq!(e.kind, EngineEventKind::Container);
        assert_eq!(e.name.as_deref(), Some("web"));
        assert!(!e.attributes.contains_key("secreto"));
        assert_eq!(e.attributes.len(), 4);
        assert!(
            event_from(ev(
                r#"{"Type":"container","Action":"exec_start: sh","Actor":{"ID":"a"}}"#
            ))
            .is_none()
        );
        assert!(
            event_from(ev(
                r#"{"Type":"container","Action":"health_status: healthy","Actor":{"ID":"a"}}"#
            ))
            .is_some()
        );
    }

    #[test]
    fn inspect_a_detalle() {
        let i: ContainerInspectResponse = serde_json::from_str(
            r#"{"Id":"abc","Created":"2026-01-01T00:00:00Z","RestartCount":2,
            "State":{"Status":"exited","Running":false,"ExitCode":137,"OOMKilled":true,"StartedAt":"2026-01-01T00:00:01Z","FinishedAt":"0001-01-01T00:00:00Z"},
            "Config":{"Tty":true},
            "HostConfig":{"Memory":536870912,"NanoCpus":1500000000,"RestartPolicy":{"Name":"unless-stopped"}},
            "NetworkSettings":{"Networks":{"b":{"IPAddress":"","Gateway":""},"a":{"IPAddress":"10.0.0.2","Gateway":"10.0.0.1"}}}}"#,
        )
        .expect("json");
        let s = container_from_summary(summary(r#"{"Id":"abc"}"#));
        let d = detail_from_inspect(s, i);
        assert!(d.tty && d.oom_killed);
        assert_eq!(d.exit_code, Some(137));
        assert_eq!(d.finished_at, None);
        assert_eq!(d.ip_address.as_deref(), Some("10.0.0.2"));
        assert_eq!(d.memory_limit_bytes, Some(536_870_912));
        assert_eq!(d.cpu_limit, Some(1.5));
        assert_eq!(d.restart_policy.as_deref(), Some("unless-stopped"));
        assert_eq!(d.networks[0].name, "a");
        assert!(d.raw.is_object());
    }
}
