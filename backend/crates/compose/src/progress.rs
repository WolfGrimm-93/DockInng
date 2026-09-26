//! Parser de `--progress json` (NDJSON por stderr) y cálculo del progreso por servicio.
//!
//! Formato real (Compose 5.5.1): un objeto por línea `{id,status,text[,details,parent_id,
//! current,total,percent]}`; el fin con error es `{"error":true,"message":"..."}`; el éxito
//! no tiene línea final (fin = exit 0).

use std::collections::HashMap;

use serde::Deserialize;

use crate::types::{ProgressItem, ProgressKind, ProgressStatus, ServicePhase, ServiceProgress};
use crate::validate::truncate;

/// Línea máxima procesada (el excedente se descarta).
pub const MAX_LINE_LEN: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum Line {
    Item(ProgressItem),
    /// `{"error":true[,"message":...]}`.
    Error {
        message: Option<String>,
    },
    /// No era JSON de progreso (warnings de compose, modo `plain`...).
    Text(String),
}

#[derive(Deserialize)]
struct RawLine {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    details: Option<String>,
    #[serde(default)]
    current: Option<u64>,
    #[serde(default)]
    total: Option<u64>,
    #[serde(default)]
    percent: Option<f64>,
    #[serde(default)]
    error: Option<bool>,
    #[serde(default)]
    message: Option<String>,
}

fn parse_status(s: &str) -> ProgressStatus {
    match s.to_ascii_lowercase().as_str() {
        "done" => ProgressStatus::Done,
        "warning" => ProgressStatus::Warning,
        "error" => ProgressStatus::Error,
        _ => ProgressStatus::Working,
    }
}

/// `"<Tipo> <nombre>"` o `service:<svc>:<n>`; ids desconocidos → `other`.
pub fn split_id(id: &str) -> (ProgressKind, String) {
    if let Some(rest) = id.strip_prefix("service:") {
        let name = rest.rsplit_once(':').map_or(rest, |(svc, _)| svc);
        return (ProgressKind::Service, name.to_string());
    }
    if let Some((kind, name)) = id.split_once(' ') {
        let kind = match kind {
            "Network" => Some(ProgressKind::Network),
            "Container" => Some(ProgressKind::Container),
            "Volume" => Some(ProgressKind::Volume),
            "Image" => Some(ProgressKind::Image),
            "Service" => Some(ProgressKind::Service),
            _ => None,
        };
        if let Some(k) = kind {
            return (k, name.to_string());
        }
    }
    (ProgressKind::Other, id.to_string())
}

/// Interpreta una línea de stderr de una operación con `--progress json`.
pub fn parse_line(line: &str) -> Line {
    let line = if line.len() > MAX_LINE_LEN {
        truncate(line, MAX_LINE_LEN)
    } else {
        line.to_string()
    };
    let trimmed = line.trim();
    if trimmed.starts_with('{')
        && let Ok(raw) = serde_json::from_str::<RawLine>(trimmed)
    {
        if raw.error == Some(true) {
            return Line::Error {
                message: raw.message.filter(|m| !m.is_empty()),
            };
        }
        if let (Some(id), Some(status)) = (raw.id, raw.status) {
            let (kind, name) = split_id(&id);
            return Line::Item(ProgressItem {
                id,
                kind,
                name,
                status: parse_status(&status),
                text: raw.text.unwrap_or_default(),
                details: raw.details,
                current: raw.current,
                total: raw.total,
                percent: raw.percent,
                parent_id: raw.parent_id,
            });
        }
    }
    Line::Text(trimmed.to_string())
}

/// Respaldo `--progress plain`: ` <Tipo> <nombre> <Estado> `.
pub fn parse_plain_line(line: &str) -> Line {
    let words: Vec<&str> = line.split_whitespace().collect();
    if words.len() >= 3 && line.starts_with(' ') {
        let (kind, name) = split_id(&format!(
            "{} {}",
            words[0],
            words[1..words.len() - 1].join(" ")
        ));
        if kind != ProgressKind::Other {
            let state = words[words.len() - 1];
            let status = match state {
                "Created" | "Started" | "Stopped" | "Removed" | "Healthy" | "Running" | "Done"
                | "Skipped" | "Pulled" | "Exited" => ProgressStatus::Done,
                "Error" => ProgressStatus::Error,
                _ => ProgressStatus::Working,
            };
            return Line::Item(ProgressItem {
                id: format!("{} {}", words[0], name),
                kind,
                name,
                status,
                text: state.to_string(),
                details: None,
                current: None,
                total: None,
                percent: None,
                parent_id: None,
            });
        }
    }
    Line::Text(line.trim().to_string())
}

/// Servicio conocido de la operación (de `config`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownService {
    pub name: String,
    pub image: Option<String>,
}

