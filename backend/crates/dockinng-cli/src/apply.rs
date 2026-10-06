//! Camino único de las acciones destructivas: plan -> mostrar afectados -> confirmación según
//! la política del núcleo -> ejecución por ticket. Es el mismo flujo que usa la GUI.

use engine_core::{ActionOutcome, ActionPlan, ActionRequest, ActionService, ItemKind, PlanWarning};

use crate::confirm::{Asker, gate};
use crate::ctx::{Ctx, api_msg};
use crate::output::{human_bytes, print_json, print_lines, table};

fn kind_label(k: ItemKind) -> &'static str {
    match k {
        ItemKind::Container => "contenedor",
        ItemKind::Image => "imagen",
        ItemKind::Volume => "volumen",
        ItemKind::Network => "red",
        ItemKind::Stack => "stack",
    }
}

/// Lo que se va a tocar, en líneas (función pura).
pub fn describe_plan(plan: &ActionPlan) -> Vec<String> {
    let rows: Vec<Vec<String>> = plan
        .affected
        .iter()
        .map(|a| {
            vec![
                kind_label(a.kind).to_string(),
                a.name.clone(),
                a.size_bytes.map_or("-".into(), human_bytes),
            ]
        })
        .collect();
    let mut out = table(&["TIPO", "NOMBRE", "TAMAÑO"], &rows);
    for w in &plan.warnings {
        out.push(match w {
            PlanWarning::RunningForce { count } => {
                format!("aviso: {count} contenedor(es) en ejecución se eliminarán con force")
            }
            PlanWarning::VolumesKept { items } => {
                format!(
                    "aviso: los volúmenes con nombre se conservan: {}",
                    items.join(", ")
                )
            }
            PlanWarning::BindMountsKept { items } => {
                format!(
                    "aviso: las carpetas montadas no se tocan: {}",
                    items.join(", ")
                )
            }
            PlanWarning::InUse { count } => {
                format!("aviso: la imagen la usan {count} contenedor(es)")
            }
            PlanWarning::Skipped { items } => format!(
                "aviso: se omiten (ya no existen o están en uso): {}",
                items.join(", ")
            ),
        });
    }
    if let Some(total) = plan.total_size_bytes {
        out.push(format!("total aproximado: {}", human_bytes(total)));
    }
    out
}

/// Planifica, confirma y ejecuta. Devuelve error si algo se denegó, se canceló o falló algún
/// elemento (código de salida distinto de cero).
pub async fn apply(
    ctx: &Ctx,
    actions: &ActionService,
    req: ActionRequest,
    assume_yes: bool,
    question: &str,
    asker: &mut dyn Asker,
) -> Result<ActionOutcome, String> {
    apply_checked(ctx, actions, req, assume_yes, question, asker, |_| Ok(())).await
}

/// Igual que [`apply`], con una comprobación extra sobre el plan ANTES de preguntar o ejecutar
/// (p. ej. que el plan no haya decidido algo que la persona no pidió).
pub async fn apply_checked(
    ctx: &Ctx,
    actions: &ActionService,
    req: ActionRequest,
    assume_yes: bool,
    question: &str,
    asker: &mut dyn Asker,
    check: impl FnOnce(&ActionPlan) -> Result<(), String>,
) -> Result<ActionOutcome, String> {
    let plan = actions
        .plan_with(req, ctx.interactivity, assume_yes)
        .await
        .map_err(api_msg)?;
    check(&plan)?;
    if plan.affected.is_empty() {
        return Err("no hay nada que hacer".into());
    }
    if !ctx.json {
        print_lines(&describe_plan(&plan));
    }
    let typed = gate(&plan.decision, assume_yes, question, asker)?;
    let ticket = plan
        .ticket
        .ok_or_else(|| "el plan no emitió un ticket de ejecución".to_string())?;
    // `gate` ya pidió la confirmación (o `--yes` la permite): aquí está confirmado.
    let outcome = actions
        .execute(&ticket, typed.as_deref(), true)
        .await
        .map_err(api_msg)?;
    if ctx.json {
        print_json(&outcome)?;
    } else {
        let mut lines: Vec<String> = outcome
            .succeeded
            .iter()
            .map(|i| format!("✓ {} {}", kind_label(i.kind), i.name))
            .collect();
        lines.extend(outcome.failed.iter().map(|f| {
            format!(
                "✗ {} {}: {}",
                kind_label(f.item.kind),
                f.item.name,
                f.error.message
            )
        }));
        if let Some(b) = outcome.freed_bytes {
            lines.push(format!("liberado aproximadamente: {}", human_bytes(b)));
        }
        print_lines(&lines);
    }
    if outcome.failed.is_empty() {
        Ok(outcome)
    } else {
        Err(format!(
            "{} elemento(s) no se pudieron eliminar",
            outcome.failed.len()
        ))
    }
}

#[cfg(test)]
pub mod tests {
    use std::sync::Arc;

    use engine_core::testing::MockEngine;
    use engine_core::{ContainerState, Interactivity};

    use super::*;
    use crate::confirm::tests::Script;

