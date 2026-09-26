//! Construcción PURA de los argumentos de `ssh` (y `ssh-keyscan`). Es la pieza que fija el
//! modelo de seguridad, así que se prueba por instantáneas.
//!
//! Reglas fijas: `StrictHostKeyChecking=yes` con `known_hosts` PROPIO (nunca el del usuario),
//! `BatchMode=yes` (jamás se pide contraseña ni passphrase), sin reenvíos, sin agente
//! reenviado, sin comandos locales, host tras `--`. Nunca se lee ni copia una llave privada:
//! solo se pasa su ruta a `ssh`.

use std::ffi::OsString;
use std::path::Path;

use engine_core::connections::{
    validate_host, validate_port, validate_spec, validate_ssh_path, validate_user,
};
use engine_core::{ConnSpec, EngineError, SshIdentity, SshMode};

/// Segundos de espera de conexión.
pub const CONNECT_TIMEOUT_SECS: u32 = 10;

/// Destino SSH ya validado y con el host sin corchetes (formato que espera `ssh`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTarget {
    /// Host o alias, sin corchetes IPv6.
    pub host: String,
    /// `None` = lo decide la configuración de ssh (solo modo alias).
    pub port: Option<u16>,
    pub user: Option<String>,
    pub mode: SshMode,
    pub identity: SshIdentity,
}

impl SshTarget {
    /// Valida la especificación y extrae el destino. Falla con `InvalidInput` si no es SSH.
    pub fn from_spec(spec: &ConnSpec) -> Result<Self, EngineError> {
        validate_spec(spec)?;
        let ConnSpec::Ssh {
            host,
            port,
            user,
            mode,
            identity,
            ..
        } = spec
        else {
            return Err(EngineError::InvalidInput(
                "la conexión no es de tipo SSH".into(),
            ));
        };
        Ok(Self {
            host: strip_brackets(host).to_string(),
            port: if *port == 0 {
                None
            } else {
                Some(validate_port(*port)?)
            },
            user: if user.is_empty() {
                None
            } else {
                Some(user.clone())
            },
            mode: *mode,
            identity: identity.clone(),
        })
    }

    /// Nombre bajo el que `ssh` busca la clave en `known_hosts`: el host tal cual en el puerto
    /// 22 y `[host]:puerto` en cualquier otro. En modo alias se usa el alias (ver
    /// `HostKeyAlias` en `ssh_dial_args`), así la búsqueda no depende de la resolución.
    pub fn known_hosts_name(&self) -> String {
        let host = self.host.to_ascii_lowercase();
        match (self.mode, self.port) {
            (SshMode::Alias, _) | (_, None) | (_, Some(22)) => host,
            (_, Some(p)) => format!("[{host}]:{p}"),
        }
    }
}

fn strip_brackets(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
}

/// Opciones `-o` comunes que endurecen cualquier invocación de `ssh`.
fn hardening(known_hosts: &Path) -> Vec<OsString> {
    let mut a: Vec<OsString> = Vec::new();
    let mut opt = |kv: String| {
        a.push("-o".into());
        a.push(kv.into());
    };
    opt("BatchMode=yes".into());
    opt("StrictHostKeyChecking=yes".into());
    opt(format!("UserKnownHostsFile={}", known_hosts.display()));
    opt("GlobalKnownHostsFile=/dev/null".into());
    opt("HashKnownHosts=no".into());
    opt("CheckHostIP=no".into());
    opt("VerifyHostKeyDNS=no".into());
    opt("UpdateHostKeys=no".into());
    opt("PasswordAuthentication=no".into());
    opt("KbdInteractiveAuthentication=no".into());
    opt("NumberOfPasswordPrompts=0".into());
    opt("ClearAllForwardings=yes".into());
    opt("ForwardAgent=no".into());
    opt("ForwardX11=no".into());
    opt("PermitLocalCommand=no".into());
    opt("ControlMaster=no".into());
    opt("ControlPath=none".into());
    opt("LogLevel=ERROR".into());
    opt(format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}"));
    opt("ServerAliveInterval=15".into());
    opt("ServerAliveCountMax=3".into());
    a
}