/// Acumula eventos: deduplica por `(id,status,text,details,current)`, conserva el último
/// estado por id y calcula la instantánea por servicio.
#[derive(Debug)]
pub struct ProgressTracker {
    project: String,
    services: Vec<KnownService>,
    track_services: bool,
    /// Último evento por id (orden de aparición).
    order: Vec<String>,
    latest: HashMap<String, ProgressItem>,
    /// Ids con cambios aún no enviados.
    dirty: Vec<String>,
    percent: HashMap<String, u8>,
    phase: HashMap<String, ServicePhase>,
    frozen: HashMap<String, bool>,
}

impl ProgressTracker {
    pub fn new(project: &str, services: Vec<KnownService>, track_services: bool) -> Self {
        Self {
            project: project.to_string(),
            services,
            track_services,
            order: Vec::new(),
            latest: HashMap::new(),
            dirty: Vec::new(),
            percent: HashMap::new(),
            phase: HashMap::new(),
            frozen: HashMap::new(),
        }
    }

    /// Devuelve `true` si el evento cambió algo (no es un duplicado exacto).
    pub fn ingest(&mut self, item: ProgressItem) -> bool {
        if let Some(prev) = self.latest.get(&item.id) {
            if prev.status == item.status
                && prev.text == item.text
                && prev.details == item.details
                && prev.current == item.current
                && prev.total == item.total
            {
                return false;
            }
        } else {
            // Tope de ids distintos: un daemon/YAML hostil no debe crecer sin límite.
            if self.order.len() >= 4096 {
                return false;
            }
            self.order.push(item.id.clone());
        }
        if self.track_services {
            self.update_service(&item);
        }
        if !self.dirty.contains(&item.id) {
            self.dirty.push(item.id.clone());
        }
        self.latest.insert(item.id.clone(), item);
        true
    }

    /// Extrae (máx. `max`) los ítems cambiados desde la última extracción.
    pub fn drain_changed(&mut self, max: usize) -> Vec<ProgressItem> {
        let n = self.dirty.len().min(max);
        let ids: Vec<String> = self.dirty.drain(..n).collect();
        ids.iter()
            .filter_map(|id| self.latest.get(id).cloned())
            .collect()
    }

    pub fn has_changes(&self) -> bool {
        !self.dirty.is_empty()
    }

    /// Todos los eventos (último estado de cada id), en orden de aparición.
    pub fn all_items(&self) -> Vec<ProgressItem> {
        self.order
            .iter()
            .filter_map(|id| self.latest.get(id).cloned())
            .collect()
    }

    /// El primer ítem con error (para explicar el fallo si no hay mensaje final).
    pub fn first_error(&self) -> Option<&ProgressItem> {
        self.order
            .iter()
            .filter_map(|id| self.latest.get(id))
            .find(|i| i.status == ProgressStatus::Error && !i.text.is_empty())
    }

    fn service_of(&self, item: &ProgressItem) -> Option<String> {
        match item.kind {
            ProgressKind::Service => self
                .services
                .iter()
                .find(|s| s.name == item.name)
                .map(|s| s.name.clone()),
            ProgressKind::Container => {
                for sep in ['-', '_'] {
                    let prefix = format!("{}{}", self.project, sep);
                    if let Some(rest) = item.name.strip_prefix(&prefix) {
                        let (svc, num) = rest.rsplit_once(sep)?;
                        if !num.is_empty()
                            && num.bytes().all(|b| b.is_ascii_digit())
                            && let Some(s) = self.services.iter().find(|s| s.name == svc)
                        {
                            return Some(s.name.clone());
                        }
                    }
                }
                None
            }
            _ => None,
        }
    }

    fn update_service(&mut self, item: &ProgressItem) {
        if item.kind == ProgressKind::Image {
            // Imagen → todos los servicios que la usan.
            let targets: Vec<String> = self
                .services
                .iter()
                .filter(|s| s.image.as_deref() == Some(item.name.as_str()))
                .map(|s| s.name.clone())
                .collect();
            for svc in targets {
                if *self.frozen.get(&svc).unwrap_or(&false) {
                    continue;
                }
                match item.status {
                    ProgressStatus::Working => {
                        let p = item.percent.map_or(1.0, |p| p.clamp(0.0, 100.0));
                        let pct = 1 + (p * 0.39) as u8;
                        self.raise(&svc, pct, ServicePhase::Pulling);
                    }
                    ProgressStatus::Done => self.raise(&svc, 40, ServicePhase::Pulling),
                    _ => {}
                }
            }
            return;
        }
        let Some(svc) = self.service_of(item) else {
            return;
        };
        if item.status == ProgressStatus::Error {
            self.frozen.insert(svc, true);
            return;
        }
        if *self.frozen.get(&svc).unwrap_or(&false) {
            return;
        }
        let text = item.text.to_ascii_lowercase();
        match (item.kind, text.as_str()) {
            (ProgressKind::Container, "creating") => self.raise(&svc, 60, ServicePhase::Creating),
            (ProgressKind::Container, "created") => self.raise(&svc, 65, ServicePhase::Creating),
            (ProgressKind::Container, "starting") => self.raise(&svc, 80, ServicePhase::Creating),
            (ProgressKind::Container, "started" | "running" | "healthy") => {
                self.raise(&svc, 100, ServicePhase::Started)
            }
            _ => {}
        }
    }

