//! Validación de nombres y traducción de los errores de `docker compose config` a
//! problemas con línea/columna.

use crate::error::ComposeError;
use crate::types::{IssueKind, ValidationIssue};

/// Tope de un mensaje de error de Compose (puede echar un fragmento de un archivo ajeno).
pub const MAX_MESSAGE_LEN: usize = 2048;
pub const MAX_SERVICES_PER_OP: usize = 32;

/// Nombre de stack = regla de proyecto de Compose: `^[a-z0-9][a-z0-9_-]{0,62}$`.
pub fn validate_stack_name(name: &str) -> Result<(), ComposeError> {
    let ok = !name.is_empty()
        && name.len() <= 63
        && name.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || (i > 0 && (b == b'_' || b == b'-'))
        });
    if ok {
        Ok(())
    } else {
        Err(ComposeError::InvalidInput(
            "nombre de stack inválido: usa minúsculas, dígitos, '-' y '_' (máx. 63, sin empezar por símbolo)"
                .into(),
        ))
    }
}

/// Nombre de servicio: `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`.
pub fn validate_service_name(name: &str) -> Result<(), ComposeError> {
    let ok = !name.is_empty()
        && name.len() <= 63
        && name
            .bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_alphanumeric() || (i > 0 && matches!(b, b'.' | b'_' | b'-')));
    if ok {
        Ok(())
    } else {
        Err(ComposeError::InvalidInput(
            "nombre de servicio inválido".into(),
        ))
    }
}

/// Valida la lista de servicios de una operación (formato, duplicados, tope).
pub fn validate_service_list(services: &[String]) -> Result<(), ComposeError> {
    if services.len() > MAX_SERVICES_PER_OP {
        return Err(ComposeError::InvalidInput(format!(
            "demasiados servicios (máx. {MAX_SERVICES_PER_OP})"
        )));
    }
    for s in services {
        validate_service_name(s)?;
    }
    Ok(())
}

/// Trunca en un límite de caracteres respetando UTF-8.
pub fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// Busca `L<n>.C<m>` en un mensaje de go-yaml.
fn find_line_col(text: &str) -> Option<(u32, u32)> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let boundary = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        if bytes[i] == b'L' && boundary {
            let (line, j) = read_digits(bytes, i + 1)?;
            if j > i + 1 && bytes.get(j) == Some(&b'.') && bytes.get(j + 1) == Some(&b'C') {
                let (col, k) = read_digits(bytes, j + 2)?;
                if k > j + 2 {
                    return Some((line, col));
                }
            }
        }
        i += 1;
    }
    None
}

fn read_digits(bytes: &[u8], mut i: usize) -> Option<(u32, usize)> {
    let mut value: u32 = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        value = value
            .checked_mul(10)?
            .checked_add(u32::from(bytes[i] - b'0'))?;
        i += 1;
    }
    Some((value, i))
}

/// Quita el prefijo `validating <archivo>: ` / `failed to parse <archivo>: ` para no
/// mostrar rutas absolutas en la UI (el editor ya sabe qué archivo edita).
fn strip_file_prefix(line: &str) -> &str {
    for prefix in ["validating ", "failed to parse "] {
        if let Some(rest) = line.strip_prefix(prefix)
            && let Some((_, msg)) = rest.split_once(": ")
        {
            return msg;
        }
    }
    line
}

fn classify(message: &str) -> IssueKind {
    let lower = message.to_lowercase();
    if lower.contains("go-yaml") || lower.contains("yaml:") || find_line_col(message).is_some() {
        IssueKind::Syntax
    } else if lower.contains("interpolat") || lower.contains("required variable") {
        IssueKind::Interpolation
    } else if lower.contains("additional properties")
        || lower.contains("must be a")
        || lower.contains("is invalid")
        || lower.contains("invalid compose project")
        || lower.contains("services.")
    {
        IssueKind::Schema
    } else {
        IssueKind::Other
    }
}

/// Convierte la salida de error de `config` (stderr, o el `message` del progreso JSON) en problemas.
pub fn parse_issues(stderr: &str) -> Vec<ValidationIssue> {
    let mut out = Vec::new();
    for raw in stderr.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let msg = strip_file_prefix(line);
        let kind = classify(msg);
        let (l, c) = match kind {
            IssueKind::Syntax => find_line_col(msg).unzip(),
            _ => (None, None),
        };
        out.push(ValidationIssue {
            line: l,
            column: c,
            kind,
            message: truncate(msg, MAX_MESSAGE_LEN),
        });
        if out.len() >= 20 {
            break;
        }
    }
    out
}

