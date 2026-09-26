//! `context ls|rm`: perfiles de conexión guardados (comparten el almacén con la app).
//! Solo administra los perfiles; conectar a un remoto queda pendiente hasta que el transporte
//! esté estable (ver PENDIENTES: `--context` y `context add|use`).

use engine_core::connections::ConnSpec;
use engine_core::{Action, PlanDecision, decide};
use store::Store;

use crate::cli::Confirm;
use crate::confirm::{Stdin, gate, interactivity};
use crate::ctx::Ctx;
use crate::output::{print_json, print_lines, table};

fn open_store() -> Result<Store, String> {
    Store::open_default().map_err(|e| e.to_string())
}

fn kind(spec: &ConnSpec) -> &'static str {
    match spec {
        ConnSpec::Ssh { .. } => "ssh",
        ConnSpec::Tls { .. } => "tls",
    }
}

pub fn ls(ctx: &Ctx) -> Result<(), String> {
    let profiles = open_store()?.connection_list().map_err(|e| e.to_string())?;
    if ctx.json {
        return print_json(&profiles);
    }
    let rows: Vec<Vec<String>> = profiles
        .iter()
        .map(|p| {
            vec![
                p.spec.name().to_string(),
                kind(&p.spec).to_string(),
                format!("{}:{}", p.spec.host(), p.spec.port()),
                p.id.clone(),
            ]
        })
        .collect();
    print_lines(&table(&["NOMBRE", "TIPO", "DESTINO", "ID"], &rows));
    Ok(())
}

/// Borra un perfil guardado (por nombre o id) tras confirmar. No toca el servidor remoto.
pub fn rm(ctx: &Ctx, target: &str, confirm: Confirm) -> Result<(), String> {
    let store = open_store()?;
    let profiles = store.connection_list().map_err(|e| e.to_string())?;
    let p = profiles
        .iter()
        .find(|p| p.id == target || p.spec.name() == target)
        .ok_or_else(|| format!("no existe la conexión {target}"))?;
    let decision = PlanDecision::from(&decide(
        &Action::RemoveConnection,
        interactivity(),
        confirm.yes,
    ));
    gate(
        &decision,
        confirm.yes,
        &format!("¿Eliminar la conexión guardada {}?", p.spec.name()),
        &mut Stdin,
    )?;
    store.connection_delete(&p.id).map_err(|e| e.to_string())?;
    if !ctx.json {
        println!("{}", p.spec.name());
    }
    Ok(())
}