    /// Nunca retrocede.
    fn raise(&mut self, svc: &str, pct: u8, phase: ServicePhase) {
        let cur = self.percent.get(svc).copied().unwrap_or(0);
        if pct >= cur {
            self.percent.insert(svc.to_string(), pct);
            self.phase.insert(svc.to_string(), phase);
        }
    }

    /// Instantánea completa (todos los servicios conocidos, en el orden de `config`).
    pub fn services_snapshot(&self) -> Vec<ServiceProgress> {
        if !self.track_services {
            return Vec::new();
        }
        self.services
            .iter()
            .map(|s| ServiceProgress {
                name: s.name.clone(),
                percent: self.percent.get(&s.name).copied().unwrap_or(0),
                phase: self
                    .phase
                    .get(&s.name)
                    .copied()
                    .unwrap_or(ServicePhase::Waiting),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UP: &str = include_str!("../tests/fixtures/up_progress_json.ndjson");
    const UP_ERR: &str = include_str!("../tests/fixtures/up_progress_json_error.ndjson");
    const SIGTERM: &str = include_str!("../tests/fixtures/down_progress_json_sigterm.ndjson");
    const STOP: &str = include_str!("../tests/fixtures/stop_progress_json.ndjson");
    const UNKNOWN: &str = include_str!("../tests/fixtures/up_progress_json_unknown_service.ndjson");
    const PLAIN: &str = include_str!("../tests/fixtures/up_progress_plain.txt");

    fn svcs() -> Vec<KnownService> {
        ["second", "sleeper"]
            .iter()
            .map(|n| KnownService {
                name: (*n).into(),
                image: Some("alpine:latest".into()),
            })
            .collect()
    }

    fn feed(tracker: &mut ProgressTracker, text: &str) -> (usize, Option<Option<String>>) {
        let mut changed = 0;
        let mut err = None;
        for l in text.lines() {
            match parse_line(l) {
                Line::Item(i) => changed += usize::from(tracker.ingest(i)),
                Line::Error { message } => err = Some(message),
                Line::Text(_) => {}
            }
        }
        (changed, err)
    }

    #[test]
    fn up_real_deduplica_y_no_tiene_linea_final() {
        let mut t = ProgressTracker::new("dockinng-test-recon", svcs(), true);
        let (changed, err) = feed(&mut t, UP);
        assert_eq!(err, None, "el éxito no trae línea final");
        // 12 líneas, 2 son duplicados exactos de la red.
        assert_eq!(changed, 10);
        let items = t.drain_changed(200);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].id, "Network dockinng-test-recon_default");
        assert_eq!(items[0].kind, ProgressKind::Network);
        assert_eq!(items[0].status, ProgressStatus::Done);
        assert!(!t.has_changes());
        let snap = t.services_snapshot();
        assert_eq!(snap.len(), 2);
        assert!(
            snap.iter()
                .all(|s| s.percent == 100 && s.phase == ServicePhase::Started)
        );
    }

    #[test]
    fn drain_respeta_el_maximo() {
        let mut t = ProgressTracker::new("dockinng-test-recon", svcs(), true);
        feed(&mut t, UP);
        assert_eq!(t.drain_changed(2).len(), 2);
        assert!(t.has_changes());
        assert_eq!(t.drain_changed(200).len(), 1);
    }

    #[test]
    fn error_de_creacion_congela_y_trae_mensaje() {
        let mut t = ProgressTracker::new(
            "dockinng-test-fail",
            vec![KnownService {
                name: "x".into(),
                image: Some("dockinng-test-noexiste:latest".into()),
            }],
            true,
        );
        let (_, err) = feed(&mut t, UP_ERR);
        assert_eq!(
            err,
            Some(Some(
                "Error response from daemon: No such image: dockinng-test-noexiste:latest".into()
            ))
        );
        let snap = t.services_snapshot();
        // Creating (60) y luego Error en `service:x:1`: se congela en creating.
        assert_eq!(snap[0].phase, ServicePhase::Creating);
        assert_eq!(snap[0].percent, 60);
        let e = t.first_error().unwrap();
        assert_eq!(e.kind, ProgressKind::Service);
        assert_eq!(e.name, "x");
    }

    #[test]
    fn sigterm_da_errores_y_linea_final_sin_message() {
        let mut t = ProgressTracker::new("dockinng-test-recon", svcs(), false);
        let (_, err) = feed(&mut t, SIGTERM);
        assert_eq!(err, Some(None));
        assert_eq!(
            t.first_error().unwrap().details.as_deref(),
            Some("Error while Stopping")
        );
        assert!(t.services_snapshot().is_empty());
    }

    #[test]
    fn servicio_inexistente_es_solo_error() {
        let mut t = ProgressTracker::new("p", svcs(), true);
        let (changed, err) = feed(&mut t, UNKNOWN);
        assert_eq!(changed, 0);
        assert_eq!(err, Some(Some("no such service: nope".into())));
    }

    #[test]
    fn stop_real() {
        let mut t = ProgressTracker::new("dockinng-test-recon", svcs(), false);
        feed(&mut t, STOP);
        let items = t.drain_changed(10);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "Stopped");
    }

