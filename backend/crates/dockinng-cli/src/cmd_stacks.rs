//! `stacks ls|up|down|restart|stop|start|pull`. Reutiliza el ejecutor de Compose de la GUI.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use engine_core::{
    ActionRequest, CancelSignal, StackControl, StackDiscovery, StackOp, StackOpFeed, StackOutcome,
    StackSink,
};

use crate::apply::apply;
use crate::cli::StackTarget;
use crate::confirm::Stdin;
use crate::ctx::{Ctx, ctrl_c};
use crate::output::{print_json, print_lines, print_ndjson, table};

pub async fn ls(ctx: &Ctx) -> Result<(), String> {
    let containers = ctx
        .engine
        .list_compose_containers()
        .await
        .map_err(|e| e.to_string())?;
    let stacks = ctx
        .runner()
        .list_stacks(containers)
        .await
        .map_err(|e| e.to_string())?;
    if ctx.json {
        return print_json(&stacks);
    }
    let rows: Vec<Vec<String>> = stacks
        .iter()
        .map(|s| {
            vec![
                s.name.clone(),
                format!("{:?}", s.origin).to_lowercase(),
                format!("{:?}", s.status).to_lowercase(),
                format!("{}/{}", s.running, s.containers),
            ]
        })
        .collect();
    print_lines(&table(
        &["NOMBRE", "ORIGEN", "ESTADO", "EN EJECUCIÓN"],
        &rows,
    ));
    Ok(())
}

/// Texto de una línea de progreso; `None` si no cambió desde la última vez.
pub fn progress_line(
    seen: &mut HashMap<String, String>,
    id: &str,
    name: &str,
    text: &str,
) -> Option<String> {
    if seen.get(id).is_some_and(|t| t == text) {
        return None;
    }
    seen.insert(id.to_string(), text.to_string());
    Some(format!("  {name}: {text}"))
}

/// Receptor del progreso: líneas en modo texto, NDJSON con `--json`.
fn sink(json: bool) -> StackSink {
    let seen: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
    Arc::new(move |ev: StackOpFeed| {
        if json {
            print_ndjson(&ev);
            return;
        }
        match ev {
            StackOpFeed::Started { op, stack, .. } => println!("▶ {op} {stack}"),
            StackOpFeed::Progress { items, .. } => {
                let mut seen = seen.lock().unwrap_or_else(|e| e.into_inner());
                for i in &items {
                    if let Some(l) = progress_line(&mut seen, &i.id, &i.name, &i.text) {
                        println!("{l}");
                    }
                }
            }
            StackOpFeed::Log { text } => println!("{text}"),
            StackOpFeed::Ended { .. } => {}
        }
    })
}

pub async fn run_op(
    ctx: &Ctx,
    t: StackTarget,
    op: fn(Option<Vec<String>>) -> StackOp,
) -> Result<(), String> {
    let services = (!t.services.is_empty()).then_some(t.services);
    let runner = ctx.runner();
    let prepared = runner
        .prepare_op(&t.name, op(services))
        .await
        .map_err(|e| e.to_string())?;
    // Ctrl-C = cancelación limpia (SIGTERM al grupo de procesos y `Ended{canceled}`).
    let cancel: CancelSignal = Box::pin(ctrl_c());
    // El resultado final llega en `Ended`: se captura para el código de salida.
    let result: Arc<Mutex<Option<StackOpFeed>>> = Arc::new(Mutex::new(None));
    let inner = sink(ctx.json);
    let keep = result.clone();
    let feed: StackSink = Arc::new(move |ev: StackOpFeed| {
        if matches!(ev, StackOpFeed::Ended { .. }) {
            *keep.lock().unwrap_or_else(|e| e.into_inner()) = Some(ev.clone());
        }
        inner(ev);
    });
    prepared.run(feed, cancel).await;
    let ended = result.lock().unwrap_or_else(|e| e.into_inner()).clone();
    match ended {
        Some(StackOpFeed::Ended {
            outcome: StackOutcome::Success,
            ..
        }) => Ok(()),
        Some(StackOpFeed::Ended { outcome, error, .. }) => Err(match (outcome, error) {
            (StackOutcome::Canceled, _) => "operación cancelada".into(),
            (StackOutcome::Timeout, _) => "la operación superó el tiempo máximo".into(),
            (_, Some(e)) => e.message,
            _ => "la operación falló".into(),
        }),
        _ => Err("la operación terminó sin resultado".into()),
    }
}

pub async fn down(ctx: &Ctx, name: &str) -> Result<(), String> {
    // Confirmación escrita (el nombre del stack): nunca se salta con `--yes`. Sin `-v`.
    apply(
        ctx,
        &ctx.actions_with_stacks(),
        ActionRequest::StackDown {
            project: name.to_string(),
        },
        false,
        "",
        &mut Stdin,
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_progreso_repetido_no_se_imprime_dos_veces() {
        let mut seen = HashMap::new();
        assert!(progress_line(&mut seen, "a", "web", "Creating").is_some());
        assert!(progress_line(&mut seen, "a", "web", "Creating").is_none());
        assert_eq!(
            progress_line(&mut seen, "a", "web", "Created").as_deref(),
            Some("  web: Created")
        );
    }
}
