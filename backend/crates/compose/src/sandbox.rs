//! Sandbox de rutas locales de Compose: `include`, `extends.file` y `env_file` no pueden
//! apuntar fuera del directorio del proyecto, ni por `..`, ni por enlaces simbólicos en
//! cualquier componente, ni por interpolación `${...}` (que solo se resuelve ejecutando Compose,
//! así que se rechaza).
//!
//! Como `validate::find_remote_include`, el análisis es línea a línea y falla cerrado: ante la
//! duda, rechaza. Los `include` y `extends.file` locales se siguen de forma recursiva, porque
//! Compose también resuelve los de los archivos incluidos.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::files::MAX_YAML_BYTES;

/// Profundidad máxima de `include`/`extends` anidados que se siguen.
const MAX_DEPTH: usize = 8;
/// Claves de un mapa cuyo valor es una ruta local (`include`/`extends` largos y `project_directory`).
const PATH_KEYS: [&str; 3] = ["path", "file", "project_directory"];
/// Esquemas remotos: los valida `validate::find_remote_include`, no este sandbox.
const REMOTE_PREFIXES: [&str; 4] = ["http://", "https://", "git://", "oci://"];

/// Primera referencia local que escapa del proyecto (o no se puede demostrar que no escapa).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Escape {
    /// Línea (1-based) de la referencia dentro de su archivo.
    pub line: u32,
    /// `true` si la referencia está en un archivo incluido y no en el seleccionado.
    pub in_included: bool,
}

/// Escanea YAML que no viene de un archivo (stdin). Sin `project_dir` cualquier ruta local se
/// rechaza: no hay forma de demostrar que quede dentro del proyecto.
pub fn find_local_escape(text: &str, project_dir: Option<&Path>) -> Option<Escape> {
    let mut scan = Scan::new(project_dir);
    let bases: Vec<PathBuf> = project_dir.map(Path::to_path_buf).into_iter().collect();
    scan.text(text, &bases, 0, false)
}

/// Escanea el archivo compose seleccionado. Las rutas relativas deben quedar dentro del
/// directorio del proyecto y también del propio archivo (Compose usa uno u otro según el caso).
pub fn find_local_escape_in_file(path: &Path, project_dir: Option<&Path>) -> Option<Escape> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_YAML_BYTES as u64 {
        // No se puede verificar un archivo tan grande: falla cerrado.
        return Some(Escape {
            line: 1,
            in_included: false,
        });
    }
    let text = fs::read_to_string(path).ok()?;
    let mut scan = Scan::new(project_dir);
    if let Ok(canon) = fs::canonicalize(path) {
        scan.visited.insert(canon);
    }
    let mut bases: Vec<PathBuf> = project_dir.map(Path::to_path_buf).into_iter().collect();
    if let Some(dir) = path.parent() {
        bases.push(dir.to_path_buf());
    }
    scan.text(&text, &bases, 0, false)
}

/// Bloque abierto por `include`, `env_file` o `extends`: las líneas con más sangría pertenecen
/// a él, y también los ítems de lista a la misma sangría.
#[derive(Clone, Copy)]
struct Block {
    ctx: Ctx,
    indent: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Ctx {
    Include,
    EnvFile,
    Extends,
}

/// Estado de un escaneo: raíz canónica del proyecto (`None` si no existe o no se puede
/// canonicalizar, y entonces todo falla cerrado), directorio tal cual para resolver rutas
/// relativas y archivos ya visitados (anti-ciclos).
struct Scan {
    project: Option<PathBuf>,
    root: Option<PathBuf>,
    visited: HashSet<PathBuf>,
}

impl Scan {
    fn new(project: Option<&Path>) -> Self {
        Scan {
            project: project.map(Path::to_path_buf),
            root: project.and_then(|d| fs::canonicalize(d).ok()),
            visited: HashSet::new(),
        }
    }