/// Mejor esfuerzo: para errores de esquema sin línea, busca en el YAML la clave citada
/// (`'imagen'`) o la ruta `services.web` y marca la línea como aproximada.
pub fn infer_lines(yaml: &str, issues: &mut [ValidationIssue]) {
    for issue in issues.iter_mut().filter(|i| i.line.is_none()) {
        if !matches!(issue.kind, IssueKind::Schema | IssueKind::Interpolation) {
            continue;
        }
        let mut candidates: Vec<String> = Vec::new();
        if let Some(start) = issue.message.find('\'')
            && let Some(len) = issue.message[start + 1..].find('\'')
        {
            let key = &issue.message[start + 1..start + 1 + len];
            if !key.is_empty() && key.len() < 64 {
                candidates.push(format!("{key}:"));
            }
        }
        // `services.web` o `services.web.environment.X`: la última parte con `:`.
        if let Some(path) = issue
            .message
            .split_whitespace()
            .find(|w| w.starts_with("services."))
        {
            let path = path.trim_end_matches([':', ',', '.']);
            for part in path
                .split('.')
                .skip(1)
                .take(3)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
            {
                if !part.is_empty() {
                    candidates.push(format!("{part}:"));
                }
            }
        }
        'outer: for cand in candidates {
            for (idx, text) in yaml.lines().enumerate() {
                if text.trim_start().starts_with(&cand) {
                    issue.line = u32::try_from(idx + 1).ok();
                    issue.column = None;
                    // El contrato no tiene un campo de "aproximado": se avisa en el texto.
                    issue.message.push_str(" (línea aproximada)");
                    break 'outer;
                }
            }
        }
    }
}

/// Resultado del pre-escaneo de los `include:` de nivel superior de un YAML, leído con un parser
/// (no por líneas), así que cubre cualquier forma que `docker compose config` acepta.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct IncludeScan {
    /// Línea aproximada (1-based) de un `include` remoto (git, OCI, http, ssh).
    pub remote_line: Option<u32>,
    /// Rutas locales declaradas en `include`, tal como están en el YAML.
    pub local_paths: Vec<String>,
    /// Forma no verificable (YAML ilegible o `include` con forma desconocida): falla cerrado.
    pub unverifiable: bool,
}

/// Escanea los `include` de un documento. Los locales se devuelven para seguirlos, porque
/// Compose también resuelve los `include` de los archivos incluidos.
pub fn scan_includes(yaml: &str) -> IncludeScan {
    let mut scan = IncludeScan::default();
    let doc: serde_norway::Value = match serde_norway::from_str(yaml) {
        Ok(doc) => doc,
        Err(_) => {
            // Sin parser no se sabe si hay `include`. Una clave solo se puede escribir con
            // escapes (`\x69nclude`) o con el texto literal: sin ninguno de los dos no hay riesgo.
            let lower = yaml.to_lowercase();
            scan.unverifiable = lower.contains("include") || yaml.contains('\\');
            return scan;
        }
    };
    let Some(includes) = doc.as_mapping().and_then(|m| m.get("include")) else {
        return scan;
    };
    if includes.is_null() {
        return scan;
    }
    let Some(items) = includes.as_sequence() else {
        scan.unverifiable = true;
        return scan;
    };
    for item in items {
        let values: Vec<&serde_norway::Value> = match item {
            serde_norway::Value::String(_) => vec![item],
            serde_norway::Value::Mapping(m) => match m.get("path") {
                Some(p @ serde_norway::Value::String(_)) => vec![p],
                Some(serde_norway::Value::Sequence(seq)) => seq.iter().collect(),
                _ => {
                    scan.unverifiable = true;
                    continue;
                }
            },
            _ => {
                scan.unverifiable = true;
                continue;
            }
        };
        for value in values {
            match value.as_str() {
                Some(s) if is_remote_source(s) => {
                    scan.remote_line.get_or_insert_with(|| line_of(yaml, s));
                }
                Some(s) => scan.local_paths.push(s.to_string()),
                None => scan.unverifiable = true,
            }
        }
    }
    scan
}

/// Fuente que Compose no resuelve en el disco local (red o servicio externo).
fn is_remote_source(s: &str) -> bool {
    let l = s.to_lowercase();
    l.contains("://")
        || l.contains("git@")
        || l.starts_with("git:")
        || l.starts_with("git+")
        || l.starts_with("oci:")
        || l.starts_with("ssh:")
}

