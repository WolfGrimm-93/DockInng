use serde::{Deserialize, Serialize};

/// Estado de un contenedor, según la Engine API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContainerState {
    Created,
    Running,
    Paused,
    Restarting,
    Removing,
    Stopping,
    Exited,
    Dead,
    Unknown,
}

impl ContainerState {
    /// Convierte el texto que devuelve el daemon (`running`, `exited`, ...).
    pub fn from_engine(value: &str) -> Self {
        match value {
            "created" => Self::Created,
            "running" => Self::Running,
            "paused" => Self::Paused,
            "restarting" => Self::Restarting,
            "removing" => Self::Removing,
            "stopping" => Self::Stopping,
            "exited" => Self::Exited,
            "dead" => Self::Dead,
            _ => Self::Unknown,
        }
    }

    /// Estados en los que borrar sin `force` fallaría en el daemon.
    pub fn is_live(self) -> bool {
        matches!(
            self,
            Self::Running | Self::Paused | Self::Restarting | Self::Stopping
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortMapping {
    pub ip: Option<String>,
    pub private_port: u16,
    pub public_port: Option<u16>,
    /// tcp | udp | sctp
    pub protocol: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MountKind {
    Volume,
    Bind,
    Tmpfs,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MountInfo {
    pub kind: MountKind,
    pub name: Option<String>,
    pub source: String,
    pub destination: String,
    pub read_write: bool,
}

/// Vista resumida de un contenedor (equivale a una fila de `docker ps`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Container {
    /// Id completo (64 hex).
    pub id: String,
    /// Sin "/" inicial.
    pub names: Vec<String>,
    pub image: String,
    /// `sha256:...`, para contar imágenes en uso.
    pub image_id: String,
    pub state: ContainerState,
    /// Texto legible del daemon, ej. "Up 3 hours".
    pub status: String,
    /// Epoch en segundos.
    pub created: i64,
    pub compose_project: Option<String>,
    pub compose_service: Option<String>,
    pub ports: Vec<PortMapping>,
    pub mounts: Vec<MountInfo>,
    pub networks: Vec<String>,
    /// IP (v4/v6), puerta de enlace y MAC del contenedor en cada red a la que está conectado (vacío si está detenido o usa `none`).
    #[serde(default)]
    pub endpoints: Vec<NetworkEndpoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NetworkEndpoint {
    /// Nombre de la red.
    pub name: String,
    pub ip_address: Option<String>,
    #[serde(default)]
    pub ipv6_address: Option<String>,
    pub gateway: Option<String>,
    #[serde(default)]
    pub mac_address: Option<String>,
    /// Alias de DNS del contenedor en esa red (nombre del servicio, del contenedor, id corto). Solo los da `inspect`:
    /// en el listado de contenedores vienen vacíos.
    #[serde(default)]
    pub aliases: Vec<String>,
}

/// Detalle de un contenedor (pantalla de detalle + pestaña "Inspeccionar").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContainerDetail {
    pub summary: Container,
    /// RFC3339.
    pub created_at: String,
    pub ip_address: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub exit_code: Option<i64>,
    pub pid: Option<i64>,
    pub oom_killed: bool,
    pub restart_count: i64,
    pub error: Option<String>,
    pub tty: bool,
    pub restart_policy: Option<String>,
    pub memory_limit_bytes: Option<u64>,
    pub cpu_limit: Option<f64>,
    pub networks: Vec<NetworkEndpoint>,
    /// JSON del modelo tipado de bollard; puede diferir de `docker inspect`.
    pub raw: serde_json::Value,
}

/// Información básica del motor conectado.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineInfo {
    pub version: String,
    pub api_version: String,
    pub os: String,
    pub arch: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn container(endpoints: Vec<NetworkEndpoint>) -> Container {
        Container {
            id: "a".repeat(64),
            names: vec!["web".into()],
            image: "nginx".into(),
            image_id: "sha256:x".into(),
            state: ContainerState::Running,
            status: "Up".into(),
            created: 1,
            compose_project: None,
            compose_service: None,
            ports: vec![],
            mounts: vec![],
            networks: endpoints.iter().map(|e| e.name.clone()).collect(),
            endpoints,
        }
    }

    /// CONTRATO IPC: el frontend (`data/types.ts`, `contract.fixtures.ts`) espera EXACTAMENTE estas claves en snake_case,
    /// con `null` para lo desconocido y `aliases` siempre como lista.
    #[test]
    fn el_json_de_los_endpoints_tiene_la_forma_que_espera_el_frontend() {
        let c = container(vec![NetworkEndpoint {
            name: "tienda_default".into(),
            ip_address: Some("172.20.0.3".into()),
            ipv6_address: None,
            gateway: Some("172.20.0.1".into()),
            mac_address: Some("02:42:ac:14:00:03".into()),
            aliases: vec![],
        }]);
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(
            v["endpoints"][0],
            serde_json::json!({
                "name": "tienda_default", "ip_address": "172.20.0.3", "ipv6_address": null,
                "gateway": "172.20.0.1", "mac_address": "02:42:ac:14:00:03", "aliases": []
            })
        );
        assert_eq!(v["networks"], serde_json::json!(["tienda_default"]));
    }

    /// Compatibilidad: un JSON antiguo sin `endpoints` ni los campos nuevos sigue deserializándose.
    #[test]
    fn un_json_antiguo_sin_endpoints_ni_campos_nuevos_se_deserializa() {
        let old = serde_json::json!({
            "id": "a", "names": ["x"], "image": "i", "image_id": "s", "state": "running", "status": "Up", "created": 1,
            "compose_project": null, "compose_service": null, "ports": [], "mounts": [], "networks": ["n"]
        });
        let c: Container = serde_json::from_value(old).unwrap();
        assert!(c.endpoints.is_empty());
        let e: NetworkEndpoint = serde_json::from_value(
            serde_json::json!({"name": "n", "ip_address": null, "gateway": null}),
        )
        .unwrap();
        assert_eq!(
            (e.ipv6_address, e.mac_address, e.aliases.len()),
            (None, None, 0)
        );
    }
}
