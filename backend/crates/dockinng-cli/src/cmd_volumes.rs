//! `volumes ls|create|rm|prune` y `networks ls|create|rm`.

use crate::error::CliError;
use std::collections::HashMap;
use std::sync::Arc;

use engine_core::{
    ActionRequest, CreateNetworkSpec, CreateService, CreateVolumeSpec, EngineClient,
};

use crate::apply::apply;
use crate::cli::Confirm;
use crate::confirm::Stdin;
use crate::ctx::{Ctx, api_msg};
use crate::output::{format_networks, format_volumes, print_json, print_lines};

/// `clave=valor` (repetible) a mapa; una clave repetida se rechaza.
pub fn parse_labels(raw: &[String]) -> Result<HashMap<String, String>, CliError> {
    let mut out = HashMap::new();
    for l in raw {
        let (k, v) = l
            .split_once('=')
            .ok_or_else(|| "las etiquetas deben ser clave=valor".to_string())?;
        if out.insert(k.to_string(), v.to_string()).is_some() {
            return Err(CliError::Usage(format!("etiqueta repetida: {k}")));
        }
    }
    Ok(out)
}

fn creator(ctx: &Ctx) -> CreateService {
    CreateService::new(ctx.engine.clone(), Arc::clone(&ctx.engine) as _)
}

pub async fn volumes_ls(ctx: &Ctx) -> Result<(), CliError> {
    let v = ctx.engine.list_volumes().await.map_err(|e| e.to_string())?;
    if ctx.json {
        return print_json(&v);
    }
    print_lines(&format_volumes(&v));
    Ok(())
}

pub async fn volumes_create(ctx: &Ctx, name: &str, labels: &[String]) -> Result<(), CliError> {
    let v = creator(ctx)
        .create_volume(CreateVolumeSpec {
            name: name.to_string(),
            labels: parse_labels(labels)?,
        })
        .await
        .map_err(api_msg)?;
    println!("{}", v.name);
    Ok(())
}

pub async fn volumes_rm(ctx: &Ctx, name: &str) -> Result<(), CliError> {
    // Confirmación escrita (el nombre): nunca se salta.
    apply(
        ctx,
        &ctx.actions(),
        ActionRequest::RemoveVolume {
            name: name.to_string(),
        },
        false,
        "",
        &mut Stdin,
    )
    .await
    .map(|_| ())
}

pub async fn volumes_prune(ctx: &Ctx) -> Result<(), CliError> {
    apply(
        ctx,
        &ctx.actions(),
        ActionRequest::PruneVolumes,
        false,
        "",
        &mut Stdin,
    )
    .await
    .map(|_| ())
}

pub async fn networks_ls(ctx: &Ctx) -> Result<(), CliError> {
    let n = ctx
        .engine
        .list_networks()
        .await
        .map_err(|e| e.to_string())?;
    if ctx.json {
        return print_json(&n);
    }
    print_lines(&format_networks(&n));
    Ok(())
}

pub async fn networks_create(ctx: &Ctx, name: &str, labels: &[String]) -> Result<(), CliError> {
    let n = creator(ctx)
        .create_network(CreateNetworkSpec {
            name: name.to_string(),
            internal: false,
            subnet: None,
            gateway: None,
            labels: parse_labels(labels)?,
        })
        .await
        .map_err(api_msg)?;
    println!("{}", n.name);
    Ok(())
}

pub async fn networks_rm(ctx: &Ctx, id: &str, confirm: Confirm) -> Result<(), CliError> {
    apply(
        ctx,
        &ctx.actions(),
        ActionRequest::RemoveNetwork { id: id.to_string() },
        confirm.yes,
        &format!("¿Eliminar la red {id}?"),
        &mut Stdin,
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etiquetas() {
        let m = parse_labels(&["a=1".into(), "b=x=y".into()]).unwrap();
        assert_eq!(m["a"], "1");
        assert_eq!(m["b"], "x=y");
        assert!(parse_labels(&["sin".into()]).is_err());
        assert!(parse_labels(&["a=1".into(), "a=2".into()]).is_err());
    }
}