    /// `Ctx` sin motor real: las acciones se construyen sobre un `MockEngine`.
    pub fn mock_ctx(interactivity: Interactivity) -> (Ctx, Arc<MockEngine>, ActionService) {
        let e = Arc::new(MockEngine::new());
        {
            let mut s = e.state();
            s.containers.push(MockEngine::container(
                "c1",
                "parado",
                ContainerState::Exited,
                "t1",
            ));
            s.volumes.push(MockEngine::volume("datos", "t", &[]));
            s.images.push(MockEngine::image("sha256:aa", "sobra:1", 0));
            s.networks
                .push(MockEngine::network("n1", "sobra", &[], false));
        }
        let ctx = Ctx {
            engine: Arc::new(engine_docker::DockerEngine::with_socket(
                "/nonexistent/x.sock",
            )),
            json: false,
            interactivity,
            remote: transport::RemoteManager::new(),
        };
        let actions = ActionService::new(e.clone());
        (ctx, e, actions)
    }

    fn removes(e: &MockEngine) -> Vec<String> {
        e.calls()
            .into_iter()
            .filter(|c| c.starts_with("remove_"))
            .collect()
    }

    #[tokio::test]
    async fn sin_tty_sin_yes_no_borra_nada() {
        let (ctx, e, actions) = mock_ctx(Interactivity::NonInteractive);
        let mut s = Script::default();
        let r = apply(
            &ctx,
            &actions,
            ActionRequest::RemoveContainers {
                ids: vec!["c1".into()],
            },
            false,
            "?",
            &mut s,
        )
        .await;
        assert!(r.unwrap_err().contains("--yes"));
        assert!(removes(&e).is_empty());
    }

    #[tokio::test]
    async fn sin_tty_con_yes_borra_una_confirmacion_simple() {
        let (ctx, e, actions) = mock_ctx(Interactivity::NonInteractive);
        let mut s = Script::default();
        let r = apply(
            &ctx,
            &actions,
            ActionRequest::RemoveContainers {
                ids: vec!["c1".into()],
            },
            true,
            "?",
            &mut s,
        )
        .await;
        assert!(r.is_ok(), "{r:?}");
        assert_eq!(s.asked, 0);
        assert_eq!(removes(&e), ["remove_container:c1:force=false"]);
    }

    #[tokio::test]
    async fn yes_no_salta_volumenes_ni_prune_de_imagenes_sin_tty() {
        let (ctx, e, actions) = mock_ctx(Interactivity::NonInteractive);
        let mut s = Script::default();
        for req in [
            ActionRequest::RemoveVolume {
                name: "datos".into(),
            },
            ActionRequest::PruneVolumes,
            ActionRequest::PruneImages,
        ] {
            let r = apply(&ctx, &actions, req, true, "?", &mut s).await;
            assert!(r.is_err());
        }
        assert!(removes(&e).is_empty());
        assert_eq!(s.asked, 0);
    }

    #[tokio::test]
    async fn con_tty_el_volumen_pide_su_nombre_y_yes_no_lo_evita() {
        let (ctx, e, actions) = mock_ctx(Interactivity::Interactive);
        // Respuesta equivocada: no se borra.
        let mut s = Script {
            typed: Some("ELIMINAR".into()),
            ..Script::default()
        };
        let r = apply(
            &ctx,
            &actions,
            ActionRequest::RemoveVolume {
                name: "datos".into(),
            },
            true,
            "?",
            &mut s,
        )
        .await;
        assert!(r.is_err());
        assert!(removes(&e).is_empty());
        // Respuesta correcta.
        let mut s = Script {
            typed: Some("datos\n".into()),
            ..Script::default()
        };
        let r = apply(
            &ctx,
            &actions,
            ActionRequest::RemoveVolume {
                name: "datos".into(),
            },
            true,
            "?",
            &mut s,
        )
        .await;
        assert!(r.is_ok(), "{r:?}");
        assert_eq!(removes(&e), ["remove_volume:datos"]);
    }

    #[tokio::test]
    async fn prune_system_no_existe_en_la_cli_y_el_nucleo_lo_prohibe() {
        let (ctx, _e, actions) = mock_ctx(Interactivity::Interactive);
        let mut s = Script {
            yes: true,
            typed: Some("ELIMINAR".into()),
            ..Script::default()
        };
        let r = apply(
            &ctx,
            &actions,
            ActionRequest::PruneSystem,
            true,
            "?",
            &mut s,
        )
        .await;
        assert!(r.is_err());
        assert_eq!(s.asked, 0);
    }

    #[tokio::test]
    async fn limpieza_por_seleccion_con_volumen_exige_eliminar() {
        let (ctx, e, actions) = mock_ctx(Interactivity::Interactive);
        let sel = engine_core::CleanupSelection {
            containers: vec!["c1".into()],
            volumes: vec!["datos".into()],
            ..Default::default()
        };
        let mut no = Script {
            typed: Some("datos".into()),
            ..Script::default()
        };
        let r = apply(
            &ctx,
            &actions,
            ActionRequest::Cleanup {
                selection: sel.clone(),
            },
            false,
            "?",
            &mut no,
        )
        .await;
        assert!(r.is_err());
        assert!(removes(&e).is_empty());
        let mut si = Script {
            typed: Some("ELIMINAR".into()),
            ..Script::default()
        };
        let r = apply(
            &ctx,
            &actions,
            ActionRequest::Cleanup { selection: sel },
            false,
            "?",
            &mut si,
        )
        .await;
        assert!(r.is_ok(), "{r:?}");
        assert_eq!(removes(&e).len(), 2);
    }
}