    #[test]
    fn lineas_no_json_van_a_texto() {
        assert_eq!(
            parse_line("WARN[0000] algo"),
            Line::Text("WARN[0000] algo".into())
        );
        assert!(matches!(parse_line("{roto"), Line::Text(_)));
        assert!(matches!(parse_line("{\"otra\":1}"), Line::Text(_)));
        assert!(matches!(parse_line(""), Line::Text(_)));
    }

    #[test]
    fn linea_enorme_se_trunca() {
        let big = format!(
            "{{\"id\":\"Container {}\",\"status\":\"Done\"}}",
            "a".repeat(20_000)
        );
        // Truncada → JSON inválido → texto acotado.
        match parse_line(&big) {
            Line::Text(t) => assert!(t.len() <= MAX_LINE_LEN + 4),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn ids_desconocidos_son_other() {
        let Line::Item(i) = parse_line(r#"{"id":"Extraño algo","status":"Working","text":"x"}"#)
        else {
            panic!()
        };
        assert_eq!(i.kind, ProgressKind::Other);
        assert_eq!(i.name, "Extraño algo");
        let Line::Item(i) = parse_line(
            r#"{"id":"Image alpine","status":"Working","text":"Pulling","parent_id":"p","current":5,"total":10,"percent":50.0}"#,
        ) else {
            panic!()
        };
        assert_eq!(
            (i.current, i.total, i.percent),
            (Some(5), Some(10), Some(50.0))
        );
        assert_eq!(i.parent_id.as_deref(), Some("p"));
        // status desconocido no rompe.
        let Line::Item(i) = parse_line(r#"{"id":"Volume v","status":"Rara"}"#) else {
            panic!()
        };
        assert_eq!(i.status, ProgressStatus::Working);
    }

    #[test]
    fn pull_de_imagen_mueve_el_servicio() {
        let mut t = ProgressTracker::new(
            "p",
            vec![KnownService {
                name: "web".into(),
                image: Some("nginx".into()),
            }],
            true,
        );
        let Line::Item(i) =
            parse_line(r#"{"id":"Image nginx","status":"Working","text":"Pulling","percent":50}"#)
        else {
            panic!()
        };
        t.ingest(i);
        let s = &t.services_snapshot()[0];
        assert_eq!(s.phase, ServicePhase::Pulling);
        assert!((1..=40).contains(&s.percent));
        let Line::Item(i) =
            parse_line(r#"{"id":"Container p-web-1","status":"Working","text":"Creating"}"#)
        else {
            panic!()
        };
        t.ingest(i);
        assert_eq!(t.services_snapshot()[0].percent, 60);
        // No retrocede.
        let Line::Item(i) =
            parse_line(r#"{"id":"Image nginx","status":"Working","text":"Pulling","percent":10}"#)
        else {
            panic!()
        };
        t.ingest(i);
        assert_eq!(t.services_snapshot()[0].percent, 60);
    }

    #[test]
    fn tope_de_ids_distintos() {
        let mut t = ProgressTracker::new("p", vec![], false);
        for n in 0..5000 {
            t.ingest(ProgressItem {
                id: format!("Volume v{n}"),
                kind: ProgressKind::Volume,
                name: format!("v{n}"),
                status: ProgressStatus::Done,
                text: "x".into(),
                details: None,
                current: None,
                total: None,
                percent: None,
                parent_id: None,
            });
        }
        assert_eq!(t.all_items().len(), 4096);
    }

    #[test]
    fn respaldo_plain() {
        let mut t = ProgressTracker::new("dockinng-test-recon", svcs(), true);
        for l in PLAIN.lines() {
            if let Line::Item(i) = parse_plain_line(l) {
                t.ingest(i);
            }
        }
        assert_eq!(t.all_items().len(), 3);
        assert!(t.services_snapshot().iter().all(|s| s.percent == 100));
        assert!(matches!(parse_plain_line("mensaje pelado"), Line::Text(_)));
    }
}
