//! Constructor único de argumentos de `docker compose`. Nada pasa por un shell: el resultado
//! es `program + Vec<OsString>`, testeable sin lanzar procesos.

use std::ffi::OsString;
use std::path::PathBuf;

use crate::types::{ComposeFlavor, StackOpKind};

/// Segundos de gracia de `stop`/`down`/`restart` (`-t`). Los contenedores que ignoran SIGTERM
/// (p. ej. `sleep` como PID 1) tardan justo ese tiempo.
pub const STOP_TIMEOUT_SECS: u32 = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigFiles {
    /// Sin `-f`: Compose descubre el proyecto por nombre (`-p`) y las labels de sus recursos
    /// (stacks `discovered`; solo válido para `down`).
    None,
    Paths(Vec<PathBuf>),
    /// `-f -`: el YAML se entrega por stdin.
    Stdin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSpec {
    /// Nombre de proyecto (`-p`), ya validado.
    pub name: String,
    pub project_dir: Option<PathBuf>,
    pub files: ConfigFiles,
    pub env_file: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposeCmd {
    /// `config --format json` (interpolado; valida y da servicios).
    ConfigJson,
    /// `config -q`.
    ConfigQuiet,
    /// `ps -a --format json`.
    Ps,
    Down,
    Op {
        kind: StackOpKind,
        services: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressMode {
    /// Sin flag (comandos de lectura: sus errores salen como texto plano).
    None,
    Json,
    Plain,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: OsString,
    pub args: Vec<OsString>,
}

impl CommandSpec {
    /// Representación para logs y tests (NO se ejecuta).
    pub fn display(&self) -> String {
        let mut s = self.program.to_string_lossy().into_owned();
        for a in &self.args {
            s.push(' ');
            s.push_str(&a.to_string_lossy());
        }
        s
    }
}

fn base(flavor: ComposeFlavor) -> CommandSpec {
    match flavor {
        ComposeFlavor::Standalone => CommandSpec {
            program: "docker-compose".into(),
            args: Vec::new(),
        },
        _ => CommandSpec {
            program: "docker".into(),
            args: vec!["compose".into()],
        },
    }
}

/// `docker compose version --format json` (o `docker-compose version --format json`).
pub fn version_command(flavor: ComposeFlavor) -> CommandSpec {
    let mut c = base(flavor);
    c.args
        .extend(["version".into(), "--format".into(), "json".into()]);
    c
}

/// `docker --version`: solo comprueba que el CLI existe.
pub fn docker_cli_command() -> CommandSpec {
    CommandSpec {
        program: "docker".into(),
        args: vec!["--version".into()],
    }
}

/// Construye `docker compose --ansi never [--progress X] -p N --project-directory D -f F.. [--env-file E] <sub> [flags] [-- svc..]`.
pub fn build(
    flavor: ComposeFlavor,
    project: &ProjectSpec,
    cmd: &ComposeCmd,
    progress: ProgressMode,
) -> CommandSpec {
    let mut c = base(flavor);
    let a = &mut c.args;
    a.push("--ansi".into());
    a.push("never".into());
    match progress {
        ProgressMode::Json => {
            a.push("--progress".into());
            a.push("json".into());
        }
        ProgressMode::Plain => {
            a.push("--progress".into());
            a.push("plain".into());
        }
        ProgressMode::None => {}
    }
    // Nombre vacío = que Compose lo derive (`name:` del YAML o el directorio): solo al vincular.
    if !project.name.is_empty() {
        a.push("-p".into());
        a.push(project.name.clone().into());
    }
    if let Some(dir) = &project.project_dir {
        a.push("--project-directory".into());
        a.push(dir.clone().into());
    }
    match &project.files {
        ConfigFiles::None => {}
        ConfigFiles::Paths(paths) => {
            for p in paths {
                a.push("-f".into());
                a.push(p.clone().into());
            }
        }
        ConfigFiles::Stdin => {
            a.push("-f".into());
            a.push("-".into());
        }
    }
    if let Some(env) = &project.env_file {
        a.push("--env-file".into());
        a.push(env.clone().into());
    }
    let t = STOP_TIMEOUT_SECS.to_string();
    match cmd {
        ComposeCmd::ConfigJson => a.extend(["config".into(), "--format".into(), "json".into()]),
        ComposeCmd::ConfigQuiet => a.extend(["config".into(), "-q".into()]),
        ComposeCmd::Ps => a.extend(["ps".into(), "-a".into(), "--format".into(), "json".into()]),
        // NUNCA `-v`, `--rmi` ni `--remove-orphans`.
        ComposeCmd::Down => a.extend(["down".into(), "-t".into(), t.into()]),
        ComposeCmd::Op { kind, services } => {
            match kind {
                StackOpKind::Up => a.extend(["up".into(), "-d".into()]),
                StackOpKind::Restart => a.extend(["restart".into(), "-t".into(), t.into()]),
                StackOpKind::Stop => a.extend(["stop".into(), "-t".into(), t.into()]),
                StackOpKind::Start => a.push("start".into()),
                StackOpKind::Pull => a.push("pull".into()),
            }
            if !services.is_empty() {
                a.push("--".into());
                a.extend(services.iter().map(OsString::from));
            }
        }
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> ProjectSpec {
        ProjectSpec {
            name: "mi-stack".into(),
            project_dir: Some("/data/con espacios/ñandú".into()),
            files: ConfigFiles::Paths(vec!["/data/con espacios/ñandú/compose.yaml".into()]),
            env_file: Some("/data/con espacios/ñandú/.env".into()),
        }
    }

    fn strs(c: &CommandSpec) -> Vec<String> {
        c.args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn up_snapshot_orden_exacto() {
        let c = build(
            ComposeFlavor::Plugin,
            &project(),
            &ComposeCmd::Op {
                kind: StackOpKind::Up,
                services: vec!["web".into(), "db".into()],
            },
            ProgressMode::Json,
        );
        assert_eq!(c.program, "docker");
        assert_eq!(
            strs(&c),
            [
                "compose",
                "--ansi",
                "never",
                "--progress",
                "json",
                "-p",
                "mi-stack",
                "--project-directory",
                "/data/con espacios/ñandú",
                "-f",
                "/data/con espacios/ñandú/compose.yaml",
                "--env-file",
                "/data/con espacios/ñandú/.env",
                "up",
                "-d",
                "--",
                "web",
                "db"
            ]
        );
    }

    #[test]
    fn progress_es_global_y_va_antes_del_subcomando() {
        for kind in [
            StackOpKind::Up,
            StackOpKind::Restart,
            StackOpKind::Stop,
            StackOpKind::Start,
            StackOpKind::Pull,
        ] {
            let c = build(
                ComposeFlavor::Plugin,
                &project(),
                &ComposeCmd::Op {
                    kind,
                    services: vec![],
                },
                ProgressMode::Json,
            );
            let v = strs(&c);
            let p = v.iter().position(|x| x == "--progress").unwrap();
            let sub = v.iter().position(|x| x == kind.as_str()).unwrap();
            assert!(p < sub, "{v:?}");
            assert!(!v.contains(&"--".to_string()), "sin servicios no hay `--`");
        }
    }

    #[test]
    fn nunca_flags_destructivos_ni_shell() {
        let mut all = vec![build(
            ComposeFlavor::Plugin,
            &project(),
            &ComposeCmd::Down,
            ProgressMode::Json,
        )];
        for kind in [
            StackOpKind::Up,
            StackOpKind::Restart,
            StackOpKind::Stop,
            StackOpKind::Start,
            StackOpKind::Pull,
        ] {
            all.push(build(
                ComposeFlavor::Standalone,
                &project(),
                &ComposeCmd::Op {
                    kind,
                    services: vec!["a".into()],
                },
                ProgressMode::Plain,
            ));
        }
        for c in all {
            let v = strs(&c);
            for bad in [
                "-v",
                "--volumes",
                "--rmi",
                "--remove-orphans",
                "--force-recreate",
                "sh",
                "-c",
            ] {
                assert!(!v.iter().any(|x| x == bad), "{bad} en {v:?}");
            }
            assert!(c.program == "docker" || c.program == "docker-compose");
        }
    }

    #[test]
    fn down_con_timeout_y_lectura_sin_progress() {
        let c = build(
            ComposeFlavor::Plugin,
            &project(),
            &ComposeCmd::Down,
            ProgressMode::Json,
        );
        assert!(strs(&c).join(" ").ends_with("down -t 10"));
        let c = build(
            ComposeFlavor::Plugin,
            &project(),
            &ComposeCmd::ConfigJson,
            ProgressMode::None,
        );
        assert!(!strs(&c).contains(&"--progress".to_string()));
        assert!(strs(&c).join(" ").ends_with("config --format json"));
        let c = build(
            ComposeFlavor::Plugin,
            &project(),
            &ComposeCmd::Ps,
            ProgressMode::None,
        );
        assert!(strs(&c).join(" ").ends_with("ps -a --format json"));
    }

    #[test]
    fn stdin_y_standalone() {
        let mut p = project();
        p.files = ConfigFiles::Stdin;
        p.env_file = None;
        let c = build(
            ComposeFlavor::Standalone,
            &p,
            &ComposeCmd::ConfigJson,
            ProgressMode::None,
        );
        assert_eq!(c.program, "docker-compose");
        let v = strs(&c);
        assert_eq!(v[0], "--ansi");
        assert!(v.windows(2).any(|w| w == ["-f", "-"]));
        assert!(!v.contains(&"--env-file".to_string()));
    }

    #[test]
    fn servicio_con_forma_de_flag_queda_tras_doble_guion() {
        // La validación de nombres lo rechaza antes; aquí se comprueba la defensa en profundidad.
        let c = build(
            ComposeFlavor::Plugin,
            &project(),
            &ComposeCmd::Op {
                kind: StackOpKind::Start,
                services: vec!["--evil".into()],
            },
            ProgressMode::Json,
        );
        let v = strs(&c);
        let sep = v.iter().position(|x| x == "--").unwrap();
        assert_eq!(v[sep + 1], "--evil");
    }

    #[test]
    fn descubierto_sin_archivos() {
        let p = ProjectSpec {
            name: "otro".into(),
            project_dir: None,
            files: ConfigFiles::None,
            env_file: None,
        };
        let c = build(
            ComposeFlavor::Plugin,
            &p,
            &ComposeCmd::Down,
            ProgressMode::Json,
        );
        assert_eq!(
            strs(&c),
            [
                "compose",
                "--ansi",
                "never",
                "--progress",
                "json",
                "-p",
                "otro",
                "down",
                "-t",
                "10"
            ]
        );
    }

    #[test]
    fn version() {
        assert_eq!(
            strs(&version_command(ComposeFlavor::Plugin)),
            ["compose", "version", "--format", "json"]
        );
        assert_eq!(
            version_command(ComposeFlavor::Standalone).program,
            "docker-compose"
        );
    }
}
