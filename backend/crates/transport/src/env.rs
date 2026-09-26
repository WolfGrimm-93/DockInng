//! Entorno mínimo para los procesos `ssh`, `ssh-keyscan` y `ssh-keygen`.
//!
//! Se limpia todo el entorno heredado (nada de `SSH_ASKPASS`, `LD_PRELOAD`, `GIT_SSH_COMMAND`,
//! `DISPLAY`, ...) y solo se pasan las variables imprescindibles.

use std::ffi::OsString;

const DEFAULT_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

/// Entorno del hijo a partir de las variables del proceso: `PATH`, `HOME`, `SSH_AUTH_SOCK`
/// (agente) y `LANG=C` (mensajes de error estables y clasificables).
pub fn clean_env<I>(vars: I) -> Vec<(OsString, OsString)>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    let mut out: Vec<(OsString, OsString)> = Vec::new();
    for (k, v) in vars {
        let Some(name) = k.to_str() else { continue };
        if matches!(name, "PATH" | "HOME" | "SSH_AUTH_SOCK") && !v.to_string_lossy().contains('\0')
        {
            out.push((k, v));
        }
    }
    if !out.iter().any(|(k, _)| k == "PATH") {
        out.push(("PATH".into(), DEFAULT_PATH.into()));
    }
    out.push(("LANG".into(), "C".into()));
    out.push(("LC_ALL".into(), "C".into()));
    out
}

/// Entorno limpio del proceso actual.
pub fn process_clean_env() -> Vec<(OsString, OsString)> {
    clean_env(std::env::vars_os())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(s: &str) -> OsString {
        s.into()
    }

    #[test]
    fn solo_pasa_lo_imprescindible() {
        let vars = vec![
            (os("PATH"), os("/x/bin")),
            (os("HOME"), os("/home/u")),
            (os("SSH_AUTH_SOCK"), os("/run/agent.sock")),
            (os("SSH_ASKPASS"), os("/evil")),
            (os("LD_PRELOAD"), os("/evil.so")),
            (os("GIT_SSH_COMMAND"), os("x")),
            (os("DISPLAY"), os(":0")),
        ];
        let env = clean_env(vars);
        let keys: Vec<&str> = env.iter().filter_map(|(k, _)| k.to_str()).collect();
        assert_eq!(keys, ["PATH", "HOME", "SSH_AUTH_SOCK", "LANG", "LC_ALL"]);
    }

    #[test]
    fn sin_path_hay_uno_por_defecto() {
        let env = clean_env(Vec::new());
        assert!(env.iter().any(|(k, v)| k == "PATH" && v == DEFAULT_PATH));
    }
}
