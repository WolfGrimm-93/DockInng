//! `images ls|pull|rm|prune|build`.

use crate::error::CliError;
use engine_core::pull::PullTracker;
use engine_core::{
    ActionRequest, BuildFeed, BuildOutcome, BuildSpec, BuildStream, EngineClient, PullEngine,
};
use futures_util::StreamExt;

use crate::apply::apply;
use crate::cli::Confirm;
use crate::confirm::{Stdin, gate};
use crate::ctx::{Ctx, api_msg, ctrl_c};
use crate::output::{format_images, print_json, print_lines, print_ndjson};

pub async fn ls(ctx: &Ctx) -> Result<(), CliError> {
    let images = ctx.engine.list_images().await.map_err(|e| e.to_string())?;
    if ctx.json {
        return print_json(&images);
    }
    print_lines(&format_images(&images));
    Ok(())
}

pub async fn pull(ctx: &Ctx, reference: &str) -> Result<(), CliError> {
    engine_core::pull::validate_reference(reference).map_err(|e| e.to_string())?;
    let mut stream = ctx.engine.pull_image(reference);
    let mut tracker = PullTracker::new();
    let mut cancel = std::pin::pin!(ctrl_c());
    loop {
        let ev = tokio::select! {
            ev = stream.next() => ev,
            // Soltar el stream aborta la descarga en el daemon.
            _ = &mut cancel => return Err("cancelado".into()),
        };
        let Some(ev) = ev else { break };
        let ev = ev.map_err(|e| e.to_string())?;
        tracker.feed(&ev);
        if ctx.json {
            print_ndjson(&ev);
        } else if let Some(line) = pull_line(&ev.id, &ev.status) {
            println!("{line}");
        }
    }
    if !ctx.json {
        match (tracker.up_to_date(), tracker.digest()) {
            (true, _) => println!("la imagen ya estaba actualizada"),
            (false, Some(d)) => println!("{d}"),
            _ => {}
        }
    }
    Ok(())
}

/// Solo los cambios de fase relevantes (el progreso byte a byte no se imprime).
fn pull_line(id: &Option<String>, status: &str) -> Option<String> {
    match (id, status) {
        (Some(id), "Pull complete" | "Already exists" | "Download complete") => {
            Some(format!("{id}: {status}"))
        }
        (Some(_), _) => None,
        (None, s) if s.starts_with("Digest:") || s.starts_with("Status:") => Some(s.to_string()),
        (None, _) => None,
    }
}

pub async fn rm(ctx: &Ctx, reference: &str, confirm: Confirm) -> Result<(), CliError> {
    apply(
        ctx,
        &ctx.actions(),
        ActionRequest::RemoveImage {
            reference: reference.to_string(),
        },
        confirm.yes,
        &format!("¿Eliminar la imagen {reference}?"),
        &mut Stdin,
    )
    .await
    .map(|_| ())
}

pub async fn prune(ctx: &Ctx, confirm: Confirm) -> Result<(), CliError> {
    // Nunca un `prune` del daemon: el plan lista las imágenes sin usar y se borran una a una.
    apply(
        ctx,
        &ctx.actions(),
        ActionRequest::PruneImages,
        confirm.yes,
        "¿Eliminar las imágenes sin usar listadas?",
        &mut Stdin,
    )
    .await
    .map(|_| ())
}

/// Convierte los `NOMBRE=VALOR` de la línea de comandos (el valor puede contener `=`).
pub fn parse_build_args(raw: &[String]) -> Result<Vec<(String, String)>, CliError> {
    raw.iter()
        .map(|a| {
            a.split_once('=')
                .map(|(n, v)| (n.to_string(), v.to_string()))
                .ok_or_else(|| CliError::Usage("los --build-arg deben ser NOMBRE=VALOR".into()))
        })
        .collect()
}

