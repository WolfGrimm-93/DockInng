//! Crear contenedor, volumen y red sobre bollard.
//!
//! Decisiones verificadas contra el daemon real:
//! - Se usa `HostConfig.mounts` y NO `binds`: con `mounts` un origen de bind inexistente
//!   falla al crear (con `binds` Docker crearía un directorio de root en el equipo).
//! - Crear NUNCA hace pull: una imagen ausente es `Coded{image_missing}`.
//! - `create_volume` es idempotente en Docker: se comprueba la existencia antes (`Conflict`).
//! - Una red inexistente se acepta al crear y falla al iniciar: la pre-comprueba el servicio.

use std::collections::HashMap;

use async_trait::async_trait;
use bollard::models::{
    ContainerCreateBody, HostConfig, Ipam, IpamConfig, Mount, MountType, NetworkCreateRequest,
    PortBinding, RestartPolicy, RestartPolicyNameEnum, VolumeCreateRequest,
};
use bollard::query_parameters::{
    CreateContainerOptionsBuilder, ListNetworksOptionsBuilder, StartContainerOptions,
};
use engine_core::create::{self, CREATED_LABEL, PortSpec, RestartPolicy as Restart};
use engine_core::{
    ApiErrorCode, CreateContainerSpec, CreateEngine, CreateNetworkSpec, CreateResult,
    CreateVolumeSpec, EngineClient, EngineError, Network, Volume, validate,
};

use crate::{DockerEngine, error_map, map};

/// Etiqueta de origen que se añade a todo lo que crea DockInng.
fn with_created_label(labels: &HashMap<String, String>) -> HashMap<String, String> {
    let mut l = labels.clone();
    l.insert(CREATED_LABEL.to_string(), "1".to_string());
    l
}

/// Construye el cuerpo de `POST /containers/create` a partir de una spec ya normalizada.
/// Función pura (probada sin daemon).
pub(crate) fn build_create_body(
    spec: &CreateContainerSpec,
) -> Result<ContainerCreateBody, EngineError> {
    let mut exposed: Vec<String> = Vec::new();
    let mut bindings: HashMap<String, Option<Vec<PortBinding>>> = HashMap::new();
    for PortSpec {
        host_ip,
        host_port,
        container_port,
        protocol,
    } in &spec.ports
    {
        let key = format!("{container_port}/{}", protocol.as_str());
        if !exposed.contains(&key) {
            exposed.push(key.clone());
        }
        bindings
            .entry(key)
            .or_insert_with(|| Some(Vec::new()))
            .get_or_insert_with(Vec::new)
            .push(PortBinding {
                host_ip: host_ip.clone(),
                // Cadena vacía = puerto aleatorio del equipo.
                host_port: Some(host_port.map(|p| p.to_string()).unwrap_or_default()),
            });
    }

    let mounts: Vec<Mount> = spec
        .volumes
        .iter()
        .map(|v| {
            let is_bind = v.source.starts_with('/');
            Mount {
                target: Some(v.target.clone()),
                source: Some(v.source.clone()),
                typ: Some(if is_bind {
                    MountType::BIND
                } else {
                    MountType::VOLUME
                }),
                read_only: Some(v.read_only),
                ..Default::default()
            }
        })
        .collect();

    let restart_policy = RestartPolicy {
        name: Some(match spec.restart {
            Restart::No => RestartPolicyNameEnum::NO,
            Restart::Always => RestartPolicyNameEnum::ALWAYS,
            Restart::UnlessStopped => RestartPolicyNameEnum::UNLESS_STOPPED,
            Restart::OnFailure => RestartPolicyNameEnum::ON_FAILURE,
        }),
        maximum_retry_count: spec.restart_max_retries.map(i64::from),
    };

    let cmd = match &spec.command {
        Some(c) => Some(create::parse_command(c).map_err(EngineError::InvalidInput)?),
        None => None,
    };

    let host_config = HostConfig {
        port_bindings: (!bindings.is_empty()).then_some(bindings),
        mounts: (!mounts.is_empty()).then_some(mounts),
        restart_policy: Some(restart_policy),
        network_mode: spec.network.clone(),
        ..Default::default()
    };

    Ok(ContainerCreateBody {
        image: Some(spec.image.clone()),
        cmd,
        env: (!spec.env.is_empty()).then(|| {
            spec.env
                .iter()
                .map(|e| format!("{}={}", e.key, e.value))
                .collect()
        }),
        exposed_ports: (!exposed.is_empty()).then_some(exposed),
        labels: Some(with_created_label(&spec.labels)),
        host_config: Some(host_config),
        ..Default::default()
    })
}

