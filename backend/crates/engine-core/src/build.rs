//! Construcción de imágenes: tipos del contrato, validación pura de la especificación y
//! parser de progreso "mejor esfuerzo". La ejecución (subproceso `docker build`) vive en el
//! crate `builder`; aquí no hay E/S.

use serde::{Deserialize, Serialize};

use crate::actions::PlanDecision;
use crate::api::ApiError;
use crate::error::EngineError;

/// Etiqueta que lleva TODA imagen construida desde DockInng (rastreo).
pub const BUILT_LABEL: &str = "dev.dockinng.built=1";
/// Máximo de `--build-arg`.
pub const MAX_BUILD_ARGS: usize = 64;
/// Máximo de bytes por línea de salida del build (el resto se descarta).
pub const MAX_BUILD_LINE: usize = 8 * 1024;
/// Líneas conservadas en el anillo de una construcción.
pub const BUILD_RING_LINES: usize = 10_000;

/// Qué construir. Todo llega del cliente: se valida SIEMPRE en el backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildSpec {
    /// Directorio de contexto (ruta del equipo donde corre DockInng).
    pub context_dir: String,
    /// Dockerfile relativo al contexto (por defecto `Dockerfile`).
    #[serde(default)]
    pub dockerfile: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
    /// Pares `(nombre, valor)`. Los valores no se registran ni se muestran.
    #[serde(default)]
    pub build_args: Vec<(String, String)>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub no_cache: bool,
    /// Pedir siempre la imagen base al registro (usa red). Por defecto no.
    #[serde(default)]
    pub pull: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BuildWarning {
    /// El contexto es la raíz, `$HOME` o un directorio del sistema: se enviaría al daemon entero.
    SensitiveContext { path: String },
    /// El nombre del ARG parece un secreto: los args quedan en el historial de la imagen.
    SecretLikeArg { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildPlan {
    pub warnings: Vec<BuildWarning>,
    pub decision: PlanDecision,
    /// UUID v7 si hay que confirmar; `None` si se puede construir directamente.
    pub ticket: Option<String>,
    pub expires_in_secs: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildLine {
    pub text: String,
    pub stream: BuildStream,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildOutcome {
    Ok,
    Failed,
    Canceled,
}

/// Eventos de una construcción hacia la UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BuildFeed {
    Line {
        text: String,
        stream: BuildStream,
    },
    /// Lote de líneas (la app agrupa para no saturar el canal).
    Lines {
        lines: Vec<BuildLine>,
    },
    Step {
        n: u32,
        total: u32,
    },
    Ended {
        outcome: BuildOutcome,
        image_id: Option<String>,
        error: Option<ApiError>,
    },
}

fn has_control(s: &str) -> bool {
    s.chars().any(|c| c.is_control())
}

/// Validación pura (sin tocar el sistema de archivos). El contexto se canoniza aparte.
pub fn validate_spec(spec: &BuildSpec) -> Result<(), EngineError> {
    if spec.context_dir.is_empty()
        || spec.context_dir.len() > 4096
        || has_control(&spec.context_dir)
    {
        return Err(EngineError::invalid("directorio de contexto inválido"));
    }
    if let Some(df) = &spec.dockerfile {
        validate_dockerfile(df)?;
    }
    if let Some(tag) = &spec.tag {
        crate::pull::validate_reference(tag)?;
        if tag.starts_with('-') || tag.contains('@') {
            return Err(EngineError::invalid(
                "la etiqueta de la imagen no puede ser un digest",
            ));
        }
    }
    if let Some(t) = &spec.target {
        let ok = !t.is_empty()
            && t.len() <= 128
            && t.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
            && t.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
        if !ok {
            return Err(EngineError::invalid(
                "nombre de target con caracteres no permitidos",
            ));
        }
    }
    if spec.build_args.len() > MAX_BUILD_ARGS {
        return Err(EngineError::invalid(format!(
            "demasiados build args (máximo {MAX_BUILD_ARGS})"
        )));
    }
    let mut seen = std::collections::HashSet::new();
    for (name, value) in &spec.build_args {
        let ok = !name.is_empty()
            && name.len() <= 128
            && name
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !ok {
            return Err(EngineError::invalid("nombre de build arg inválido"));
        }
        if reserved_arg_name(name) {
            return Err(EngineError::invalid(
                "ese nombre de build arg está reservado (variables de entorno del sistema o de Docker)",
            ));
        }
        if !seen.insert(name.as_str()) {
            return Err(EngineError::invalid("build arg repetido"));
        }
        // Sin saltos de línea ni controles (los valores no se citan en ningún mensaje).
        if value.len() > 4096 || has_control(value) {
            return Err(EngineError::invalid("valor de build arg inválido"));
        }
    }
    Ok(())
}

/// El valor de un `--build-arg` viaja en el entorno del proceso `docker`: un nombre que coincida
/// con una variable con efecto sobre ese proceso (ruta de búsqueda, carga de librerías, destino
/// del daemon, proxy...) se rechaza.
pub fn reserved_arg_name(name: &str) -> bool {
    let u = name.to_ascii_uppercase();
    const PREFIXES: [&str; 8] = [
        "DOCKER_",
        "BUILDKIT_",
        "BUILDX_",
        "COMPOSE_",
        "LD_",
        "XDG_",
        "SSH_",
        "LC_",
    ];
    // Variables que cambian el resultado o la red del build (certificados, temporales, runtime).
    const EXACT: [&str; 20] = [
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "TMPDIR",
        "GODEBUG",
        "GOFLAGS",
        "NODE_OPTIONS",
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LANGUAGE",
        "TZ",
        "TERM",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "ALL_PROXY",
        "IFS",
        "PWD",
    ];
    PREFIXES.iter().any(|p| u.starts_with(p)) || EXACT.contains(&u.as_str())
}

/// El Dockerfile es relativo al contexto y no puede escapar de él.
pub fn validate_dockerfile(df: &str) -> Result<(), EngineError> {
    if df.is_empty() || df.len() > 512 || has_control(df) {
        return Err(EngineError::invalid("ruta de Dockerfile inválida"));
    }
    if df.starts_with('/') || df.starts_with('-') || df.starts_with('~') {
        return Err(EngineError::invalid(
            "el Dockerfile debe ser una ruta relativa al contexto",
        ));
    }
    if df.split('/').any(|seg| seg == "..") {
        return Err(EngineError::invalid(
            "el Dockerfile no puede salir del contexto",
        ));
    }
    Ok(())
}

/// Nombres de ARG que parecen secretos (los args se guardan en el historial de la imagen).
pub fn secret_like_args(spec: &BuildSpec) -> Vec<String> {
    spec.build_args
        .iter()
        .map(|(n, _)| n)
        .filter(|n| {
            let u = n.to_ascii_uppercase();
            ["PASSWORD", "PASSWD", "TOKEN", "SECRET", "KEY", "CREDENTIAL"]
                .iter()
                .any(|w| u.contains(w))
        })
        .cloned()
        .collect()
}

/// Lo que se pudo entender de una línea de salida del build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuildProgress {
    /// Paso `n` de `total`.
    Step { n: u32, total: u32 },
    /// Id de la imagen resultante.
    ImageId(String),
}

/// Parser "mejor esfuerzo": builder clásico (`Step 3/7 : ...`, `Successfully built <id>`) y
/// BuildKit en modo plain (`#5 [2/4] RUN ...`, `writing image sha256:<id> done`). Una línea que
/// no encaja devuelve `None`: la UI siempre muestra las líneas crudas.
pub fn parse_progress(line: &str) -> Option<BuildProgress> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("Step ") {
        let frac = rest.split_whitespace().next()?;
        return fraction(frac);
    }
    if let Some(rest) = line.strip_prefix("Successfully built ") {
        let id = rest.trim();
        if is_hex_id(id) {
            return Some(BuildProgress::ImageId(id.to_string()));
        }
        return None;
    }
    // BuildKit antepone `#N <tiempo>` a la línea: `#12 writing image sha256:... done`.
    if line.starts_with('#')
        && let Some(idx) = line.find("writing image ")
    {
        return parse_progress(&line[idx..]);
    }
    if let Some(rest) = line.strip_prefix('#') {
        // `#5 [2/4] RUN ...` (con o sin nombre de etapa: `[stage 2/4]`).
        let after = rest.split_once(' ')?.1.trim_start();
        let inner = after.strip_prefix('[')?;
        let (bracket, _) = inner.split_once(']')?;
        let frac = bracket.split_whitespace().last()?;
        return fraction(frac);
    }
    if let Some(rest) = line.strip_prefix("writing image ")
        && let Some(id) = rest.split_whitespace().next()
        && id.starts_with("sha256:")
        && is_hex_id(id.trim_start_matches("sha256:"))
    {
        return Some(BuildProgress::ImageId(id.to_string()));
    }
    None
}

fn fraction(s: &str) -> Option<BuildProgress> {
    let (n, total) = s.split_once('/')?;
    let n: u32 = n.parse().ok()?;
    let total: u32 = total.trim_end_matches(':').parse().ok()?;
    if n == 0 || total == 0 || n > total || total > 10_000 {
        return None;
    }
    Some(BuildProgress::Step { n, total })
}

fn is_hex_id(s: &str) -> bool {
    (6..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> BuildSpec {
        BuildSpec {
            context_dir: "/tmp/x".into(),
            dockerfile: None,
            tag: Some("dockinng-test-build:1".into()),
            build_args: vec![("VERSION".into(), "1.2".into())],
            target: None,
            no_cache: false,
            pull: false,
        }
    }

    #[test]
    fn spec_valida() {
        assert!(validate_spec(&spec()).is_ok());
    }

    #[test]
    fn rechaza_especificaciones_hostiles() {
        let mut cases: Vec<BuildSpec> = Vec::new();
        let mut s = spec();
        s.context_dir = String::new();
        cases.push(s);
        let mut s = spec();
        s.context_dir = "/tmp/a\nb".into();
        cases.push(s);
        for df in ["/etc/passwd", "../x", "a/../../b", "-f", "~/x", "a\nb", ""] {
            let mut s = spec();
            s.dockerfile = Some(df.into());
            cases.push(s);
        }
        for tag in ["", "-x:1", "a b", "img@sha256:abcd", "nginx:"] {
            let mut s = spec();
            s.tag = Some(tag.into());
            cases.push(s);
        }
        for t in ["", "-x", "a b", "a;b"] {
            let mut s = spec();
            s.target = Some(t.into());
            cases.push(s);
        }
        for (n, v) in [
            ("", "x"),
            ("1A", "x"),
            ("A-B", "x"),
            ("A", "l1\nl2"),
            ("A", "nul\0"),
        ] {
            let mut s = spec();
            s.build_args = vec![(n.into(), v.into())];
            cases.push(s);
        }
        let mut s = spec();
        s.build_args = vec![("A".into(), "1".into()), ("A".into(), "2".into())];
        cases.push(s);
        for reserved in [
            "PATH",
            "path",
            "DOCKER_HOST",
            "LD_PRELOAD",
            "HTTP_PROXY",
            "XDG_DATA_HOME",
            "SSH_AUTH_SOCK",
        ] {
            let mut s = spec();
            s.build_args = vec![(reserved.into(), "x".into())];
            cases.push(s);
        }
        let mut s = spec();
        s.build_args = (0..=MAX_BUILD_ARGS)
            .map(|i| (format!("A{i}"), "1".into()))
            .collect();
        cases.push(s);
        for c in cases {
            assert!(validate_spec(&c).is_err(), "{c:?}");
        }
    }

    #[test]
    fn el_mensaje_de_error_no_incluye_el_valor_del_arg() {
        let mut s = spec();
        s.build_args = vec![("TOKEN".into(), "valor-secreto\nX".into())];
        let e = validate_spec(&s).unwrap_err().to_string();
        assert!(!e.contains("valor-secreto"), "{e}");
    }

    #[test]
    fn args_con_nombre_de_secreto() {
        let mut s = spec();
        s.build_args = vec![
            ("VERSION".into(), "1".into()),
            ("NPM_TOKEN".into(), "x".into()),
            ("db_password".into(), "y".into()),
            ("API_KEY".into(), "z".into()),
        ];
        assert_eq!(
            secret_like_args(&s),
            ["NPM_TOKEN", "db_password", "API_KEY"]
        );
    }

    #[test]
    fn parser_clasico() {
        assert_eq!(
            parse_progress("Step 3/7 : RUN echo hola"),
            Some(BuildProgress::Step { n: 3, total: 7 })
        );
        assert_eq!(
            parse_progress("Successfully built 0123456789ab"),
            Some(BuildProgress::ImageId("0123456789ab".into()))
        );
        assert_eq!(parse_progress("Successfully built nada!"), None);
        assert_eq!(parse_progress("Step x/y : mal"), None);
        assert_eq!(parse_progress("Step 9/3 : imposible"), None);
    }

    #[test]
    fn parser_buildkit_plain() {
        assert_eq!(
            parse_progress("#5 [2/4] RUN echo hola"),
            Some(BuildProgress::Step { n: 2, total: 4 })
        );
        assert_eq!(
            parse_progress("#7 [stage-1 3/5] COPY . /app"),
            Some(BuildProgress::Step { n: 3, total: 5 })
        );
        assert_eq!(parse_progress("#1 [internal] load build definition"), None);
        assert_eq!(parse_progress("#2 DONE 0.0s"), None);
        let id = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_progress(&format!("#12 writing image {id} done")),
            Some(BuildProgress::ImageId(id.into()))
        );
    }

    #[test]
    fn el_contrato_serializa_como_espera_el_frontend() {
        let j = serde_json::to_value(BuildFeed::Ended {
            outcome: BuildOutcome::Canceled,
            image_id: None,
            error: None,
        })
        .unwrap();
        assert_eq!(
            j,
            serde_json::json!({"type":"ended","outcome":"canceled","image_id":null,"error":null})
        );
        let j = serde_json::to_value(BuildFeed::Line {
            text: "x".into(),
            stream: BuildStream::Stderr,
        })
        .unwrap();
        assert_eq!(
            j,
            serde_json::json!({"type":"line","text":"x","stream":"stderr"})
        );
        let w = serde_json::to_value(BuildWarning::SensitiveContext { path: "/".into() }).unwrap();
        assert_eq!(
            w,
            serde_json::json!({"type":"sensitive_context","path":"/"})
        );
        let s = serde_json::to_value(spec()).unwrap();
        assert_eq!(s["build_args"], serde_json::json!([["VERSION", "1.2"]]));
    }

    #[test]
    fn variables_de_certificados_temporales_y_runtime_son_reservadas() {
        for n in [
            "SSL_CERT_FILE",
            "ssl_cert_dir",
            "TMPDIR",
            "GODEBUG",
            "GOFLAGS",
            "NODE_OPTIONS",
        ] {
            assert!(reserved_arg_name(n), "{n} debe estar reservada");
        }
        assert!(!reserved_arg_name("VERSION"));
    }
}
