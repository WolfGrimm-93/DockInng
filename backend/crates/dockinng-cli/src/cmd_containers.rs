//! `ps`, `start`, `stop`, `restart`, `rm` y `doctor`.

use crate::error::CliError;
use engine_core::{
    ActionRequest, ConnectionCause, ConnectionStatus, DiagStepId, EngineClient, StepStatus,
};

use crate::apply::apply_checked;
use crate::cli::Confirm;
use crate::confirm::Stdin;
use crate::ctx::Ctx;
use crate::output::{format_containers, print_json, print_lines};

pub async fn ps(ctx: &Ctx, all: bool) -> Result<(), CliError> {
    let containers = ctx
        .engine
        .list_containers(all)
        .await
        .map_err(|e| e.to_string())?;
    if ctx.json {
        return print_json(&containers);
    }
    print_lines(&format_containers(&containers));
    Ok(())
}

pub async fn lifecycle(ctx: &Ctx, verb: Verb, id: &str) -> Result<(), CliError> {
    let r = match verb {
        Verb::Start => ctx.engine.start_container(id).await,
        Verb::Stop => ctx.engine.stop_container(id).await,
        Verb::Restart => ctx.engine.restart_container(id).await,
    };
    r.map_err(|e| e.to_string())?;
    println!("{id}");
    Ok(())
}

#[derive(Clone, Copy)]
pub enum Verb {
    Start,
    Stop,
    Restart,
}

pub async fn rm(ctx: &Ctx, id: &str, force: bool, confirm: Confirm) -> Result<(), CliError> {
    // Sin `--force` no se escala: un contenedor en ejecución se rechaza aquí (el plan de la
    // GUI decide `force` por el estado real, la CLI exige que la persona lo pida).
    let detail = ctx
        .engine
        .inspect_container(id)
        .await
        .map_err(|e| e.to_string())?;
    if detail.summary.state.is_live() && !force {
        return Err(CliError::Usage(format!(
            "{id} está en ejecución: detenlo antes o usa --force"
        )));
    }
    let actions = ctx.actions();
    apply_checked(
        ctx,
        &actions,
        ActionRequest::RemoveContainers {
            ids: vec![id.to_string()],
        },
        confirm.yes,
        &format!("¿Eliminar el contenedor {id}?"),
        &mut Stdin,
        |plan| rm_guard(plan, force),
    )
    .await
    .map(|_| ())
}

/// El plan decide `force` por el estado real; sin `--force` de la persona nunca se escala
/// (si el contenedor arrancó entre la comprobación y el plan, se aborta).
pub fn rm_guard(plan: &engine_core::ActionPlan, force: bool) -> Result<(), CliError> {
    if !force
        && plan
            .affected
            .iter()
            .any(|a| a.state.is_some_and(|s| s.is_live()))
    {
        return Err("el contenedor pasó a estar en ejecución: usa --force o detenlo antes".into());
    }
    Ok(())
}

/// Diagnóstico de la conexión: consume `EngineClient::diagnose`, la misma fuente que la GUI.
pub async fn doctor(ctx: &Ctx) -> Result<(), CliError> {
    match std::env::var("DOCKER_HOST") {
        Ok(h) => println!("• DOCKER_HOST = {h}"),
        Err(_) => println!("• DOCKER_HOST no definido (se usa el socket local)"),
    }
    match ctx.engine.diagnose().await {
        ConnectionStatus::Connected { endpoint, server } => {
            println!("✓ conectado a {endpoint}");
            println!(
                "✓ Docker {} (API {}) en {}/{}",
                server.version, server.api_version, server.os, server.arch
            );
            Ok(())
        }
        ConnectionStatus::Failed {
            endpoint,
            cause,
            message,
            steps,
        } => {
            println!("• endpoint: {endpoint}");
            for s in &steps {
                let label = match s.id {
                    DiagStepId::Socket => "socket",
                    DiagStepId::Permissions => "permisos",
                    DiagStepId::Daemon => "daemon",
                };
                let mark = match s.status {
                    StepStatus::Ok => "✓",
                    StepStatus::Fail => "✗",
                    StepStatus::Skipped => "-",
                };
                // Un paso omitido no tiene detalle: se dice explícitamente.
                let detail = if s.detail.is_empty() {
                    "no comprobado"
                } else {
                    s.detail.as_str()
                };
                println!("{mark} {label}: {detail}");
            }
            match cause {
                ConnectionCause::SocketMissing => {
                    println!("  ¿Está corriendo el daemon? (systemctl status docker)")
                }
                ConnectionCause::PermissionDenied => {
                    println!("  Agrega tu usuario al grupo docker (sudo usermod -aG docker $USER).")
                }
                ConnectionCause::DaemonDown => {
                    println!("  El socket existe pero nadie responde: inicia el servicio docker.")
                }
                _ => {}
            }
            Err(CliError::Failed(format!(
                "el motor no está disponible: {message}"
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use engine_core::testing::MockEngine;
    use engine_core::{ActionService, ContainerState, Interactivity};

    use super::*;
    use crate::confirm::tests::Script;

    async fn plan_for(
        state: ContainerState,
    ) -> (engine_core::ActionPlan, Arc<MockEngine>, ActionService) {
        let e = Arc::new(MockEngine::new());
        e.state()
            .containers
            .push(MockEngine::container("c1", "web", state, "t"));
        let actions = ActionService::new(e.clone());
        let plan = actions
            .plan_with(
                ActionRequest::RemoveContainers {
                    ids: vec!["c1".into()],
                },
                Interactivity::NonInteractive,
                true,
            )
            .await
            .unwrap();
        (plan, e, actions)
    }

    #[tokio::test]
    async fn sin_force_un_contenedor_que_paso_a_correr_aborta() {
        let (plan, _e, _a) = plan_for(ContainerState::Running).await;
        assert!(rm_guard(&plan, false).is_err());
        assert!(rm_guard(&plan, true).is_ok());
        let (plan, _e, _a) = plan_for(ContainerState::Exited).await;
        assert!(rm_guard(&plan, false).is_ok());
    }

    #[tokio::test]
    async fn el_camino_completo_no_borra_si_el_guarda_falla() {
        let (ctx, e, actions) = crate::apply::tests::mock_ctx(Interactivity::NonInteractive);
        e.state().containers[0] =
            MockEngine::container("c1", "parado", ContainerState::Running, "t1");
        let mut s = Script::default();
        let r = apply_checked(
            &ctx,
            &actions,
            ActionRequest::RemoveContainers {
                ids: vec!["c1".into()],
            },
            true,
            "?",
            &mut s,
            |plan| rm_guard(plan, false),
        )
        .await;
        assert!(r.unwrap_err().to_string().contains("en ejecución"));
        assert!(!e.calls().iter().any(|c| c.starts_with("remove_")));
    }
}
