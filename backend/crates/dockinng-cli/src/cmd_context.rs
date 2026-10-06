//! `context add|use|ls|rm`: perfiles de conexión guardados (comparten el almacén con la app).
//! `context add` solo guarda metadatos y rutas; la conexión remota se prepara al ejecutar otro
//! comando con `--context` o con la selección predeterminada.

use crate::error::CliError;
use engine_core::connections::{SshIdentity, SshMode};
use engine_core::{Action, ConnSpec, PlanDecision, decide};
use store::Store;

use crate::cli::Confirm;
use crate::confirm::{Stdin, gate, interactivity};
use crate::ctx::Ctx;
use crate::output::{print_json, print_lines, table};

fn open_store() -> Result<Store, CliError> {
    Store::open_default().map_err(CliError::from)
}

fn find_profile<'a>(
    profiles: &'a [engine_core::ConnectionProfile],
    target: &str,
) -> Result<&'a engine_core::ConnectionProfile, CliError> {
    profiles
        .iter()
        .find(|p| p.id == target || p.spec.name().eq_ignore_ascii_case(target))
        .ok_or_else(|| CliError::Usage(format!("no existe la conexión {target}")))
}

pub fn add(ctx: &Ctx, add: crate::cli::ContextAddCmd) -> Result<(), CliError> {
    let spec = match add {
        crate::cli::ContextAddCmd::Ssh {
            name,
            host,
            port,
            user,
            identity,
            agent: _,
            alias,
        } => ConnSpec::Ssh {
            name,
            host,
            port: port.unwrap_or(if alias { 0 } else { 22 }),
            user,
            mode: if alias {
                SshMode::Alias
            } else {
                SshMode::Explicit
            },
            identity: identity
                .map(|path| SshIdentity::File { path })
                .unwrap_or(SshIdentity::Agent),
        },
        crate::cli::ContextAddCmd::Tls {
            name,
            host,
            port,
            ca,
            cert,
            key,
        } => ConnSpec::Tls {
            name,
            host,
            port,
            ca_path: ca,
            cert_path: cert,
            key_path: key,
        },
    };
    let profile = open_store()?
        .connection_save(&spec, None)
        .map_err(|e| e.to_string())?;
    if ctx.json {
        print_json(&profile)
    } else {
        println!("{}", profile.spec.name());
        Ok(())
    }
}

pub fn use_context(ctx: &Ctx, target: &str) -> Result<(), CliError> {
    let store = open_store()?;
    let profiles = store.connection_list().map_err(|e| e.to_string())?;
    let id = if target.eq_ignore_ascii_case("local") {
        engine_core::LOCAL_CONNECTION_ID.to_string()
    } else {
        find_profile(&profiles, target)?.id.clone()
    };
    store
        .prefs_set("last_connection_id", &serde_json::Value::String(id))
        .map_err(|e| e.to_string())?;
    if !ctx.json {
        println!("{target}");
    }
    Ok(())
}

fn kind(spec: &ConnSpec) -> &'static str {
    match spec {
        ConnSpec::Ssh { .. } => "ssh",
        ConnSpec::Tls { .. } => "tls",
    }
}

pub fn ls(ctx: &Ctx) -> Result<(), CliError> {
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
pub fn rm(ctx: &Ctx, target: &str, confirm: Confirm) -> Result<(), CliError> {
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
