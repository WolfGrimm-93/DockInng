//! CLI `dockinng`: adaptador de línea de comandos sobre el mismo núcleo que usa la GUI.

use std::io::{self, IsTerminal, Write};
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use engine_core::{
    Action, ConfirmationPolicy, Container, Decision, DenyReason, EngineClient, Interactivity,
};
use engine_docker::DockerEngine;

#[derive(Parser)]
#[command(
    name = "dockinng",
    version,
    about = "Administra Docker desde la terminal"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Lista contenedores
    Ps {
        /// Incluir los detenidos
        #[arg(short, long)]
        all: bool,
    },
    /// Inicia un contenedor
    Start { id: String },
    /// Detiene un contenedor
    Stop { id: String },
    /// Elimina un contenedor (pide confirmación)
    Rm {
        id: String,
        /// Forzar aunque esté corriendo
        #[arg(short, long)]
        force: bool,
        /// Confirmar sin preguntar
        #[arg(short, long)]
        yes: bool,
    },
    /// Diagnostica la conexión con el motor
    Doctor,
}

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
    if let Command::Doctor = cli.command {
        return doctor().await;
    }

    let engine = DockerEngine::connect().map_err(|e| e.to_string())?;
    match cli.command {
        Command::Ps { all } => {
            let containers = engine
                .list_containers(all)
                .await
                .map_err(|e| e.to_string())?;
            print_containers(&containers);
        }
        Command::Start { id } => {
            engine
                .start_container(&id)
                .await
                .map_err(|e| e.to_string())?;
            println!("{id}");
        }
        Command::Stop { id } => {
            engine
                .stop_container(&id)
                .await
                .map_err(|e| e.to_string())?;
            println!("{id}");
        }
        Command::Rm { id, force, yes } => {
            let action = Action::RemoveContainer { force };
            let interactivity = if io::stdin().is_terminal() {
                Interactivity::Interactive
            } else {
                Interactivity::NonInteractive
            };
            match ConfirmationPolicy::decide(action, interactivity, yes) {
                Decision::Allow => {}
                Decision::Confirm => {
                    if !ask(&format!("¿Eliminar el contenedor {id}?")) {
                        return Err("cancelado por el usuario".into());
                    }
                }
                Decision::Deny(DenyReason::Forbidden) => {
                    return Err("acción prohibida por la política de seguridad".into());
                }
                Decision::Deny(DenyReason::NeedsConfirmationNonInteractive) => {
                    return Err(
                        "requiere confirmación: usa --yes o ejecútalo en una terminal".into(),
                    );
                }
            }
            engine
                .remove_container(&id, force)
                .await
                .map_err(|e| e.to_string())?;
            println!("{id}");
        }
        Command::Doctor => unreachable!(),
    }
    Ok(())
}

/// Pregunta sí/no; cualquier cosa distinta de "s"/"si"/"y"/"yes" es no (deny por defecto).
fn ask(question: &str) -> bool {
    print!("{question} [s/N] ");
    let _ = io::stdout().flush();
    let mut answer = String::new();
    if io::stdin().read_line(&mut answer).is_err() {
        return false;
    }
    matches!(
        answer.trim().to_lowercase().as_str(),
        "s" | "si" | "sí" | "y" | "yes"
    )
}

fn print_containers(containers: &[Container]) {
    // writeln en vez de println: si la salida se corta (`| head`) salimos sin panic.
    let mut out = io::stdout().lock();
    if writeln!(out, "{:<14} {:<28} {:<28} ESTADO", "ID", "NOMBRE", "IMAGEN").is_err() {
        return;
    }
    for c in containers {
        let short_id: String = c.id.chars().take(12).collect();
        let line = writeln!(
            out,
            "{:<14} {:<28} {:<28} {}",
            short_id,
            c.names.first().map(String::as_str).unwrap_or("-"),
            c.image,
            c.status
        );
        if line.is_err() {
            return;
        }
    }
}

/// Comprueba paso a paso por qué podría no conectar: variable, socket, permisos, respuesta.
async fn doctor() -> Result<(), String> {
    let host = std::env::var("DOCKER_HOST").ok();
    match &host {
        Some(h) => println!("• DOCKER_HOST = {h}"),
        None => println!("• DOCKER_HOST no definido (se usa el socket local)"),
    }

    if host.is_none() {
        let socket = "/var/run/docker.sock";
        match std::fs::metadata(socket) {
            Ok(_) => println!("✓ existe {socket}"),
            Err(e) => {
                println!("✗ no se puede acceder a {socket}: {e}");
                println!("  ¿Está corriendo el daemon? (systemctl status docker)");
            }
        }
    }

    let engine = DockerEngine::connect().map_err(|e| e.to_string())?;
    match engine.ping().await {
        Ok(()) => println!("✓ el daemon responde"),
        Err(e) => {
            println!("✗ {e}");
            println!("  Si es un problema de permisos, agrega tu usuario al grupo docker.");
            return Err("el motor no está disponible".into());
        }
    }
    let info = engine.info().await.map_err(|e| e.to_string())?;
    println!(
        "✓ Docker {} (API {}) en {}/{}",
        info.version, info.api_version, info.os, info.arch
    );
    Ok(())
}
