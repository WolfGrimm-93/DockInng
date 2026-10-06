//! Limpieza guiada contra el daemon real. Solo con `DOCKINNG_LIVE_TESTS=1`.
//!
//! El informe es de solo lectura. La parte destructiva se limita a recursos propios
//! `dockinng-test-clean-*` (etiqueta `dev.dockinng.test=1`), y al final se comprueba que las
//! listas de contenedores, volúmenes, imágenes y redes ajenas no cambiaron.

use std::process::Command;
use std::sync::Arc;

use engine_core::{
    ActionRequest, ActionService, CleanupCategoryId, CleanupSelection, ContainerState,
    EngineClient, PlanDecision, cleanup_report,
};
use engine_docker::DockerEngine;

fn live() -> bool {
    if std::env::var("DOCKINNG_LIVE_TESTS").as_deref() == Ok("1") {
        true
    } else {
        eprintln!("saltado: define DOCKINNG_LIVE_TESTS=1 para correr las pruebas live");
        false
    }
}

fn docker(args: &[&str]) -> (bool, String) {
    let o = Command::new("docker").args(args).output().expect("docker");
    (
        o.status.success(),
        String::from_utf8_lossy(&o.stdout).into_owned(),
    )
}

fn snapshot() -> Vec<Vec<String>> {
    [
        &["ps", "-aq"][..],
        &["volume", "ls", "-q"],
        &["images", "-q"],
        &["network", "ls", "-q"],
    ]
    .iter()
    .map(|a| {
        let mut v: Vec<String> = docker(a).1.lines().map(String::from).collect();
        v.sort();
        v
    })
    .collect()
}

#[tokio::test]
async fn informe_solo_lectura_y_limpieza_de_recursos_de_prueba() {
    if !live() {
        return;
    }
    let before = snapshot();
    let engine = Arc::new(DockerEngine::new());
    let tag = "dev.dockinng.test=1";
    let id = &uuid::Uuid::now_v7().simple().to_string()[26..];
    let (ctr, vol, net) = (
        format!("dockinng-test-clean-{id}-c"),
        format!("dockinng-test-clean-{id}-v"),
        format!("dockinng-test-clean-{id}-n"),
    );
    assert!(
        docker(&[
            "create",
            "--name",
            &ctr,
            "--label",
            tag,
            "--pull",
            "never",
            "alpine:latest",
            "true"
        ])
        .0
    );
    assert!(docker(&["volume", "create", "--label", tag, &vol]).0);
    assert!(docker(&["network", "create", "--label", tag, &net]).0);

    let mut leftovers = Vec::new();
    let result = async {
        // Informe: lo nuestro aparece; los volúmenes nunca por defecto.
        let report = cleanup_report(engine.as_ref(), 0)
            .await
            .map_err(|e| e.to_string())?;
        let all: Vec<_> = report
            .categories
            .iter()
            .flat_map(|c| c.items.iter())
            .collect();
        for name in [&ctr, &vol, &net] {
            if !all.iter().any(|i| &i.name == name) {
                return Err(format!("{name} no aparece en el informe"));
            }
        }
        for c in &report.categories {
            if c.id == CleanupCategoryId::UnusedVolumes
                && c.items.iter().any(|i| i.selected_by_default)
            {
                return Err("un volumen vino marcado por defecto".into());
            }
        }
        // Ejecución por selección explícita de SOLO nuestros recursos.
        let ctr_id = engine
            .list_containers(true)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|c| c.names.iter().any(|n| n == &ctr))
            .filter(|c| c.state == ContainerState::Created)
            .ok_or("contenedor de prueba no encontrado")?
            .id;
        let actions = ActionService::new(engine.clone());
        let plan = actions
            .plan(ActionRequest::Cleanup {
                selection: CleanupSelection {
                    containers: vec![ctr_id],
                    volumes: vec![vol.clone()],
                    networks: vec![net.clone()],
                    ..Default::default()
                },
            })
            .await
            .map_err(|e| format!("{e:?}"))?;
        if plan.decision
            != (PlanDecision::ConfirmTyped {
                expected: "ELIMINAR".into(),
            })
        {
            return Err(format!("decisión inesperada: {:?}", plan.decision));
        }
        if plan.affected.len() != 3 {
            return Err(format!("afectados inesperados: {}", plan.affected.len()));
        }
        let ticket = plan.ticket.ok_or("sin ticket")?;
        // Confirmación equivocada: no se borra nada.
        if actions
            .execute(&ticket, Some("otra cosa"), true)
            .await
            .is_ok()
        {
            return Err("aceptó una confirmación equivocada".into());
        }
        let out = actions
            .execute(&ticket, Some("ELIMINAR"), true)
            .await
            .map_err(|e| format!("{e:?}"))?;
        if out.succeeded.len() != 3 || !out.failed.is_empty() {
            return Err(format!("resultado inesperado: {out:?}"));
        }
        Ok::<(), String>(())
    }
    .await;

    // Limpieza de seguridad de lo que quede (solo nuestros nombres).
    for (kind, name) in [("rm", &ctr), ("network", &net), ("volume", &vol)] {
        let args: Vec<&str> = match kind {
            "rm" => vec!["rm", name.as_str()],
            k => vec![k, "rm", name.as_str()],
        };
        if docker(&args).0 {
            leftovers.push(name.clone());
        }
    }
    result.expect("limpieza guiada");
    assert!(leftovers.is_empty(), "la ejecución no borró: {leftovers:?}");
    assert_eq!(before, snapshot(), "cambiaron recursos ajenos");
}