    /// Escanea `text` línea a línea; `bases` son los directorios contra los que se resuelven
    /// las rutas relativas (cada uno debe dejarlas dentro del proyecto).
    fn text(
        &mut self,
        text: &str,
        bases: &[PathBuf],
        depth: usize,
        nested: bool,
    ) -> Option<Escape> {
        if depth > MAX_DEPTH {
            return Some(Escape {
                line: 1,
                in_included: nested,
            });
        }
        let mut block: Option<Block> = None;
        for (idx, raw) in text.lines().enumerate() {
            let line = u32::try_from(idx + 1).unwrap_or(u32::MAX);
            let indent = raw.len() - raw.trim_start().len();
            let content = strip_comment(raw.trim_start());
            if content.is_empty() {
                continue;
            }
            if let Some(b) = block
                && (indent < b.indent || (indent == b.indent && !is_item(content)))
            {
                block = None;
            }
            let (_, body) = item_body(content);
            let kv = split_key(body);
            if let Some((key, value)) = kv
                && let Some(ctx) = block_ctx(key)
            {
                block = Some(Block { ctx, indent });
                if let Some(esc) = self.check(value, ctx, bases, depth, nested, line) {
                    return Some(esc);
                }
                continue;
            }
            let Some(b) = block else { continue };
            let hit = match (b.ctx, kv) {
                (_, Some((key, value))) if PATH_KEYS.contains(&key) => Some(value),
                (Ctx::Include | Ctx::EnvFile, None) => Some(body),
                _ => None,
            };
            // Un valor bajo `file:`/`path:`/`project_directory:` (o un ítem de lista) es una
            // ruta siempre: en `extends` se valida con la semántica de `include`.
            let ctx = if b.ctx == Ctx::Extends {
                Ctx::Include
            } else {
                b.ctx
            };
            if let Some(value) = hit
                && let Some(esc) = self.check(value, ctx, bases, depth, nested, line)
            {
                return Some(esc);
            }
        }
        None
    }

    /// Valida las rutas de un valor. Las rutas que pasan se siguen si son `include`/`extends`.
    fn check(
        &mut self,
        value: &str,
        ctx: Ctx,
        bases: &[PathBuf],
        depth: usize,
        nested: bool,
        line: u32,
    ) -> Option<Escape> {
        let esc = Escape {
            line,
            in_included: nested,
        };
        // Un valor de `extends` sin `file:` (nombre de servicio) no es una ruta.
        for tok in tokens(value, ctx != Ctx::Extends) {
            if tok.contains('$') {
                // La interpolación solo se resuelve ejecutando Compose: no se puede verificar.
                return Some(esc);
            }
            if tok.contains("://") {
                if REMOTE_PREFIXES.iter().any(|p| tok.starts_with(p)) {
                    continue;
                }
                return Some(esc);
            }
            let candidates: Vec<PathBuf> = if Path::new(tok).is_absolute() {
                vec![PathBuf::from(tok)]
            } else if bases.is_empty() {
                return Some(esc);
            } else {
                bases.iter().map(|b| b.join(tok)).collect()
            };
            let mut found = Vec::with_capacity(candidates.len());
            for cand in &candidates {
                match self.confine(cand) {
                    Some(canon) => found.push(canon),
                    None => return Some(esc),
                }
            }
            if ctx != Ctx::EnvFile {
                for canon in &found {
                    if let Some(esc) = self.follow(canon, depth) {
                        return Some(esc);
                    }
                }
            }
        }
        None
    }

    /// Sigue un `include`/`extends` ya confinado y escanea su contenido.
    fn follow(&mut self, path: &Path, depth: usize) -> Option<Escape> {
        if !path.is_file() || !self.visited.insert(path.to_path_buf()) {
            return None;
        }
        let meta = fs::metadata(path).ok()?;
        if meta.len() > MAX_YAML_BYTES as u64 {
            return Some(Escape {
                line: 1,
                in_included: true,
            });
        }
        let text = fs::read_to_string(path).ok()?;
        let mut bases: Vec<PathBuf> = self.project.iter().cloned().collect();
        if let Some(dir) = path.parent() {
            bases.push(dir.to_path_buf());
        }
        self.text(&text, &bases, depth + 1, true)
    }

