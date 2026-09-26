//! Descubrimiento de contenedores de Compose por labels (vía bollard, sin subprocesos).
//! Funciona aunque Compose no esté instalado.

use std::collections::HashMap;

use async_trait::async_trait;
use bollard::models::ContainerSummary;
use bollard::query_parameters::ListContainersOptionsBuilder;
use engine_core::{ComposeContainer, ContainerState, EngineError, StackDiscovery};

use crate::{DockerEngine, convert::COMPOSE_PROJECT_LABEL, convert::COMPOSE_SERVICE_LABEL, map};

const WORKING_DIR_LABEL: &str = "com.docker.compose.project.working_dir";
const CONFIG_FILES_LABEL: &str = "com.docker.compose.project.config_files";
const ENV_FILE_LABEL: &str = "com.docker.compose.project.environment_file";
const ONEOFF_LABEL: &str = "com.docker.compose.oneoff";
const NUMBER_LABEL: &str = "com.docker.compose.container-number";
/// Tope defensivo: las labels las controla quien crea el contenedor.
const MAX_LABEL_LEN: usize = 4096;
const MAX_CONFIG_FILES: usize = 8;

fn bounded(s: &str) -> String {
    if s.len() <= MAX_LABEL_LEN {
        return s.to_string();
    }
    let mut end = MAX_LABEL_LEN;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// `(healthy)` / `(unhealthy)` / `(health: starting)` del texto de estado de Docker.
fn health_from_status(status: &str) -> Option<String> {
    if status.contains("(unhealthy)") {
        Some("unhealthy".into())
    } else if status.contains("(healthy)") {
        Some("healthy".into())
    } else if status.contains("(health: starting)") {
        Some("starting".into())
    } else {
        None
    }
}

/// Convierte una fila de `list_containers`; `None` si no tiene proyecto de Compose.
pub(crate) fn compose_container_from_summary(c: ContainerSummary) -> Option<ComposeContainer> {
    let labels: HashMap<String, String> = c.labels.unwrap_or_default();
    let project = labels
        .get(COMPOSE_PROJECT_LABEL)
        .filter(|p| !p.is_empty())?;
    let status = c.status.unwrap_or_default();
    let config_files: Vec<String> = labels
        .get(CONFIG_FILES_LABEL)
        .map(|v| {
            v.split(',')
                .map(str::trim)
                .filter(|f| !f.is_empty())
                .take(MAX_CONFIG_FILES)
                .map(bounded)
                .collect()
        })
        .unwrap_or_default();
    let name = c
        .names
        .unwrap_or_default()
        .into_iter()
        .next()
        .map(|n| n.trim_start_matches('/').to_string())
        .unwrap_or_default();
    Some(ComposeContainer {
        id: c.id.unwrap_or_default(),
        name,
        image: c.image.unwrap_or_default(),
        state: c
            .state
            .map(|s| ContainerState::from_engine(s.as_ref()))
            .unwrap_or(ContainerState::Unknown),
        health: health_from_status(&status),
        status,
        project: bounded(project),
        service: labels
            .get(COMPOSE_SERVICE_LABEL)
            .map(|s| bounded(s))
            .unwrap_or_default(),
        working_dir: labels
            .get(WORKING_DIR_LABEL)
            .filter(|v| !v.is_empty())
            .map(|v| bounded(v)),
        config_files,
        environment_file: labels
            .get(ENV_FILE_LABEL)
            .filter(|v| !v.is_empty())
            .map(|v| bounded(v)),
        oneoff: labels
            .get(ONEOFF_LABEL)
            .is_some_and(|v| v.eq_ignore_ascii_case("true")),
        number: labels.get(NUMBER_LABEL).and_then(|n| n.parse().ok()),
    })
}

#[async_trait]
impl StackDiscovery for DockerEngine {
    async fn list_compose_containers(&self) -> Result<Vec<ComposeContainer>, EngineError> {
        let d = self.client().await?;
        let filters =
            HashMap::from([("label".to_string(), vec![COMPOSE_PROJECT_LABEL.to_string()])]);
        let options = ListContainersOptionsBuilder::default()
            .all(true)
            .filters(&filters)
            .build();
        let list = map(d.list_containers(Some(options)).await)?;
        Ok(list
            .into_iter()
            .filter_map(compose_container_from_summary)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(json: &str) -> ContainerSummary {
        serde_json::from_str(json).expect("summary")
    }

    #[test]
    fn labels_reales_de_compose() {
        let c = compose_container_from_summary(summary(
            r#"{"Id":"8c7f","Names":["/dockinng-test-recon-second-1"],"Image":"alpine:latest",
            "State":"running","Status":"Up 11 seconds (healthy)",
            "Labels":{"com.docker.compose.oneoff":"False","com.docker.compose.project":"dockinng-test-recon",
              "com.docker.compose.project.config_files":"/home/user/a/compose.yaml,/home/user/a/override.yaml",
              "com.docker.compose.project.working_dir":"/home/user/a",
              "com.docker.compose.project.environment_file":"/home/user/a/.env",
              "com.docker.compose.service":"second","com.docker.compose.container-number":"1"}}"#,
        ))
        .unwrap();
        assert_eq!(c.project, "dockinng-test-recon");
        assert_eq!(c.service, "second");
        assert_eq!(c.name, "dockinng-test-recon-second-1");
        assert_eq!(c.state, ContainerState::Running);
        assert_eq!(
            c.config_files,
            ["/home/user/a/compose.yaml", "/home/user/a/override.yaml"]
        );
        assert_eq!(c.working_dir.as_deref(), Some("/home/user/a"));
        assert_eq!(c.environment_file.as_deref(), Some("/home/user/a/.env"));
        assert!(!c.oneoff);
        assert_eq!(c.number, Some(1));
        assert_eq!(c.health.as_deref(), Some("healthy"));
    }

    #[test]
    fn oneoff_sin_proyecto_y_labels_hostiles() {
        let c = compose_container_from_summary(summary(
            r#"{"Id":"1","Names":["/x"],"State":"exited","Status":"Exited (0)",
            "Labels":{"com.docker.compose.project":"p","com.docker.compose.oneoff":"True"}}"#,
        ))
        .unwrap();
        assert!(c.oneoff);
        assert!(c.config_files.is_empty() && c.working_dir.is_none());
        // Sin label de proyecto: no es de Compose.
        assert!(
            compose_container_from_summary(summary(r#"{"Id":"1","Labels":{"a":"b"}}"#)).is_none()
        );
        assert!(compose_container_from_summary(summary(r#"{"Id":"1"}"#)).is_none());
        assert!(
            compose_container_from_summary(summary(
                r#"{"Id":"1","Labels":{"com.docker.compose.project":""}}"#
            ))
            .is_none()
        );
        // Labels enormes y demasiados archivos: acotados.
        let big = "a".repeat(10_000);
        let files = (0..20)
            .map(|i| format!("/f{i}.yaml"))
            .collect::<Vec<_>>()
            .join(",");
        let json = format!(
            r#"{{"Id":"1","Labels":{{"com.docker.compose.project":"{big}","com.docker.compose.project.config_files":"{files}"}}}}"#
        );
        let c = compose_container_from_summary(summary(&json)).unwrap();
        assert!(c.project.len() <= MAX_LABEL_LEN);
        assert_eq!(c.config_files.len(), MAX_CONFIG_FILES);
    }
}