/// Argumentos completos de `ssh` para `docker system dial-stdio` en el host remoto.
/// `docker_bin` es el ejecutable remoto (por defecto `docker`).
pub fn ssh_dial_args(
    target: &SshTarget,
    known_hosts: &Path,
    docker_bin: &str,
) -> Result<Vec<OsString>, EngineError> {
    validate_host(&target.host).or_else(|_| validate_host(&format!("[{}]", target.host)))?;
    if !docker_bin_ok(docker_bin) {
        return Err(EngineError::InvalidInput(
            "ejecutable remoto inválido".into(),
        ));
    }
    validate_ssh_path(&known_hosts.to_string_lossy(), "known_hosts")?;
    let mut args = hardening(known_hosts);
    args.push("-T".into());
    if target.mode == SshMode::Explicit {
        // Sin configuración de ssh: el resultado no depende de `~/.ssh/config`.
        args.push("-F".into());
        args.push("/dev/null".into());
    } else {
        // Un alias comparte entrada de known_hosts bajo su propio nombre.
        args.push("-o".into());
        args.push(format!("HostKeyAlias={}", target.host.to_ascii_lowercase()).into());
    }
    match &target.identity {
        SshIdentity::File { path } => {
            validate_ssh_path(path, "llave privada")?;
            args.push("-o".into());
            args.push("IdentitiesOnly=yes".into());
            args.push("-i".into());
            args.push(path.into());
        }
        SshIdentity::Agent if target.mode == SshMode::Explicit => {
            // Con IdentityFile explícito ssh no prueba las llaves por defecto de `~/.ssh`:
            // solo se ofrecen las identidades del agente.
            args.push("-o".into());
            args.push("IdentityFile=/dev/null".into());
        }
        SshIdentity::Agent => {}
    }
    if let Some(p) = target.port {
        args.push("-p".into());
        args.push(p.to_string().into());
    }
    if let Some(u) = &target.user {
        validate_user(u)?;
        args.push("-l".into());
        args.push(u.into());
    }
    args.push("--".into());
    args.push((&target.host).into());
    args.push(docker_bin.into());
    args.push("system".into());
    args.push("dial-stdio".into());
    Ok(args)
}

/// `docker` o una ruta simple: sin espacios ni metacaracteres de shell (la ejecuta un shell remoto).
fn docker_bin_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'.' | b'-'))
}

/// Argumentos de `ssh-keyscan` (solo lectura de claves públicas del servidor).
pub fn keyscan_args(host: &str, port: u16) -> Result<Vec<OsString>, EngineError> {
    validate_host(&format!("[{host}]")).or_else(|_| validate_host(host))?;
    Ok(vec![
        "-T".into(),
        "5".into(),
        "-p".into(),
        port.to_string().into(),
        "-t".into(),
        "ed25519,ecdsa,rsa".into(),
        "--".into(),
        host.into(),
    ])
}