    /// Resuelve `p` (absoluta) siguiendo los enlaces simbólicos que existan y devuelve la ruta
    /// canónica solo si queda dentro de la raíz del proyecto. Las componentes que no existen
    /// se añaden tal cual, pero un `..` sobre una componente inexistente se rechaza.
    fn confine(&self, p: &Path) -> Option<PathBuf> {
        let root = self.root.as_deref()?;
        let comps: Vec<Component> = p.components().collect();
        for end in (1..=comps.len()).rev() {
            let prefix: PathBuf = comps[..end].iter().collect();
            if let Ok(mut out) = fs::canonicalize(&prefix) {
                for c in &comps[end..] {
                    match c {
                        Component::Normal(s) => out.push(s),
                        Component::CurDir => {}
                        _ => return None,
                    }
                }
                return out.starts_with(root).then_some(out);
            }
        }
        None
    }
}

fn block_ctx(key: &str) -> Option<Ctx> {
    match key {
        "include" => Some(Ctx::Include),
        "env_file" => Some(Ctx::EnvFile),
        "extends" => Some(Ctx::Extends),
        _ => None,
    }
}

/// Valores de ruta de un fragmento: escalar, lista `[a, b]` o mapa `{file: x}`. Dentro de
/// `include`/`env_file` un token sin clave es una ruta; en `extends` no (es un nombre de servicio).
fn tokens(value: &str, bare_is_path: bool) -> Vec<&str> {
    strip_comment(value.trim())
        .split([',', '[', ']', '{', '}'])
        .filter_map(|t| {
            let t = t.trim();
            match split_key(t) {
                Some((key, v)) => PATH_KEYS.contains(&key).then_some(v),
                None => {
                    let t = t.trim_matches(['"', '\'']);
                    (bare_is_path && !t.is_empty()).then_some(t)
                }
            }
        })
        .filter(|t| !t.is_empty())
        .collect()
}

/// `clave: valor` con clave identificador; `None` para escalares (incluidas rutas con `:`).
fn split_key(s: &str) -> Option<(&str, &str)> {
    let (key, value) = s.split_once(':')?;
    let key = key.trim().trim_matches(['"', '\'']);
    let identifier = !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    let spaced = value.is_empty() || value.starts_with(char::is_whitespace);
    (identifier && spaced).then(|| (key, value.trim().trim_matches(['"', '\''])))
}

/// Ítem de lista YAML (`- x`): devuelve el contenido tras el guion.
fn item_body(content: &str) -> (bool, &str) {
    match content.strip_prefix('-') {
        Some(rest) if rest.is_empty() || rest.starts_with(char::is_whitespace) => {
            (true, rest.trim_start())
        }
        _ => (false, content),
    }
}

fn is_item(content: &str) -> bool {
    item_body(content).0
}

/// Quita comentarios YAML de la línea (`# ...` al inicio o tras espacio).
fn strip_comment(s: &str) -> &str {
    if s.starts_with('#') {
        return "";
    }
    match s.find(" #") {
        Some(i) => s[..i].trim_end(),
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Directorio temporal propio del test: `proyecto/` (el stack) y `fuera/` (ajeno).
    struct Tmp(PathBuf);

    impl Tmp {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let p = std::env::temp_dir().join(format!(
                "dockinng-sandbox-{tag}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(p.join("proyecto")).unwrap();
            fs::create_dir_all(p.join("fuera")).unwrap();
            fs::write(p.join("fuera/secreto.yaml"), "services: {}\n").unwrap();
            fs::write(p.join("fuera/secreto.env"), "TOKEN=x\n").unwrap();
            Tmp(p)
        }

        fn proyecto(&self) -> PathBuf {
            self.0.join("proyecto")
        }

        fn fuera(&self) -> PathBuf {
            self.0.join("fuera")
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Línea del primer escape, o `None`.
    fn linea(text: &str, dir: &Path) -> Option<u32> {
        find_local_escape(text, Some(dir)).map(|e| e.line)
    }

    #[test]
    fn include_con_traversal_se_rechaza() {
        let t = Tmp::new("include");
        assert_eq!(
            linea("include:\n  - ../secreto.yaml\n", &t.proyecto()),
            Some(2)
        );
        assert_eq!(
            linea("include:\n  - ../../etc/x.yaml\n", &t.proyecto()),
            Some(2)
        );
    }

    #[test]
    fn env_file_con_traversal_se_rechaza() {
        let t = Tmp::new("envfile");
        assert_eq!(
            linea(
                "services:\n  web:\n    env_file:\n      - ../secreto.env\n",
                &t.proyecto()
            ),
            Some(4)
        );
        assert_eq!(
            linea(
                "services:\n  web:\n    env_file: ../secreto.env\n",
                &t.proyecto()
            ),
            Some(3)
        );
    }

    #[test]
    fn extends_file_con_traversal_se_rechaza() {
        let t = Tmp::new("extends");
        assert_eq!(
            linea(
                "services:\n  web:\n    extends:\n      file: ../secreto.yaml\n      service: base\n",
                &t.proyecto()
            ),
            Some(4)
        );
    }

    #[test]
    fn formas_largas_y_de_flujo_se_revisan() {
        let t = Tmp::new("formas");
        // include con sintaxis larga (`path:`) y con lista de flujo.
        assert_eq!(
            linea("include:\n  - path: ../secreto.yaml\n", &t.proyecto()),
            Some(2)
        );
        assert_eq!(
            linea("include: [../secreto.yaml]\n", &t.proyecto()),
            Some(1)
        );
        // extends con mapa de flujo.
        assert_eq!(
            linea(
                "services:\n  a:\n    extends: {file: ../secreto.yaml, service: b}\n",
                &t.proyecto()
            ),
            Some(3)
        );
        // `project_directory` cambia la base de resolución: también se vigila.
        assert_eq!(
            linea(
                "include:\n  - path: ./ok.yaml\n    project_directory: ../fuera\n",
                &t.proyecto()
            ),
            Some(3)
        );
    }

    #[test]
    fn rutas_absolutas_fuera_se_rechazan_y_dentro_se_aceptan() {
        let t = Tmp::new("absolutas");
        assert_eq!(linea("include:\n  - /etc/passwd\n", &t.proyecto()), Some(2));
        let fuera = t.fuera().join("secreto.yaml");
        let text = format!("include:\n  - {}\n", fuera.display());
        assert_eq!(linea(&text, &t.proyecto()), Some(2));
        let dentro = t.proyecto().join("local.yaml");
        let text = format!("include:\n  - {}\n", dentro.display());
        assert_eq!(linea(&text, &t.proyecto()), None);
    }

    #[test]
    fn rutas_relativas_dentro_del_proyecto_se_aceptan() {
        let t = Tmp::new("dentro");
        fs::create_dir_all(t.proyecto().join("sub")).unwrap();
        let text = "include:\n  - ./sub/local.yaml\n  - sub/../otro.yaml\nenv_file:\n  - .env\n";
        assert_eq!(linea(text, &t.proyecto()), None);
    }

    #[test]
    fn normalizacion_no_permite_escapar_con_puntos() {
        let t = Tmp::new("normal");
        // Con el directorio existente, `..` se resuelve por el sistema: sube al proyecto y sale.
        fs::create_dir_all(t.proyecto().join("a")).unwrap();
        assert_eq!(
            linea("include: ./a/../../fuera/secreto.yaml\n", &t.proyecto()),
            Some(1)
        );
        // Sin el directorio, `..` que no se puede resolver se rechaza igualmente.
        assert_eq!(
            linea("include: ./b/../../fuera/secreto.yaml\n", &t.proyecto()),
            Some(1)
        );
        // `..` que se queda dentro del proyecto no es un escape.
        fs::create_dir_all(t.proyecto().join("c")).unwrap();
        assert_eq!(linea("include: ./c/../local.yaml\n", &t.proyecto()), None);
    }

    #[test]
    fn interpolacion_en_rutas_se_rechaza() {
        let t = Tmp::new("interp");
        assert_eq!(
            linea(
                "services:\n  a:\n    env_file: ${PWD}/../secreto.env\n",
                &t.proyecto()
            ),
            Some(3)
        );
        assert_eq!(linea("env_file: ${DIR:-.}/.env\n", &t.proyecto()), Some(1));
    }

    #[test]
    fn symlink_de_archivo_hacia_fuera_se_rechaza() {
        let t = Tmp::new("symarch");
        symlink(t.fuera().join("secreto.env"), t.proyecto().join(".env")).unwrap();
        assert_eq!(linea("env_file: .env\n", &t.proyecto()), Some(1));
        symlink(
            t.fuera().join("secreto.yaml"),
            t.proyecto().join("link.yaml"),
        )
        .unwrap();
        assert_eq!(linea("include: ./link.yaml\n", &t.proyecto()), Some(1));
    }

    #[test]
    fn symlink_de_directorio_hacia_fuera_se_rechaza_tambien_si_no_existe() {
        let t = Tmp::new("symdir");
        symlink(t.fuera(), t.proyecto().join("dir")).unwrap();
        // El archivo existe fuera a través del directorio enlazado.
        assert_eq!(
            linea("env_file: ./dir/secreto.env\n", &t.proyecto()),
            Some(1)
        );
        // Y tampoco se acepta uno que aún no existe bajo el enlace.
        assert_eq!(linea("env_file: ./dir/nuevo.env\n", &t.proyecto()), Some(1));
    }

    #[test]
    fn symlink_interno_al_proyecto_se_acepta() {
        let t = Tmp::new("syminterno");
        fs::write(t.proyecto().join("real.env"), "A=1\n").unwrap();
        symlink(
            t.proyecto().join("real.env"),
            t.proyecto().join("alias.env"),
        )
        .unwrap();
        assert_eq!(linea("env_file: alias.env\n", &t.proyecto()), None);
    }

    #[test]
    fn include_anidado_que_escapa_se_detecta_en_el_archivo_incluido() {
        let t = Tmp::new("anidado");
        fs::write(
            t.proyecto().join("sub.yaml"),
            "services: {}\ninclude:\n  - ../../fuera/secreto.yaml\n",
        )
        .unwrap();
        fs::write(
            t.proyecto().join("compose.yaml"),
            "include:\n  - ./sub.yaml\n",
        )
        .unwrap();
        let esc =
            find_local_escape_in_file(&t.proyecto().join("compose.yaml"), Some(&t.proyecto()))
                .expect("debe detectar el escape anidado");
        assert_eq!(esc.line, 3);
        assert!(esc.in_included);
    }

    #[test]
    fn includes_circulares_no_cuelgan() {
        let t = Tmp::new("ciclo");
        fs::write(t.proyecto().join("a.yaml"), "include:\n  - ./b.yaml\n").unwrap();
        fs::write(t.proyecto().join("b.yaml"), "include:\n  - ./a.yaml\n").unwrap();
        assert_eq!(
            find_local_escape_in_file(&t.proyecto().join("a.yaml"), Some(&t.proyecto())),
            None
        );
    }

    #[test]
    fn sin_directorio_de_proyecto_toda_ruta_local_se_rechaza() {
        assert_eq!(
            find_local_escape("include:\n  - ./local.yaml\n", None).map(|e| e.line),
            Some(2)
        );
    }

    #[test]
    fn remotos_comentarios_y_claves_ajenas_no_son_escapes() {
        let t = Tmp::new("ajenas");
        let text = "# include: ../secreto.yaml\n\
                    include:\n  - https://example.com/x.yaml\n\
                    services:\n  web:\n    image: alpine\n    labels:\n      file: ../no-es-ruta\n";
        assert_eq!(linea(text, &t.proyecto()), None);
        // Un `file:` fuera del bloque `extends` no es una ruta de Compose que se valide aquí.
        let text = "include:\n  - ./ok.yaml\nservices:\n  web:\n    file: ../fuera\n";
        assert_eq!(linea(text, &t.proyecto()), None);
    }
}
