//! Descarga de imágenes: contrato del motor, seguidor de progreso por capas (puro) y
//! clasificador de errores del registro. Probado con NDJSON real de un pull.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::api::ApiErrorCode;
use crate::client::EngineStream;
use crate::error::EngineError;

/// Tope de capas que se siguen (una imagen real rara vez pasa de ~120).
pub const MAX_LAYERS: usize = 256;
/// Largo máximo del id de una capa.
pub const MAX_LAYER_ID: usize = 64;
/// Largo máximo de una referencia de imagen.
pub const MAX_REFERENCE: usize = 255;

/// Evento crudo del daemon, ya independiente del cliente.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullEvent {
    pub id: Option<String>,
    pub status: String,
    pub current: Option<u64>,
    pub total: Option<u64>,
}

#[async_trait]
pub trait PullEngine: Send + Sync {
    /// Valida en la primera lectura; soltar el stream aborta la descarga en el daemon.
    fn pull_image(&self, reference: &str) -> EngineStream<PullEvent>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayerPhase {
    Waiting,
    Downloading,
    Downloaded,
    Extracting,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayerProgress {
    pub id: String,
    pub phase: LayerPhase,
    pub total: u64,
    pub done: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PullSnapshot {
    pub layers: Vec<LayerProgress>,
    pub done_bytes: u64,
    pub total_bytes: u64,
}

/// Acumula eventos y produce instantáneas. Puro: sin E/S ni reloj.
#[derive(Debug, Default)]
pub struct PullTracker {
    layers: Vec<LayerProgress>,
    up_to_date: bool,
    digest: Option<String>,
    /// Sube en cada cambio observable; sirve para coalescer sin comparar instantáneas.
    revision: u64,
}

fn valid_layer_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_LAYER_ID && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

impl PullTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn up_to_date(&self) -> bool {
        self.up_to_date
    }

    pub fn digest(&self) -> Option<&str> {
        self.digest.as_deref()
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn feed(&mut self, ev: &PullEvent) {
        let status = ev.status.trim();
        // Eventos sin capa: resumen final del daemon.
        if let Some(d) = status.strip_prefix("Digest:") {
            let d = d.trim();
            if d.len() <= 128 && d.bytes().all(|b| b.is_ascii_alphanumeric() || b == b':') {
                self.digest = Some(d.to_string());
                self.revision += 1;
            }
            return;
        }
        if status.starts_with("Status:") {
            if status.contains("Image is up to date") {
                self.up_to_date = true;
                self.revision += 1;
            }
            return;
        }
        let Some(id) = ev.id.as_deref() else { return };
        // El primer evento ("Pulling from repo") lleva el tag como id: no es una capa.
        if status.starts_with("Pulling from") || !valid_layer_id(id) {
            return;
        }
        let phase = match status {
            "Pulling fs layer" | "Waiting" => LayerPhase::Waiting,
            "Downloading" => LayerPhase::Downloading,
            "Verifying Checksum" | "Download complete" => LayerPhase::Downloaded,
            "Extracting" => LayerPhase::Extracting,
            "Pull complete" | "Already exists" => LayerPhase::Complete,
            _ => return,
        };
        let idx = match self.layers.iter().position(|l| l.id == id) {
            Some(i) => i,
            None => {
                if self.layers.len() >= MAX_LAYERS {
                    return;
                }
                self.layers.push(LayerProgress {
                    id: id.to_string(),
                    phase,
                    total: 0,
                    done: 0,
                });
                self.layers.len() - 1
            }
        };
        let before = self.layers[idx].clone();
        let l = &mut self.layers[idx];
        // Las fases no retroceden (los eventos "Downloading" pueden llegar repetidos o tarde).
        if phase_rank(phase) >= phase_rank(l.phase) {
            l.phase = phase;
        }
        if let Some(t) = ev.total.filter(|t| *t > 0)
            && matches!(phase, LayerPhase::Downloading | LayerPhase::Waiting)
        {
            l.total = l.total.max(t);
        }
        match phase {
            LayerPhase::Downloading => {
                if let Some(c) = ev.current {
                    l.done = l.done.max(if l.total > 0 { c.min(l.total) } else { c });
                }
            }
            // Descargada o más: los bytes se dan por completos.
            LayerPhase::Downloaded | LayerPhase::Extracting | LayerPhase::Complete => {
                l.done = l.total;
            }
            LayerPhase::Waiting => {}
        }
        if *l != before {
            self.revision += 1;
        }
    }

    pub fn snapshot(&self) -> PullSnapshot {
        PullSnapshot {
            done_bytes: self.layers.iter().map(|l| l.done).sum(),
            total_bytes: self.layers.iter().map(|l| l.total).sum(),
            layers: self.layers.clone(),
        }
    }
}

fn phase_rank(p: LayerPhase) -> u8 {
    match p {
        LayerPhase::Waiting => 0,
        LayerPhase::Downloading => 1,
        LayerPhase::Downloaded => 2,
        LayerPhase::Extracting => 3,
        LayerPhase::Complete => 4,
    }
}

/// Separa `from_image` y `tag` de una referencia, cuidando el puerto del registro:
/// `localhost:54109/x:1` -> (`localhost:54109/x`, `1`); `repo@sha256:..` no lleva tag.
pub fn split_reference(reference: &str) -> (String, Option<String>) {
    if reference.contains('@') {
        return (reference.to_string(), None);
    }
    match reference.rsplit_once(':') {
        Some((repo, tag)) if !tag.contains('/') && !repo.is_empty() => {
            (repo.to_string(), Some(tag.to_string()))
        }
        _ => (reference.to_string(), Some("latest".to_string())),
    }
}

/// Valida una referencia de imagen para el pull (más estricta que `validate::image_reference`).
pub fn validate_reference(reference: &str) -> Result<(), EngineError> {
    if reference.is_empty() || reference.len() > MAX_REFERENCE {
        return Err(EngineError::InvalidInput(
            "la referencia de la imagen está vacía o es demasiado larga".into(),
        ));
    }
    crate::validate::image_reference(reference)?;
    // `nginx:` (dos puntos sin tag) generaría un tag vacío: se rechaza.
    if !reference.contains('@') && reference.ends_with(':') {
        return Err(EngineError::InvalidInput(
            "la referencia tiene ':' sin etiqueta (tag)".into(),
        ));
    }
    // El daemon exige minúsculas en el repositorio; el resto lo valida él (400).
    Ok(())
}

/// Clasifica el error de un pull (HTTP previo al stream o `errorDetail` a mitad de stream).
/// `None` = usar la clasificación estándar por estado HTTP.
pub fn classify_pull_error(status: Option<u16>, message: &str) -> Option<EngineError> {
    let m = message.to_ascii_lowercase();
    let coded = |c: ApiErrorCode| Some(EngineError::coded(c, message));
    if status == Some(400) || m.contains("invalid reference format") {
        return Some(EngineError::InvalidInput(message.to_string()));
    }
    // Primero la autenticación: "pull access denied, repository does not exist or may require
    // authorization" es ambiguo (imagen inexistente o privada) y el daemon lo dice así.
    if m.contains("pull access denied")
        || m.contains("authorization failed")
        || m.contains("unauthorized")
        || m.contains("requested access to the resource is denied")
        || m.contains("denied:")
    {
        return coded(ApiErrorCode::AuthRequired);
    }
    if m.contains("toomanyrequests")
        || m.contains("too many requests")
        || status == Some(429)
        || m.contains("no space left")
    {
        return Some(EngineError::Engine {
            status: status.unwrap_or(500),
            message: message.to_string(),
        });
    }
    if m.contains("connection refused")
        || m.contains("no such host")
        || m.contains("dial tcp")
        || m.contains("i/o timeout")
        || m.contains("tls")
        || m.contains("lookup ")
        || m.contains("unreachable")
        || m.contains("deadline exceeded")
        || m.contains("failed to do request")
    {
        return coded(ApiErrorCode::RegistryUnreachable);
    }
    if status == Some(404) || m.contains("not found") || m.contains("manifest unknown") {
        return coded(ApiErrorCode::ImageMissing);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(ndjson: &str) -> Vec<PullEvent> {
        ndjson
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| {
                let v: serde_json::Value = serde_json::from_str(l).expect("json");
                PullEvent {
                    id: v["id"].as_str().map(String::from),
                    status: v["status"].as_str().unwrap_or_default().into(),
                    current: v["progressDetail"]["current"].as_u64(),
                    total: v["progressDetail"]["total"].as_u64(),
                }
            })
            .collect()
    }

    const REAL: &str = include_str!("../tests/fixtures/pull/pull_layers_bollard.ndjson");

    #[test]
    fn ndjson_real_produce_tres_capas_completas() {
        let mut t = PullTracker::new();
        for e in events(REAL) {
            t.feed(&e);
        }
        let s = t.snapshot();
        assert_eq!(s.layers.len(), 3, "{s:?}");
        assert!(s.layers.iter().all(|l| l.phase == LayerPhase::Complete));
        assert_eq!(s.total_bytes, 2_001_759 + 3_002_106 + 5_001_771);
        assert_eq!(s.done_bytes, s.total_bytes);
        assert!(t.digest().is_some_and(|d| d.starts_with("sha256:")));
        assert!(!t.up_to_date());
        // El id "1" (tag) no es una capa.
        assert!(s.layers.iter().all(|l| l.id != "1"));
    }

    #[test]
    fn el_progreso_nunca_retrocede_ni_supera_el_total() {
        let mut t = PullTracker::new();
        let ev = |st: &str, c: Option<u64>, tot: Option<u64>| PullEvent {
            id: Some("abc123".into()),
            status: st.into(),
            current: c,
            total: tot,
        };
        t.feed(&ev("Pulling fs layer", None, None));
        t.feed(&ev("Downloading", Some(500), Some(1000)));
        t.feed(&ev("Downloading", Some(100), Some(1000)));
        assert_eq!(t.snapshot().layers[0].done, 500);
        t.feed(&ev("Downloading", Some(9999), Some(1000)));
        assert_eq!(t.snapshot().layers[0].done, 1000);
        t.feed(&ev("Pull complete", None, None));
        // Un "Downloading" tardío no baja la fase.
        t.feed(&ev("Downloading", Some(10), Some(1000)));
        assert_eq!(t.snapshot().layers[0].phase, LayerPhase::Complete);
    }

    #[test]
    fn imagen_ya_actualizada() {
        let mut t = PullTracker::new();
        for e in events(
            r#"{"id":"1","status":"Pulling from x/y"}
{"status":"Digest: sha256:abcd"}
{"status":"Status: Image is up to date for x/y:1"}"#,
        ) {
            t.feed(&e);
        }
        assert!(t.up_to_date());
        assert_eq!(t.digest(), Some("sha256:abcd"));
        assert!(t.snapshot().layers.is_empty());
    }

    #[test]
    fn capa_sin_total_no_rompe_y_ids_hostiles_se_descartan() {
        let mut t = PullTracker::new();
        let mk = |id: &str| PullEvent {
            id: Some(id.into()),
            status: "Downloading".into(),
            current: Some(10),
            total: None,
        };
        t.feed(&mk("abc"));
        assert_eq!(t.snapshot().layers[0].total, 0);
        for bad in ["", "a/b", "x y", "<script>", &"a".repeat(65), "..", "a\nb"] {
            t.feed(&mk(bad));
        }
        assert_eq!(t.snapshot().layers.len(), 1);
    }

    #[test]
    fn tope_de_256_capas() {
        let mut t = PullTracker::new();
        for i in 0..400 {
            t.feed(&PullEvent {
                id: Some(format!("l{i}")),
                status: "Pulling fs layer".into(),
                current: None,
                total: None,
            });
        }
        assert_eq!(t.snapshot().layers.len(), MAX_LAYERS);
    }

    #[test]
    fn la_revision_solo_sube_si_algo_cambia() {
        let mut t = PullTracker::new();
        let e = PullEvent {
            id: Some("abc".into()),
            status: "Downloading".into(),
            current: Some(5),
            total: Some(10),
        };
        t.feed(&e);
        let r = t.revision();
        t.feed(&e);
        assert_eq!(t.revision(), r);
    }

    #[test]
    fn separa_repositorio_y_tag_cuidando_el_puerto() {
        assert_eq!(
            split_reference("localhost:54109/x/y:1"),
            ("localhost:54109/x/y".into(), Some("1".into()))
        );
        assert_eq!(
            split_reference("localhost:54109/x"),
            ("localhost:54109/x".into(), Some("latest".into()))
        );
        assert_eq!(
            split_reference("alpine"),
            ("alpine".into(), Some("latest".into()))
        );
        assert_eq!(
            split_reference("alpine:3.20"),
            ("alpine".into(), Some("3.20".into()))
        );
        assert_eq!(
            split_reference("repo@sha256:abcd"),
            ("repo@sha256:abcd".into(), None)
        );
    }

    #[test]
    fn validacion_de_referencias() {
        assert!(validate_reference("alpine:latest").is_ok());
        assert!(validate_reference("localhost:5000/x").is_ok());
        for bad in [
            "",
            "a b",
            "--x",
            "a/../b",
            &"a".repeat(256),
            "x\ny",
            "nginx:",
            "localhost:5000/x:",
        ] {
            assert!(validate_reference(bad).is_err(), "{bad:?}");
        }
    }

    fn code(status: Option<u16>, msg: &str) -> Option<ApiErrorCode> {
        match classify_pull_error(status, msg)? {
            EngineError::Coded { code, .. } => Some(code),
            EngineError::InvalidInput(_) => Some(ApiErrorCode::InvalidInput),
            EngineError::Engine { .. } => Some(ApiErrorCode::Engine),
            _ => None,
        }
    }

    #[test]
    fn tabla_real_de_errores_de_pull() {
        use ApiErrorCode::*;
        assert_eq!(
            code(Some(400), "invalid reference format"),
            Some(InvalidInput)
        );
        assert_eq!(
            code(
                Some(400),
                "invalid reference format: repository name (dockinng-test/BAD) must be lowercase"
            ),
            Some(InvalidInput)
        );
        assert_eq!(
            code(
                Some(404),
                "failed to resolve reference \"x:1\": x:1: not found"
            ),
            Some(ImageMissing)
        );
        assert_eq!(
            code(
                Some(500),
                "failed to resolve reference \"x\": pull access denied, repository does not exist or may require authorization: authorization failed: no basic auth credentials"
            ),
            Some(AuthRequired)
        );
        assert_eq!(
            code(
                Some(500),
                "failed to resolve reference \"localhost:1/x:1\": failed to do request: Head \"https://localhost:1/v2/x/manifests/1\": dial tcp [::1]:1: connect: connection refused"
            ),
            Some(RegistryUnreachable)
        );
        assert_eq!(code(Some(500), "toomanyrequests: rate limit"), Some(Engine));
        assert_eq!(code(None, "write: no space left on device"), Some(Engine));
        assert_eq!(code(None, "manifest unknown"), Some(ImageMissing));
        assert_eq!(code(Some(500), "algo raro"), None);
    }
}
