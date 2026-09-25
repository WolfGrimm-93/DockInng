//! CLI `dockinng`: adaptador de línea de comandos sobre el mismo núcleo que usa la GUI.

use std::io::{self, IsTerminal, Write};
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use engine_core::{
    Action, ConfirmationPolicy, ConnectionCause, ConnectionStatus, Container, Decision, DenyReason,
    DiagStepId, EngineClient, Interactivity, StepStatus,
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
    /// Reinicia un contenedor
    Restart { id: String },
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

    // El motor se construye sin fallar; los errores de conexión salen en cada llamada.
    let engine = DockerEngine::new();
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
        Command::Restart { id } => {
            engine
                .restart_container(&id)
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
            match ConfirmationPolicy::decide(&action, interactivity, yes) {
                Decision::Allow => {}
                Decision::Confirm => {
                    if !ask(&format!("¿Eliminar el contenedor {id}?")) {
                        return Err("cancelado por el usuario".into());
                    }
                }
                Decision::ConfirmTyped { expected } => {
                    if !ask_typed(&expected) {
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

/// Confirmación escrita: hay que teclear exactamente lo que se pide. Cualquier otra cosa cancela.
fn ask_typed(expected: &str) -> bool {
    print!("Escribe «{expected}» para confirmar: ");
    let _ = io::stdout().flush();
    let mut answer = String::new();
    if io::stdin().read_line(&mut answer).is_err() {
        return false;
    }
    Decision::ConfirmTyped {
        expected: expected.to_string(),
    }
    .accepts(Some(&answer))
}

/// Ancho máximo de las columnas nombre e imagen.
const MAX_NAME: usize = 32;
const MAX_IMAGE: usize = 40;

/// Recorta a `max` caracteres con `…` (cuenta caracteres, no bytes).
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Formatea la tabla de `ps`: anchos por columna según el contenido (con tope) y la imagen
/// truncada. Función pura, sin TTY: la salida es la misma en modo no interactivo.
fn format_containers(containers: &[Container]) -> Vec<String> {
    let rows: Vec<[String; 4]> = containers
        .iter()
        .map(|c| {
            [
                c.id.chars().take(12).collect(),
                truncate(c.names.first().map(String::as_str).unwrap_or("-"), MAX_NAME),
                truncate(&c.image, MAX_IMAGE),
                c.status.clone(),
            ]
        })
        .collect();
    let header = [
        "ID".to_string(),
        "NOMBRE".into(),
        "IMAGEN".into(),
        "ESTADO".into(),
    ];
    let widths: Vec<usize> = (0..3)
        .map(|i| {
            rows.iter()
                .map(|r| r[i].chars().count())
                .chain(std::iter::once(header[i].chars().count()))
                .max()
                .unwrap_or(0)
        })
        .collect();
    std::iter::once(&header)
        .chain(rows.iter())
        .map(|r| {
            format!(
                "{:<w0$}  {:<w1$}  {:<w2$}  {}",
                r[0],
                r[1],
                r[2],
                r[3],
                w0 = widths[0],
                w1 = widths[1],
                w2 = widths[2]
            )
        })
        .collect()
}

fn print_containers(containers: &[Container]) {
    // writeln en vez de println: si la salida se corta (`| head`) salimos sin panic.
    let mut out = io::stdout().lock();
    for line in format_containers(containers) {
        if writeln!(out, "{line}").is_err() {
            return;
        }
    }
}

/// Diagnóstico de la conexión: consume `EngineClient::diagnose`, la misma fuente que la GUI.
async fn doctor() -> Result<(), String> {
    match std::env::var("DOCKER_HOST") {
        Ok(h) => println!("• DOCKER_HOST = {h}"),
        Err(_) => println!("• DOCKER_HOST no definido (se usa el socket local)"),
    }
    let engine = DockerEngine::new();
    match engine.diagnose().await {
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
                ConnectionCause::Other => {}
            }
            Err(format!("el motor no está disponible: {message}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use engine_core::ContainerState;

    use super::*;

    fn c(id: &str, name: &str, image: &str, status: &str) -> Container {
        Container {
            id: id.into(),
            names: if name.is_empty() {
                vec![]
            } else {
                vec![name.into()]
            },
            image: image.into(),
            image_id: String::new(),
            state: ContainerState::Running,
            status: status.into(),
            created: 0,
            compose_project: None,
            compose_service: None,
            ports: vec![],
            mounts: vec![],
            networks: vec![],
            endpoints: vec![],
        }
    }

    #[test]
    fn truncado_con_puntos_suspensivos_por_caracteres() {
        assert_eq!(truncate("corto", 10), "corto");
        assert_eq!(truncate("abcdefghij", 10), "abcdefghij");
        assert_eq!(truncate("abcdefghijk", 10), "abcdefghi…");
        // Caracteres multibyte: no corta a mitad de un carácter.
        assert_eq!(truncate("ñandú-ñandú", 5), "ñand…");
    }

    #[test]
    fn columnas_alineadas_aunque_la_imagen_sea_larga() {
        let largo = "clamav/clamav:stable@sha256:0e31ce089574268aefa0b543767d66b70240ab51ed49eec53e07f18d5629d817";
        let lines = format_containers(&[
            c(
                "8d8ab4a11854aaaa",
                "filemeshy-clamav-1",
                largo,
                "Up 5 hours",
            ),
            c("b7e0", "", "nginx", "Exited"),
        ]);
        assert_eq!(lines.len(), 3);
        // La columna ESTADO empieza en la misma posición en todas las filas.
        let pos: Vec<usize> = ["ESTADO", "Up 5 hours", "Exited"]
            .iter()
            .zip(&lines)
            .map(|(needle, l)| l.chars().count() - needle.chars().count())
            .collect();
        assert!(pos.iter().all(|p| *p == pos[0]), "{lines:#?}");
        assert!(lines[1].contains('…'));
        assert!(lines[1].starts_with("8d8ab4a11854  "));
        assert!(lines[2].contains(" -  "), "sin nombre se muestra '-'");
    }

    #[test]
    fn sin_contenedores_solo_cabecera() {
        let l = format_containers(&[]);
        assert_eq!(l.len(), 1);
        assert!(l[0].starts_with("ID") && l[0].ends_with("ESTADO"));
    }
}
