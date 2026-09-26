//! Definición de la línea de comandos (clap derive). Sin lógica: solo forma y ayuda.

use clap::{Args, Parser, Subcommand};
use clap_complete::Shell;

#[derive(Parser)]
#[command(
    name = "dockinng",
    version,
    about = "Administra Docker desde la terminal",
    long_about = "Administra Docker desde la terminal. Comparte el núcleo con la app de escritorio: \
las acciones destructivas siguen la misma política de confirmación (plan, confirmación y \
ejecución por elemento)."
)]
pub struct Cli {
    /// Salida en JSON (listados, planes y progreso en NDJSON)
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub command: Command,
}

/// Confirmación no interactiva. `--yes` solo salta las confirmaciones simples: la confirmación
/// escrita (volúmenes, `stacks down`) y el borrado masivo de imágenes exigen una terminal.
#[derive(Args, Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Confirm {
    /// Confirmar sin preguntar (no salta la confirmación escrita)
    #[arg(short, long)]
    pub yes: bool,
}

#[derive(Subcommand)]
pub enum Command {
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
        #[command(flatten)]
        confirm: Confirm,
    },
    /// Diagnostica la conexión con el motor
    Doctor,
    /// Imágenes: listar, descargar, borrar, limpiar y construir
    #[command(subcommand)]
    Images(ImagesCmd),
    /// Volúmenes: listar, crear, borrar y limpiar
    #[command(subcommand)]
    Volumes(VolumesCmd),
    /// Redes: listar, crear y borrar
    #[command(subcommand)]
    Networks(NetworksCmd),
    /// Muestra los registros (logs) de un contenedor
    Logs {
        id: String,
        /// Seguir la salida (Ctrl-C para salir)
        #[arg(short, long)]
        follow: bool,
        /// Últimas N líneas
        #[arg(long, value_name = "N")]
        tail: Option<u32>,
    },
    /// Stacks de Compose
    #[command(subcommand)]
    Stacks(StacksCmd),
    /// Limpieza guiada: plan de solo lectura y ejecución por elemento (nunca un prune)
    #[command(subcommand)]
    Cleanup(CleanupCmd),
    /// Conexiones guardadas (perfiles SSH/TLS de la app)
    #[command(subcommand)]
    Context(ContextCmd),
    /// Genera el script de autocompletado para una shell
    Completions { shell: Shell },
}

#[derive(Subcommand)]
pub enum ImagesCmd {
    /// Lista imágenes
    Ls,
    /// Descarga una imagen
    Pull { reference: String },
    /// Elimina una imagen (pide confirmación)
    Rm {
        reference: String,
        #[command(flatten)]
        confirm: Confirm,
    },
    /// Elimina las imágenes sin usar, una por una (exige terminal: --yes no basta)
    Prune {
        #[command(flatten)]
        confirm: Confirm,
    },
    /// Construye una imagen con `docker build`
    Build {
        /// Directorio de contexto
        context: String,
        /// Dockerfile relativo al contexto
        #[arg(short = 'f', long = "file")]
        file: Option<String>,
        /// Etiqueta de la imagen (`nombre:tag`)
        #[arg(short, long)]
        tag: Option<String>,
        /// `NOMBRE=VALOR` (repetible); el valor no se muestra ni se registra
        #[arg(long = "build-arg", value_name = "NOMBRE=VALOR")]
        build_args: Vec<String>,
        /// Etapa objetivo del Dockerfile
        #[arg(long)]
        target: Option<String>,
        /// No usar la caché
        #[arg(long)]
        no_cache: bool,
        /// Descargar siempre la imagen base (usa red)
        #[arg(long)]
        pull: bool,
        #[command(flatten)]
        confirm: Confirm,
    },
}

#[derive(Subcommand)]
pub enum VolumesCmd {
    /// Lista volúmenes
    Ls,
    /// Crea un volumen
    Create {
        name: String,
        /// `clave=valor` (repetible)
        #[arg(long = "label", value_name = "CLAVE=VALOR")]
        labels: Vec<String>,
    },
    /// Elimina un volumen (confirmación escrita: su nombre)
    Rm { name: String },
    /// Elimina los volúmenes sin usar, uno por uno (confirmación escrita: ELIMINAR)
    Prune,
}

#[derive(Subcommand)]
pub enum NetworksCmd {
    /// Lista redes
    Ls,
    /// Crea una red
    Create {
        name: String,
        /// `clave=valor` (repetible)
        #[arg(long = "label", value_name = "CLAVE=VALOR")]
        labels: Vec<String>,
    },
    /// Elimina una red (pide confirmación)
    Rm {
        id: String,
        #[command(flatten)]
        confirm: Confirm,
    },
}

#[derive(Subcommand)]
pub enum StacksCmd {
    /// Lista los stacks
    Ls,
    /// Levanta un stack (`docker compose up -d`)
    Up(StackTarget),
    /// Baja un stack (confirmación escrita: su nombre; nunca borra volúmenes)
    Down { name: String },
    /// Reinicia un stack
    Restart(StackTarget),
    /// Detiene un stack
    Stop(StackTarget),
    /// Inicia un stack detenido
    Start(StackTarget),
    /// Descarga las imágenes de un stack
    Pull(StackTarget),
}

#[derive(Args, Debug, Clone)]
pub struct StackTarget {
    pub name: String,
    /// Limitar a estos servicios (repetible)
    #[arg(short, long = "service")]
    pub services: Vec<String>,
}

#[derive(Subcommand)]
pub enum CleanupCmd {
    /// Muestra qué se puede recuperar (solo lectura)
    Plan {
        /// Antigüedad mínima (días) de las imágenes sin usar
        #[arg(long, default_value_t = 0)]
        min_age_days: u32,
    },
    /// Ejecuta una selección concreta, elemento a elemento
    Apply {
        /// Marca lo recomendado por el plan (sin volúmenes)
        #[arg(long)]
        defaults: bool,
        /// Antigüedad mínima (días) para `--defaults`
        #[arg(long, default_value_t = 0)]
        min_age_days: u32,
        /// Id de un contenedor detenido (repetible)
        #[arg(long = "container")]
        containers: Vec<String>,
        /// Referencia o id de una imagen sin usar (repetible)
        #[arg(long = "image")]
        images: Vec<String>,
        /// Nombre de un volumen sin usar (repetible; exige confirmación escrita)
        #[arg(long = "volume")]
        volumes: Vec<String>,
        /// Id de una red sin contenedores (repetible)
        #[arg(long = "network")]
        networks: Vec<String>,
        #[command(flatten)]
        confirm: Confirm,
    },
}

#[derive(Subcommand)]
pub enum ContextCmd {
    /// Lista las conexiones guardadas
    Ls,
    /// Elimina una conexión guardada por nombre o id (no toca el servidor)
    Rm {
        target: String,
        #[command(flatten)]
        confirm: Confirm,
    },
}