/// Imagen ausente al crear: 404 con "No such image".
fn map_create_error(e: bollard::errors::Error) -> EngineError {
    match error_map::classify(&e) {
        EngineError::NotFound(m) if m.to_ascii_lowercase().contains("no such image") => {
            EngineError::coded(ApiErrorCode::ImageMissing, m)
        }
        other => other,
    }
}

#[async_trait]
impl CreateEngine for DockerEngine {
    async fn create_container(
        &self,
        spec: &CreateContainerSpec,
        start: bool,
    ) -> Result<CreateResult, EngineError> {
        // Defensa en profundidad: aunque la spec venga normalizada, se vuelve a validar.
        create::validate_create(spec, None)
            .map_err(|e| EngineError::InvalidInput(fields_message(&e)))?;
        let body = build_create_body(spec)?;
        let d = self.client().await?;
        let mut opts = CreateContainerOptionsBuilder::default();
        if let Some(n) = &spec.name {
            opts = opts.name(n);
        }
        let created = d
            .create_container(Some(opts.build()), body)
            .await
            .map_err(map_create_error)?;
        let id = created.id;
        let name = map(d.inspect_container(&id, None).await)
            .ok()
            .and_then(|i| i.name)
            .map(|n| n.trim_start_matches('/').to_string())
            .unwrap_or_default();
        let mut result = CreateResult {
            id: id.clone(),
            name,
            started: false,
            warnings: created.warnings,
            start_error: None,
        };
        if start {
            // Si el arranque falla el contenedor queda creado: no se borra nada.
            match map(d.start_container(&id, None::<StartContainerOptions>).await) {
                Ok(()) => result.started = true,
                Err(e) => result.start_error = Some(e.into()),
            }
        }
        Ok(result)
    }

    async fn create_volume(&self, spec: &CreateVolumeSpec) -> Result<Volume, EngineError> {
        create::validate_volume(spec).map_err(|e| EngineError::InvalidInput(fields_message(&e)))?;
        validate::volume_name(&spec.name)?;
        let d = self.client().await?;
        // Docker es idempotente: repetir el nombre devuelve el existente. Se comprueba antes.
        match d.inspect_volume(&spec.name).await {
            Ok(_) => {
                return Err(EngineError::Conflict(format!(
                    "ya existe un volumen llamado {}",
                    spec.name
                )));
            }
            Err(bollard::errors::Error::DockerResponseServerError {
                status_code: 404, ..
            }) => {}
            Err(e) => return Err(error_map::classify(&e)),
        }
        // Driver fijo `local` y sin `driver_opts` (montarían rutas del equipo).
        let req = VolumeCreateRequest {
            name: Some(spec.name.clone()),
            driver: Some("local".into()),
            labels: Some(with_created_label(&spec.labels)),
            ..Default::default()
        };
        map(d.create_volume(req).await)?;
        self.inspect_volume(&spec.name).await
    }

    async fn create_network(&self, spec: &CreateNetworkSpec) -> Result<Network, EngineError> {
        create::validate_network(spec)
            .map_err(|e| EngineError::InvalidInput(fields_message(&e)))?;
        let d = self.client().await?;
        let filters = HashMap::from([("name".to_string(), vec![spec.name.clone()])]);
        let existing = map(d
            .list_networks(Some(
                ListNetworksOptionsBuilder::default()
                    .filters(&filters)
                    .build(),
            ))
            .await)?;
        if existing
            .iter()
            .any(|n| n.name.as_deref() == Some(spec.name.as_str()))
        {
            return Err(EngineError::Conflict(format!(
                "ya existe una red llamada {}",
                spec.name
            )));
        }
        let subnet = spec
            .subnet
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let gateway = spec
            .gateway
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let ipam = subnet.map(|s| Ipam {
            config: Some(vec![IpamConfig {
                subnet: Some(s.to_string()),
                gateway: gateway.map(String::from),
                ..Default::default()
            }]),
            ..Default::default()
        });
        let req = NetworkCreateRequest {
            name: spec.name.clone(),
            // Driver fijo: `bridge`.
            driver: Some("bridge".into()),
            internal: Some(spec.internal),
            ipam,
            labels: Some(with_created_label(&spec.labels)),
            ..Default::default()
        };
        let created = map(d.create_network(req).await)?;
        let nets = self.list_networks().await?;
        nets.into_iter()
            .find(|n| n.id == created.id)
            .ok_or_else(|| EngineError::NotFound(format!("red {}", spec.name)))
    }
}