pub struct BuildArgs {
    pub context: String,
    pub file: Option<String>,
    pub tag: Option<String>,
    pub build_args: Vec<String>,
    pub target: Option<String>,
    pub no_cache: bool,
    pub pull: bool,
}

struct PrintSink {
    json: bool,
}

impl builder::BuildSink for PrintSink {
    fn send(&self, feed: BuildFeed) -> bool {
        if self.json {
            print_ndjson(&feed);
            return true;
        }
        match feed {
            BuildFeed::Lines { lines } => {
                for l in lines {
                    match l.stream {
                        BuildStream::Stdout => println!("{}", l.text),
                        BuildStream::Stderr => eprintln!("{}", l.text),
                    }
                }
            }
            BuildFeed::Line { text, .. } => println!("{text}"),
            BuildFeed::Step { .. } | BuildFeed::Ended { .. } => {}
        }
        true
    }
}

pub async fn build(ctx: &Ctx, a: BuildArgs, confirm: Confirm) -> Result<(), CliError> {
    let spec = BuildSpec {
        context_dir: a.context,
        dockerfile: a.file,
        tag: a.tag,
        build_args: parse_build_args(&a.build_args)?,
        target: a.target,
        no_cache: a.no_cache,
        pull: a.pull,
    };
    let service = builder::BuildService::new();
    // Destino REAL del subproceso (nunca el `DOCKER_HOST`/TLS ambiente de la shell).
    let target = ctx.build_target();
    let plan = service
        .plan_with(&spec, &target, ctx.interactivity, confirm.yes)
        .map_err(|e| e.message)?;
    if !ctx.json {
        for w in &plan.warnings {
            match w {
                engine_core::BuildWarning::SensitiveContext { path } => {
                    eprintln!(
                        "aviso: el contexto {path} es sensible (se enviaría entero al daemon)"
                    )
                }
                engine_core::BuildWarning::SecretLikeArg { name } => eprintln!(
                    "aviso: {name} parece un secreto y quedaría en el historial de la imagen"
                ),
            }
        }
    }
    gate(
        &plan.decision,
        confirm.yes,
        "¿Construir con este contexto sensible?",
        &mut Stdin,
    )?;
    // `gate` ya pidió la confirmación (o `--yes` la permite): aquí está aprobado.
    let approval = plan
        .ticket
        .as_ref()
        .map(|_| engine_core::Approval::from_cli_prompt());
    let sink = PrintSink { json: ctx.json };
    let r = service
        .run(
            &spec,
            plan.ticket.as_deref(),
            approval,
            &target,
            &sink,
            ctrl_c(),
        )
        .await
        .map_err(api_msg)?;
    match r.outcome {
        BuildOutcome::Ok => {
            if !ctx.json {
                println!("imagen: {}", r.image_id.as_deref().unwrap_or("(sin id)"));
            }
            Ok(())
        }
        BuildOutcome::Canceled => Err("construcción cancelada".into()),
        BuildOutcome::Failed => Err(CliError::Failed(
            r.error
                .map(|e| e.message)
                .unwrap_or_else(|| "la construcción falló".into()),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_args_con_igual_en_el_valor() {
        let r = parse_build_args(&["A=1".into(), "B=x=y".into(), "C=".into()]).unwrap();
        assert_eq!(
            r,
            [
                ("A".into(), "1".into()),
                ("B".into(), "x=y".into()),
                ("C".into(), "".into())
            ]
        );
        assert!(parse_build_args(&["sin_igual".into()]).is_err());
    }

    #[test]
    fn lineas_de_pull_sin_ruido() {
        let some = |s: &str| Some(s.to_string());
        assert_eq!(
            pull_line(&some("abc"), "Pull complete"),
            some("abc: Pull complete")
        );
        assert_eq!(pull_line(&some("abc"), "Downloading"), None);
        assert_eq!(
            pull_line(&None, "Digest: sha256:1"),
            some("Digest: sha256:1")
        );
        assert_eq!(pull_line(&None, "otra cosa"), None);
    }
}
