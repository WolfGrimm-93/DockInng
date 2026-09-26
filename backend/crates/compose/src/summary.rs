//! Fusión de stacks propios/vinculados con los contenedores descubiertos por labels.

use std::collections::BTreeMap;

use crate::files::StoredStack;
use crate::types::{ComposeContainer, StackOrigin, StackService, StackStatus, StackSummary};
use engine_core::ContainerState;

/// Servicios declarados (de `config`) de un stack sin contenedores: (nombre, imagen).
pub type DeclaredServices = BTreeMap<String, Vec<(String, String)>>;

/// Calcula el resumen de cada stack. `editable` dice si un stack propio/vinculado es editable.
pub fn summarize(
    stored: &[StoredStack],
    editable: &dyn Fn(&StoredStack) -> bool,
    containers: &[ComposeContainer],
    declared: &DeclaredServices,
) -> Vec<StackSummary> {
    let mut by_project: BTreeMap<&str, Vec<&ComposeContainer>> = BTreeMap::new();
    for c in containers
        .iter()
        .filter(|c| !c.oneoff && !c.project.is_empty())
    {
        by_project.entry(c.project.as_str()).or_default().push(c);
    }
    let mut out: Vec<StackSummary> = Vec::new();
    for (project, cs) in &by_project {
        let stored_match = stored.iter().find(|s| s.name == *project);
        let (origin, config_files, working_dir, editable_flag) = match stored_match {
            Some(s) => (
                s.origin,
                s.config_files.clone(),
                s.working_dir.clone(),
                editable(s),
            ),
            None => {
                let files = cs
                    .iter()
                    .find(|c| !c.config_files.is_empty())
                    .map(|c| c.config_files.clone())
                    .unwrap_or_default();
                let wd = cs.iter().find_map(|c| c.working_dir.clone());
                (StackOrigin::Discovered, files, wd, false)
            }
        };
        let mut services: BTreeMap<&str, Vec<&ComposeContainer>> = BTreeMap::new();
        for c in cs {
            services.entry(c.service.as_str()).or_default().push(c);
        }
        let svc: Vec<StackService> = services
            .into_iter()
            .map(|(name, list)| {
                let running = list
                    .iter()
                    .filter(|c| c.state == ContainerState::Running)
                    .count() as u32;
                let total = list.len() as u32;
                let state = list
                    .iter()
                    .find(|c| c.state == ContainerState::Running)
                    .map_or(list[0].state, |c| c.state);
                StackService {
                    name: name.to_string(),
                    image: list[0].image.clone(),
                    state,
                    replicas: format!("{running}/{total}"),
                    running,
                    total,
                }
            })
            .collect();
        let total = cs.len() as u32;
        let running = cs
            .iter()
            .filter(|c| c.state == ContainerState::Running)
            .count() as u32;
        let status = if running == total {
            StackStatus::Running
        } else if running > 0 {
            StackStatus::Partial
        } else {
            StackStatus::Stopped
        };
        out.push(StackSummary {
            name: (*project).to_string(),
            origin,
            path: config_files.first().cloned().unwrap_or_default(),
            config_files,
            working_dir,
            editable: editable_flag,
            status,
            containers: total,
            running,
            services: svc,
        });
    }
    for s in stored
        .iter()
        .filter(|s| !by_project.contains_key(s.name.as_str()))
    {
        let services = declared
            .get(&s.name)
            .map(|v| {
                v.iter()
                    .map(|(n, image)| StackService {
                        name: n.clone(),
                        image: image.clone(),
                        state: ContainerState::Unknown,
                        replicas: "0/0".into(),
                        running: 0,
                        total: 0,
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.push(StackSummary {
            name: s.name.clone(),
            origin: s.origin,
            path: s.config_files.first().cloned().unwrap_or_default(),
            config_files: s.config_files.clone(),
            working_dir: s.working_dir.clone(),
            editable: editable(s),
            status: StackStatus::Declared,
            containers: 0,
            running: 0,
            services,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(project: &str, service: &str, state: ContainerState, oneoff: bool) -> ComposeContainer {
        ComposeContainer {
            id: format!("{project}{service}{state:?}"),
            name: format!("{project}-{service}-1"),
            image: "alpine".into(),
            state,
            status: String::new(),
            project: project.into(),
            service: service.into(),
            working_dir: Some(format!("/w/{project}")),
            config_files: vec![format!("/w/{project}/compose.yaml")],
            environment_file: None,
            oneoff,
            number: Some(1),
            health: None,
        }
    }

    #[test]
    fn combina_origenes_estados_y_declarados() {
        let stored = vec![
            StoredStack {
                name: "propio".into(),
                origin: StackOrigin::Managed,
                config_files: vec!["/data/propio/compose.yaml".into()],
                working_dir: Some("/data/propio".into()),
            },
            StoredStack {
                name: "vacio".into(),
                origin: StackOrigin::Linked,
                config_files: vec!["/x/compose.yaml".into()],
                working_dir: Some("/x".into()),
            },
        ];
        let cs = vec![
            c("propio", "a", ContainerState::Running, false),
            c("propio", "b", ContainerState::Exited, false),
            c("ajeno", "w", ContainerState::Exited, false),
            c("ajeno", "job", ContainerState::Running, true), // oneoff: se ignora
            c("todo", "w", ContainerState::Running, false),
        ];
        let mut declared = DeclaredServices::new();
        declared.insert("vacio".into(), vec![("web".into(), "nginx".into())]);
        let out = summarize(
            &stored,
            &|s| s.origin == StackOrigin::Managed,
            &cs,
            &declared,
        );
        let names: Vec<_> = out.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["ajeno", "propio", "todo", "vacio"]);
        let propio = &out[1];
        assert_eq!(propio.origin, StackOrigin::Managed);
        assert_eq!(propio.status, StackStatus::Partial);
        assert_eq!((propio.containers, propio.running), (2, 1));
        assert!(propio.editable);
        assert_eq!(propio.path, "/data/propio/compose.yaml");
        let ajeno = &out[0];
        assert_eq!(ajeno.origin, StackOrigin::Discovered);
        assert_eq!(ajeno.status, StackStatus::Stopped);
        assert_eq!(ajeno.containers, 1, "oneoff ignorado");
        assert!(!ajeno.editable);
        assert_eq!(ajeno.path, "/w/ajeno/compose.yaml");
        assert_eq!(out[2].status, StackStatus::Running);
        let vacio = &out[3];
        assert_eq!(vacio.status, StackStatus::Declared);
        assert_eq!(vacio.origin, StackOrigin::Linked);
        assert_eq!(vacio.services[0].name, "web");
        assert_eq!(propio.services[0].replicas, "1/1");
    }
}