fn fields_message(errs: &[engine_core::FieldError]) -> String {
    errs.iter()
        .map(|e| format!("{}: {}", e.field, e.message))
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use engine_core::create::{EnvVar, PortProtocol, VolumeSpec};

    use super::*;

    fn base() -> CreateContainerSpec {
        CreateContainerSpec {
            image: "alpine:latest".into(),
            name: Some("dockinng-test-x".into()),
            ports: vec![],
            volumes: vec![],
            env: vec![],
            network: None,
            restart: Restart::No,
            restart_max_retries: None,
            command: None,
            labels: HashMap::from([("dev.dockinng.test".to_string(), "1".to_string())]),
        }
    }

    #[test]
    fn cuerpo_minimo_lleva_etiqueta_de_origen_y_las_del_usuario() {
        let b = build_create_body(&base()).expect("ok");
        let l = b.labels.expect("labels");
        assert_eq!(l.get(CREATED_LABEL).map(String::as_str), Some("1"));
        assert_eq!(l.get("dev.dockinng.test").map(String::as_str), Some("1"));
        assert_eq!(b.image.as_deref(), Some("alpine:latest"));
        assert!(b.cmd.is_none() && b.env.is_none() && b.exposed_ports.is_none());
        let hc = b.host_config.expect("hc");
        // Nunca privilegios.
        assert!(hc.privileged.is_none() && hc.cap_add.is_none() && hc.devices.is_none());
        assert!(hc.pid_mode.is_none() && hc.security_opt.is_none() && hc.binds.is_none());
        assert!(b.user.is_none());
    }

    #[test]
    fn puertos_mounts_env_reinicio_y_comando() {
        let mut s = base();
        s.ports = vec![
            PortSpec {
                host_ip: Some("127.0.0.1".into()),
                host_port: Some(54108),
                container_port: 80,
                protocol: PortProtocol::Tcp,
            },
            PortSpec {
                host_ip: Some("127.0.0.1".into()),
                host_port: None,
                container_port: 53,
                protocol: PortProtocol::Udp,
            },
        ];
        s.volumes = vec![
            VolumeSpec {
                source: "datos".into(),
                target: "/data".into(),
                read_only: false,
            },
            VolumeSpec {
                source: "/srv/x".into(),
                target: "/x".into(),
                read_only: true,
            },
        ];
        s.env = vec![EnvVar {
            key: "A".into(),
            value: "b=c".into(),
        }];
        s.restart = Restart::OnFailure;
        s.restart_max_retries = Some(3);
        s.command = Some("sleep 'a b' ; rm".into());
        s.network = Some("mi-red".into());
        let b = build_create_body(&s).expect("ok");
        assert_eq!(
            b.cmd,
            Some(vec!["sleep".into(), "a b".into(), ";".into(), "rm".into()])
        );
        assert_eq!(b.env, Some(vec!["A=b=c".to_string()]));
        assert_eq!(
            b.exposed_ports,
            Some(vec!["80/tcp".to_string(), "53/udp".to_string()])
        );
        let hc = b.host_config.expect("hc");
        let pb = hc.port_bindings.expect("pb");
        let b80 = pb["80/tcp"].as_ref().expect("v")[0].clone();
        assert_eq!(b80.host_port.as_deref(), Some("54108"));
        assert_eq!(b80.host_ip.as_deref(), Some("127.0.0.1"));
        assert_eq!(
            pb["53/udp"].as_ref().expect("v")[0].host_port.as_deref(),
            Some("")
        );
        let m = hc.mounts.expect("mounts");
        assert_eq!(m[0].typ, Some(MountType::VOLUME));
        assert_eq!(m[1].typ, Some(MountType::BIND));
        assert_eq!(m[1].read_only, Some(true));
        assert!(hc.binds.is_none(), "nunca `binds`");
        let rp = hc.restart_policy.expect("rp");
        assert_eq!(rp.name, Some(RestartPolicyNameEnum::ON_FAILURE));
        assert_eq!(rp.maximum_retry_count, Some(3));
        assert_eq!(hc.network_mode.as_deref(), Some("mi-red"));
    }

    #[test]
    fn comando_con_comillas_sin_cerrar_falla() {
        let mut s = base();
        s.command = Some("echo 'x".into());
        assert!(matches!(
            build_create_body(&s),
            Err(EngineError::InvalidInput(_))
        ));
    }

    #[test]
    fn imagen_ausente_se_clasifica_como_image_missing() {
        use bollard::errors::Error;
        let e = map_create_error(Error::DockerResponseServerError {
            status_code: 404,
            message: "No such image: x:1".into(),
        });
        assert!(matches!(
            e,
            EngineError::Coded {
                code: ApiErrorCode::ImageMissing,
                ..
            }
        ));
        let e = map_create_error(Error::DockerResponseServerError {
            status_code: 409,
            message: "Conflict. The container name".into(),
        });
        assert!(matches!(e, EngineError::Conflict(_)));
    }
}