/// Argumentos de `ssh -G` para resolver un alias (solo a petición explícita del usuario).
pub fn resolve_alias_args(alias: &str) -> Result<Vec<OsString>, EngineError> {
    validate_host(alias)?;
    Ok(vec!["-G".into(), "--".into(), alias.into()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn kh() -> PathBuf {
        PathBuf::from("/data/dockinng/known_hosts")
    }

    fn explicit(host: &str, port: u16, user: &str, id: SshIdentity) -> SshTarget {
        SshTarget {
            host: host.into(),
            port: Some(port),
            user: Some(user.into()),
            mode: SshMode::Explicit,
            identity: id,
        }
    }

    fn strings(a: Vec<OsString>) -> Vec<String> {
        a.into_iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn instantanea_explicit_con_llave() {
        let t = explicit(
            "example.com",
            2222,
            "deploy",
            SshIdentity::File {
                path: "/k/id_ed25519".into(),
            },
        );
        let a = strings(ssh_dial_args(&t, &kh(), "docker").unwrap());
        let expected = [
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "UserKnownHostsFile=/data/dockinng/known_hosts",
            "-o",
            "GlobalKnownHostsFile=/dev/null",
            "-o",
            "HashKnownHosts=no",
            "-o",
            "CheckHostIP=no",
            "-o",
            "VerifyHostKeyDNS=no",
            "-o",
            "UpdateHostKeys=no",
            "-o",
            "PasswordAuthentication=no",
            "-o",
            "KbdInteractiveAuthentication=no",
            "-o",
            "NumberOfPasswordPrompts=0",
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "ForwardAgent=no",
            "-o",
            "ForwardX11=no",
            "-o",
            "PermitLocalCommand=no",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "LogLevel=ERROR",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "-T",
            "-F",
            "/dev/null",
            "-o",
            "IdentitiesOnly=yes",
            "-i",
            "/k/id_ed25519",
            "-p",
            "2222",
            "-l",
            "deploy",
            "--",
            "example.com",
            "docker",
            "system",
            "dial-stdio",
        ];
        assert_eq!(a, expected);
    }

    #[test]
    fn agente_no_prueba_llaves_por_defecto() {
        let t = explicit("h.example", 22, "u", SshIdentity::Agent);
        let a = strings(ssh_dial_args(&t, &kh(), "docker").unwrap());
        assert!(a.windows(2).any(|w| w == ["-o", "IdentityFile=/dev/null"]));
        assert!(!a.iter().any(|x| x == "-i"));
    }

    #[test]
    fn modo_alias_no_fuerza_f_y_usa_alias_para_la_clave() {
        let t = SshTarget {
            host: "MiServer".into(),
            port: None,
            user: None,
            mode: SshMode::Alias,
            identity: SshIdentity::Agent,
        };
        let a = strings(ssh_dial_args(&t, &kh(), "docker").unwrap());
        assert!(!a.iter().any(|x| x == "-F"));
        assert!(!a.iter().any(|x| x == "-p" || x == "-l"));
        assert!(a.iter().any(|x| x == "HostKeyAlias=miserver"));
        // Siguen forzados los ajustes de seguridad.
        assert!(a.iter().any(|x| x == "StrictHostKeyChecking=yes"));
        assert_eq!(t.known_hosts_name(), "miserver");
    }

    #[test]
    fn invariantes_de_seguridad_en_cualquier_combinacion() {
        for id in [
            SshIdentity::Agent,
            SshIdentity::File {
                path: "/k/id".into(),
            },
        ] {
            for mode in [SshMode::Explicit, SshMode::Alias] {
                let t = SshTarget {
                    host: "h.example".into(),
                    port: Some(22),
                    user: Some("u".into()),
                    mode,
                    identity: id.clone(),
                };
                let a = strings(ssh_dial_args(&t, &kh(), "docker").unwrap());
                let joined = a.join(" ");
                assert!(joined.contains("StrictHostKeyChecking=yes"));
                assert!(joined.contains("BatchMode=yes"));
                assert!(!joined.contains("StrictHostKeyChecking=no"));
                assert!(!joined.contains("accept-new"));
                assert!(!joined.contains("UserKnownHostsFile=/dev/null"));
                // `--` inmediatamente antes del host; el host es el último argumento de ssh.
                let pos = a.iter().position(|x| x == "--").unwrap();
                assert_eq!(a[pos + 1], "h.example");
                assert_eq!(&a[pos + 2..], ["docker", "system", "dial-stdio"]);
            }
        }
    }

    #[test]
    fn host_hostil_no_llega_a_ssh() {
        for bad in ["-oProxyCommand=touch /tmp/x", "a b", "a;b", "$(x)", ""] {
            let t = explicit(bad, 22, "u", SshIdentity::Agent);
            assert!(ssh_dial_args(&t, &kh(), "docker").is_err(), "{bad}");
        }
        let t = explicit("h", 22, "u", SshIdentity::Agent);
        for bad in ["docker; rm -rf /", "", "a b", "$(x)"] {
            assert!(ssh_dial_args(&t, &kh(), bad).is_err(), "{bad}");
        }
        let t = explicit("h", 22, "bad user", SshIdentity::Agent);
        assert!(ssh_dial_args(&t, &kh(), "docker").is_err());
        let t = explicit(
            "h",
            22,
            "u",
            SshIdentity::File {
                path: "rel/id".into(),
            },
        );
        assert!(ssh_dial_args(&t, &kh(), "docker").is_err());
    }

    #[test]
    fn rutas_con_percent_o_espacios_no_llegan_a_ssh() {
        let t = explicit(
            "h",
            22,
            "u",
            SshIdentity::File {
                path: "/k/id".into(),
            },
        );
        for bad in ["/data/%h/known_hosts", "/da ta/known_hosts", "/d\"x/kh"] {
            assert!(
                ssh_dial_args(&t, Path::new(bad), "docker").is_err(),
                "{bad}"
            );
        }
        let t = explicit(
            "h",
            22,
            "u",
            SshIdentity::File {
                path: "/k/%d/id".into(),
            },
        );
        assert!(ssh_dial_args(&t, &kh(), "docker").is_err());
    }

    #[test]
    fn known_hosts_name_por_puerto_e_ipv6() {
        let a = explicit("Example.COM", 22, "u", SshIdentity::Agent);
        assert_eq!(a.known_hosts_name(), "example.com");
        let b = explicit("example.com", 2222, "u", SshIdentity::Agent);
        assert_eq!(b.known_hosts_name(), "[example.com]:2222");
        let spec = ConnSpec::Ssh {
            name: "n".into(),
            host: "[::1]".into(),
            port: 2200,
            user: "u".into(),
            mode: SshMode::Explicit,
            identity: SshIdentity::Agent,
        };
        let t = SshTarget::from_spec(&spec).unwrap();
        assert_eq!(t.host, "::1");
        assert_eq!(t.known_hosts_name(), "[::1]:2200");
        assert!(ssh_dial_args(&t, &kh(), "docker").is_ok());
    }

    #[test]
    fn from_spec_rechaza_tls_y_specs_invalidas() {
        let tls = ConnSpec::Tls {
            name: "t".into(),
            host: "h".into(),
            port: 2376,
            ca_path: "/a".into(),
            cert_path: "/b".into(),
            key_path: "/c".into(),
        };
        assert!(SshTarget::from_spec(&tls).is_err());
    }

    #[test]
    fn keyscan_y_alias_args() {
        let a = strings(keyscan_args("example.com", 2222).unwrap());
        assert_eq!(
            a,
            [
                "-T",
                "5",
                "-p",
                "2222",
                "-t",
                "ed25519,ecdsa,rsa",
                "--",
                "example.com"
            ]
        );
        assert!(keyscan_args("-x", 22).is_err());
        assert_eq!(
            strings(resolve_alias_args("web").unwrap()),
            ["-G", "--", "web"]
        );
        assert!(resolve_alias_args("-x").is_err());
    }
}
