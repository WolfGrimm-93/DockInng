//! CLI `dockinng`: adaptador de línea de comandos sobre el mismo núcleo que usa la GUI.

mod apply;
mod cli;
mod cmd_cleanup;
mod cmd_containers;
mod cmd_context;
mod cmd_images;
mod cmd_logs;
mod cmd_stacks;
mod cmd_volumes;
mod confirm;
mod ctx;
mod output;

use std::process::ExitCode;

use clap::{CommandFactory, Parser};
use cli::{CleanupCmd, Cli, Command, ContextCmd, ImagesCmd, NetworksCmd, StacksCmd, VolumesCmd};
use ctx::Ctx;
use engine_core::StackOp;

#[tokio::main]
async fn main() -> ExitCode {
    match run(Cli::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("error: {msg}");
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<(), String> {
    // Los completados no necesitan motor.
    if let Command::Completions { shell } = &cli.command {
        let mut cmd = Cli::command();
        clap_complete::generate(*shell, &mut cmd, "dockinng", &mut std::io::stdout());
        return Ok(());
    }
    let ctx = Ctx::new(cli.json);
    dispatch(&ctx, cli.command).await
}

async fn dispatch(ctx: &Ctx, command: Command) -> Result<(), String> {
    use cmd_containers::Verb;
    match command {
        Command::Ps { all } => cmd_containers::ps(ctx, all).await,
        Command::Start { id } => cmd_containers::lifecycle(ctx, Verb::Start, &id).await,
        Command::Stop { id } => cmd_containers::lifecycle(ctx, Verb::Stop, &id).await,
        Command::Restart { id } => cmd_containers::lifecycle(ctx, Verb::Restart, &id).await,
        Command::Rm { id, force, confirm } => cmd_containers::rm(ctx, &id, force, confirm).await,
        Command::Doctor => cmd_containers::doctor(ctx).await,
        Command::Images(c) => match c {
            ImagesCmd::Ls => cmd_images::ls(ctx).await,
            ImagesCmd::Pull { reference } => cmd_images::pull(ctx, &reference).await,
            ImagesCmd::Rm { reference, confirm } => cmd_images::rm(ctx, &reference, confirm).await,
            ImagesCmd::Prune { confirm } => cmd_images::prune(ctx, confirm).await,
            ImagesCmd::Build {
                context,
                file,
                tag,
                build_args,
                target,
                no_cache,
                pull,
                confirm,
            } => {
                let args = cmd_images::BuildArgs {
                    context,
                    file,
                    tag,
                    build_args,
                    target,
                    no_cache,
                    pull,
                };
                cmd_images::build(ctx, args, confirm).await
            }
        },
        Command::Volumes(c) => match c {
            VolumesCmd::Ls => cmd_volumes::volumes_ls(ctx).await,
            VolumesCmd::Create { name, labels } => {
                cmd_volumes::volumes_create(ctx, &name, &labels).await
            }
            VolumesCmd::Rm { name } => cmd_volumes::volumes_rm(ctx, &name).await,
            VolumesCmd::Prune => cmd_volumes::volumes_prune(ctx).await,
        },
        Command::Networks(c) => match c {
            NetworksCmd::Ls => cmd_volumes::networks_ls(ctx).await,
            NetworksCmd::Create { name, labels } => {
                cmd_volumes::networks_create(ctx, &name, &labels).await
            }
            NetworksCmd::Rm { id, confirm } => cmd_volumes::networks_rm(ctx, &id, confirm).await,
        },
        Command::Logs { id, follow, tail } => cmd_logs::logs(ctx, &id, follow, tail).await,
        Command::Stacks(c) => match c {
            StacksCmd::Ls => cmd_stacks::ls(ctx).await,
            StacksCmd::Up(t) => {
                cmd_stacks::run_op(ctx, t, |services| StackOp::Up { services }).await
            }
            StacksCmd::Down { name } => cmd_stacks::down(ctx, &name).await,
            StacksCmd::Restart(t) => {
                cmd_stacks::run_op(ctx, t, |services| StackOp::Restart { services }).await
            }
            StacksCmd::Stop(t) => {
                cmd_stacks::run_op(ctx, t, |services| StackOp::Stop { services }).await
            }
            StacksCmd::Start(t) => {
                cmd_stacks::run_op(ctx, t, |services| StackOp::Start { services }).await
            }
            StacksCmd::Pull(t) => {
                cmd_stacks::run_op(ctx, t, |services| StackOp::Pull { services }).await
            }
        },
        Command::Cleanup(c) => match c {
            CleanupCmd::Plan { min_age_days } => cmd_cleanup::plan(ctx, min_age_days).await,
            CleanupCmd::Apply {
                defaults,
                min_age_days,
                containers,
                images,
                volumes,
                networks,
                confirm,
            } => {
                let args = cmd_cleanup::ApplyArgs {
                    defaults,
                    min_age_days,
                    containers,
                    images,
                    volumes,
                    networks,
                };
                cmd_cleanup::apply_cmd(ctx, args, confirm).await
            }
        },
        Command::Context(c) => match c {
            ContextCmd::Ls => cmd_context::ls(ctx),
            ContextCmd::Rm { target, confirm } => cmd_context::rm(ctx, &target, confirm),
        },
        Command::Completions { .. } => unreachable!("se atiende antes de crear el contexto"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
        Cli::try_parse_from(std::iter::once("dockinng").chain(args.iter().copied()))
    }

    #[test]
    fn el_arbol_de_comandos_es_consistente() {
        Cli::command().debug_assert();
    }

    #[test]
    fn parseo_de_comandos_principales() {
        for args in [
            &["ps", "-a"][..],
            &["images", "ls", "--json"],
            &[
                "images",
                "build",
                ".",
                "-t",
                "x:1",
                "--build-arg",
                "A=1",
                "--no-cache",
            ],
            &["volumes", "create", "v", "--label", "a=b"],
            &["networks", "rm", "n", "--yes"],
            &["logs", "c1", "-f", "--tail", "50"],
            &["stacks", "up", "demo", "-s", "web", "-s", "db"],
            &["stacks", "down", "demo"],
            &["cleanup", "plan", "--min-age-days", "30"],
            &["cleanup", "apply", "--defaults", "--volume", "v", "--yes"],
            &["completions", "fish"],
            &["context", "ls", "--json"],
            &["context", "rm", "x", "--yes"],
        ] {
            assert!(parse(args).is_ok(), "{args:?}");
        }
    }

    #[test]
    fn rechaza_lo_que_no_existe() {
        // No hay `system prune` ni `prune` suelto; `--yes` no existe en down/volumes rm.
        for args in [
            &["system", "prune"][..],
            &["prune"],
            &["stacks", "down", "demo", "--yes"],
            &["volumes", "rm", "v", "--yes"],
            &["volumes", "prune", "--yes"],
            &["cleanup", "apply", "--prune"],
            &["logs"],
        ] {
            assert!(parse(args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn ayuda_menciona_los_grupos() {
        let help = Cli::command().render_help().to_string();
        for w in [
            "images",
            "volumes",
            "networks",
            "logs",
            "stacks",
            "cleanup",
            "completions",
            "--json",
        ] {
            assert!(help.contains(w), "falta {w} en la ayuda:\n{help}");
        }
    }

    #[test]
    fn completions_no_vacios_y_con_subcomandos() {
        use clap_complete::Shell;
        for shell in [Shell::Bash, Shell::Zsh, Shell::Fish] {
            let mut buf = Vec::new();
            let mut cmd = Cli::command();
            clap_complete::generate(shell, &mut cmd, "dockinng", &mut buf);
            let s = String::from_utf8(buf).unwrap();
            assert!(!s.is_empty());
            for sub in ["cleanup", "stacks", "images"] {
                assert!(s.contains(sub), "{shell:?} sin {sub}");
            }
        }
    }
}