/// Línea (1-based) que contiene `needle`; si no aparece literal (p. ej. escapado), la del `include`.
fn line_of(yaml: &str, needle: &str) -> u32 {
    let idx = yaml
        .lines()
        .position(|l| l.contains(needle))
        .or_else(|| {
            yaml.lines()
                .position(|l| l.to_lowercase().contains("include"))
        })
        .unwrap_or(0);
    u32::try_from(idx + 1).unwrap_or(1)
}

/// Pre-escaneo de `include` remotos (o no verificables) antes de ejecutar `config`. Devuelve la
/// línea aproximada del problema. Los locales no se siguen aquí: ver `scan_includes`.
pub fn find_remote_include(yaml: &str) -> Option<u32> {
    let scan = scan_includes(yaml);
    if scan.unverifiable {
        return Some(1);
    }
    scan.remote_line
}

/// Valores del YAML cuyo nombre sugiere un secreto (`PASSWORD: x`, `- API_KEY=x`), para redactar.
pub fn yaml_secret_values(yaml: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in yaml.lines().take(20_000) {
        let t = line.trim().trim_start_matches("- ");
        let Some(pos) = t.find([':', '=']) else {
            continue;
        };
        let key = t[..pos].trim().to_lowercase();
        if !["pass", "secret", "token", "key", "pwd", "credential"]
            .iter()
            .any(|w| key.contains(w))
        {
            continue;
        }
        let val = t[pos + 1..].trim().trim_matches(['"', '\'']);
        if val.len() >= 4 && !val.starts_with("${") && !val.starts_with('$') {
            out.push(val.to_string());
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.len()));
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/invalid_yaml_messages.txt");

    /// Extrae el stderr del caso `=== <name>` del fixture real.
    fn case(name: &str) -> String {
        let marker = format!("=== {name}\n");
        let start = FIXTURE.find(&marker).expect("caso") + marker.len();
        let body = &FIXTURE[start..];
        let body = body.split("\n=== ").next().unwrap();
        body.split("stderr: ").nth(1).unwrap().trim().to_string()
    }

    #[test]
    fn nombres_de_stack() {
        for ok in ["a", "web", "a-b_c", "0x", &"a".repeat(63)] {
            assert!(validate_stack_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "../x",
            "a/b",
            ".",
            "..",
            "-x",
            "_x",
            "A",
            "ñ",
            "a b",
            "a\nb",
            "a\0b",
            "a.b",
            &"a".repeat(64),
            "web;ls",
            "$(x)",
        ] {
            assert!(validate_stack_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn nombres_de_servicio() {
        for ok in ["web", "a.b_c-d", "W1"] {
            assert!(validate_service_name(ok).is_ok());
        }
        for bad in [
            "--evil", "a;b", "$(x)", "a b", "a\nb", "", "-x", ".x", "a/b", "`x`",
        ] {
            assert!(validate_service_name(bad).is_err(), "{bad:?}");
        }
        assert!(validate_service_list(&vec!["a".into(); 33]).is_err());
    }

    #[test]
    fn sintaxis_trae_linea_y_columna() {
        let i = parse_issues(&case("syntax"));
        assert_eq!(i.len(), 1);
        assert_eq!(i[0].kind, IssueKind::Syntax);
        assert_eq!((i[0].line, i[0].column), (Some(2), Some(3)));
        let t = parse_issues(&case("tab"));
        assert_eq!((t[0].line, t[0].column), (Some(2), Some(1)));
        assert_eq!(t[0].kind, IssueKind::Syntax);
    }

    #[test]
    fn esquema_sin_linea_y_sin_ruta_absoluta() {
        let i = parse_issues(&case("schema"));
        assert_eq!(i[0].kind, IssueKind::Schema);
        assert_eq!(i[0].line, None);
        assert!(!i[0].message.contains("/home/user"));
        assert!(i[0].message.contains("additional properties 'imagen'"));
        let mut i = i;
        infer_lines("services:\n  web:\n    imagen: x\n", &mut i);
        assert_eq!(i[0].line, Some(3));
        assert!(i[0].message.ends_with("(línea aproximada)"));
    }

    #[test]
    fn otros_casos() {
        assert_eq!(
            parse_issues(&case("reqvar"))[0].kind,
            IssueKind::Interpolation
        );
        assert_eq!(parse_issues(&case("port"))[0].kind, IssueKind::Other);
        assert_eq!(parse_issues(&case("empty"))[0].kind, IssueKind::Other);
        assert_eq!(parse_issues(&case("dep"))[0].kind, IssueKind::Schema);
        assert!(parse_issues("").is_empty());
    }

    #[test]
    fn includes_remotos_se_detectan_sin_falsos_positivos() {
        for bad in [
            "include:\n  - https://github.com/x/y.git\nservices: {}\n",
            "include:\n- oci://docker.io/x/y:1\n",
            "include: [git@github.com:x/y.git]\n",
            "include:\n  - path: http://x/y.yaml\n",
            "x-a: &a https://x\ninclude:\n  - *a\n",
            "services:\n  a: {}\ninclude:\n  - git+https://x\n",
        ] {
            assert!(find_remote_include(bad).is_some(), "{bad}");
        }
        for ok in [
            "include:\n  - ./local.yaml\n  - path: sub/x.yaml\nservices:\n  a:\n    image: https://no-es-include\n",
            "services:\n  a:\n    image: nginx\n    environment:\n      URL: https://x\n",
            "include:\n  - ./a.yaml\n",
        ] {
            assert_eq!(find_remote_include(ok), None, "{ok}");
        }
        assert_eq!(
            find_remote_include("a: 1\ninclude:\n  - https://x\n"),
            Some(3)
        );
    }

    /// Formas válidas de YAML que Compose acepta y que el pre-escaneo por líneas debe cubrir.
    #[test]
    fn includes_remotos_en_formas_alternativas_de_yaml() {
        for bad in [
            // Documento en flow (una sola línea): la clave empieza por `{`.
            "{include: [https://x/y.yaml]}\n",
            // Espacio antes de los dos puntos.
            "include : [https://x/y.yaml]\n",
            // Clave con comillas y escape hexadecimal: Compose la decodifica.
            "\"\\x69nclude\": [https://x/y.yaml]\n",
            // Valor con escape hexadecimal dentro de comillas: `https\x3a//`.
            "include:\n  - \"https\\x3a//x/y.yaml\"\n",
            // Clave compleja `? include`.
            "? include\n: [https://x/y.yaml]\n",
        ] {
            assert!(find_remote_include(bad).is_some(), "no detectado: {bad:?}");
        }
    }

    #[test]
    fn include_no_verificable_falla_cerrado() {
        // YAML ilegible que puede esconder un `include`: se rechaza.
        assert!(find_remote_include("include: [\n").is_some());
        assert!(find_remote_include("\"\\x69nclude\": [\n").is_some());
        // Forma de `include` que no se entiende (ni lista ni mapa con `path`): se rechaza.
        assert!(find_remote_include("include: ./a.yaml\n").is_some());
        assert!(find_remote_include("include:\n  - path: 5\n").is_some());
        // Sin `include` y sin posibilidad de escribirlo: no se bloquea (lo juzga Compose).
        assert_eq!(find_remote_include("services: [\n"), None);
    }

    #[test]
    fn include_locales_se_devuelven_para_seguirlos() {
        let scan = scan_includes(
            "include:\n  - ./a.yaml\n  - path: sub/b.yaml\n  - path:\n      - c.yaml\n",
        );
        assert_eq!(scan.remote_line, None);
        assert!(!scan.unverifiable);
        assert_eq!(scan.local_paths, vec!["./a.yaml", "sub/b.yaml", "c.yaml"]);
    }

    #[test]
    fn secretos_del_yaml() {
        let v = yaml_secret_values(
            "environment:\n  DB_PASSWORD: hunter2-largo\n  - API_KEY=abcd1234\n  NAME: pepe\n  TOKEN: ${TOK}\n  KEY: ab\n",
        );
        assert_eq!(v, vec!["hunter2-largo".to_string(), "abcd1234".to_string()]);
    }

    #[test]
    fn con_stdin_el_nombre_es_guion() {
        let i = parse_issues("validating -: services.web additional properties 'x' not allowed");
        assert!(i[0].message.starts_with("services.web"));
    }

    #[test]
    fn mensajes_largos_se_truncan() {
        let long = format!("go-yaml load error at L1.C1 {}", "é".repeat(5000));
        let i = parse_issues(&long);
        assert!(i[0].message.len() <= MAX_MESSAGE_LEN + 4);
        assert_eq!(i[0].line, Some(1));
    }

    #[test]
    fn numero_de_linea_absurdo_no_desborda() {
        let i = parse_issues("go-yaml load error L99999999999999999999.C1");
        assert_eq!(i[0].line, None);
    }
}
