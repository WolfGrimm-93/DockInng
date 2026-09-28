//! Notificaciones de escritorio enviadas DESDE EL BACKEND (sin plugin): la webview no recibe
//! ningún permiso `notification:*`; solo puede pedir un aviso con el comando `notify_user`,
//! que valida el contenido y aplica las preferencias y el anti-ruido.
//!
//! Piezas:
//! - `Notifier`: destino de los avisos (`DesktopNotifier` usa DBus; los tests usan un doble).
//! - `NoiseFilter`: máximo 1 aviso por contenedor cada 30 s y resumen cuando caen varios.
//! - `EventRules`: reglas puras sobre eventos del motor (`die` con código ≠ 0, `oom`,
//!   `health_status: unhealthy`), ignorando paradas intencionadas (`kill` previo).
//! - `run_watcher`: tarea propia que consume los eventos del motor y alimenta el contador de la
//!   bandeja; sigue viva con la ventana oculta (no depende de que la webview procese eventos).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use engine_core::{ApiError, ApiErrorCode, ContainerState, EngineEvent, EngineEventKind};
use futures_util::StreamExt;
use tauri::{AppHandle, Manager, Runtime};

use crate::shell::{NotifyEvents, ShellState};
use crate::state::AppState;

/// Máximo de caracteres del título y del cuerpo de un aviso.
pub const MAX_TITLE_CHARS: usize = 80;
pub const MAX_BODY_CHARS: usize = 240;
/// Ventana mínima entre dos avisos del mismo contenedor.
pub const PER_KEY_WINDOW: Duration = Duration::from_secs(30);
/// Ráfaga: se muestran como mucho `BURST_MAX` avisos individuales por `BURST_WINDOW`.
pub const BURST_WINDOW: Duration = Duration::from_secs(10);
pub const BURST_MAX: u32 = 3;
/// Cuánto tiempo se recuerda un `kill` para reconocer la parada intencionada.
const KILL_MEMORY: Duration = Duration::from_secs(15);
/// Tope de entradas de las tablas de memoria (defensa ante ráfagas de ids distintos).
const MAX_TRACKED: usize = 256;

/// Tipo de aviso (lista cerrada; coincide con las claves de la preferencia `notify_events`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NotifyKind {
    Die,
    Oom,
    Unhealthy,
    OpDone,
}

impl NotifyKind {
    pub fn parse(s: &str) -> Result<Self, ApiError> {
        match s {
            "die" => Ok(Self::Die),
            "oom" => Ok(Self::Oom),
            "unhealthy" => Ok(Self::Unhealthy),
            "op_done" => Ok(Self::OpDone),
            _ => Err(ApiError::new(
                ApiErrorCode::InvalidInput,
                "tipo de notificación desconocido",
            )),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Die => "die",
            Self::Oom => "oom",
            Self::Unhealthy => "unhealthy",
            Self::OpDone => "op_done",
        }
    }
}

impl NotifyEvents {
    pub fn allows(&self, kind: NotifyKind) -> bool {
        match kind {
            NotifyKind::Die => self.die,
            NotifyKind::Oom => self.oom,
            NotifyKind::Unhealthy => self.unhealthy,
            NotifyKind::OpDone => self.op_done,
        }
    }
}

/// Un aviso ya validado y limpio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    pub title: String,
    pub body: String,
}

/// Destino de los avisos.
pub trait Notifier: Send + Sync {
    fn show(&self, notification: &Notification);
}

/// Notificación real por DBus (`org.freedesktop.Notifications`). Un fallo (sin servidor de
/// notificaciones) solo se registra: nunca rompe la app.
pub struct DesktopNotifier;

impl Notifier for DesktopNotifier {
    fn show(&self, n: &Notification) {
        let n = n.clone();
        // `show` bloquea sobre DBus: fuera del hilo que llama.
        std::thread::spawn(move || {
            let res = notify_rust::Notification::new()
                .appname("DockInng")
                .summary(&n.title)
                .body(&n.body)
                .icon("dockinng")
                .show();
            if let Err(e) = res {
                eprintln!("no se pudo mostrar la notificación: {e}");
            }
        });
    }
}

/// Limpia un texto para mostrarlo: sin caracteres de control ni marcado (`<`, `>`, `&`), con
/// espacios colapsados. Los textos de contenedores/imágenes/errores son datos no confiables y
/// los servidores de notificaciones interpretan un subconjunto de HTML.
pub fn clean_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = true;
    for c in s.chars() {
        let c = match c {
            '<' | '>' | '&' => continue,
            c if c.is_control() => ' ',
            c => c,
        };
        if c.is_whitespace() {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim_end().to_string()
}

/// Valida y limpia lo que envía la webview: título obligatorio y longitudes máximas (en
/// caracteres, sobre el texto ORIGINAL; un exceso se rechaza en vez de truncar en silencio).
pub fn validate_user_notification(title: &str, body: &str) -> Result<Notification, ApiError> {
    let invalid = |m: &str| ApiError::new(ApiErrorCode::InvalidInput, m);
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(invalid("título demasiado largo (máximo 80 caracteres)"));
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(invalid("texto demasiado largo (máximo 240 caracteres)"));
    }
    let title = clean_text(title);
    if title.is_empty() {
        return Err(invalid("el título no puede estar vacío"));
    }
    Ok(Notification {
        title,
        body: clean_text(body),
    })
}

/// Resultado de consultar el anti-ruido.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Show,
    Suppress,
}

/// Anti-ruido: 1 aviso por clave (contenedor) cada 30 s y, en una ráfaga, los primeros
/// `BURST_MAX` individuales y el resto agrupado en un resumen.
#[derive(Debug, Default)]
pub struct NoiseFilter {
    per_key: HashMap<String, Instant>,
    burst_start: Option<Instant>,
    burst_shown: u32,
    suppressed: u32,
}

impl NoiseFilter {
    pub fn admit(&mut self, key: &str, now: Instant) -> Verdict {
        if self.per_key.len() >= MAX_TRACKED {
            self.per_key
                .retain(|_, t| now.saturating_duration_since(*t) < PER_KEY_WINDOW);
        }
        if let Some(t) = self.per_key.get(key)
            && now.saturating_duration_since(*t) < PER_KEY_WINDOW
        {
            return Verdict::Suppress;
        }
        let new_burst = self
            .burst_start
            .is_none_or(|s| now.saturating_duration_since(s) >= BURST_WINDOW);
        if new_burst {
            self.burst_start = Some(now);
            self.burst_shown = 0;
        }
        self.per_key.insert(key.to_string(), now);
        if self.burst_shown < BURST_MAX {
            self.burst_shown += 1;
            Verdict::Show
        } else {
            self.suppressed += 1;
            Verdict::Suppress
        }
    }

    /// Cuántos avisos se agruparon, cuando la ráfaga ya terminó (una sola vez).
    pub fn take_summary(&mut self, now: Instant) -> Option<u32> {
        let ended = self
            .burst_start
            .is_none_or(|s| now.saturating_duration_since(s) >= BURST_WINDOW);
        if self.suppressed > 0 && ended {
            let n = self.suppressed;
            self.suppressed = 0;
            self.burst_start = None;
            self.burst_shown = 0;
            Some(n)
        } else {
            None
        }
    }
}

/// Muestra un aviso si las preferencias y el anti-ruido lo permiten. Devuelve si se mostró.
pub fn deliver(
    shell: &ShellState,
    kind: NotifyKind,
    key: &str,
    notification: &Notification,
    now: Instant,
) -> bool {
    let prefs = shell.prefs();
    if !prefs.notify_enabled || !prefs.notify_events.allows(kind) {
        return false;
    }
    let verdict = shell
        .noise
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .admit(key, now);
    if verdict == Verdict::Show {
        shell.notifier.show(notification);
        true
    } else {
        false
    }
}

/// Emite el resumen de avisos agrupados si toca.
pub fn flush_summary(shell: &ShellState, now: Instant) -> bool {
    let n = shell
        .noise
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take_summary(now);
    match n {
        Some(n) if shell.prefs().notify_enabled => {
            shell.notifier.show(&Notification {
                title: "DockInng".into(),
                body: format!("{n} avisos más de contenedores agrupados"),
            });
            true
        }
        _ => false,
    }
}

/// Aviso derivado de un evento del motor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub kind: NotifyKind,
    /// Clave anti-ruido: el id del contenedor.
    pub key: String,
    pub notification: Notification,
}

/// Reglas puras sobre los eventos del motor.
#[derive(Debug, Default)]
pub struct EventRules {
    recent_kills: HashMap<String, Instant>,
}

impl EventRules {
    pub fn evaluate(
        &mut self,
        ev: &EngineEvent,
        enabled: &NotifyEvents,
        now: Instant,
    ) -> Option<Candidate> {
        if ev.kind != EngineEventKind::Container {
            return None;
        }
        let name = || {
            let raw = ev
                .attributes
                .get("name")
                .cloned()
                .or_else(|| ev.name.clone())
                .unwrap_or_else(|| ev.id.chars().take(12).collect());
            clean_text(&raw)
        };
        let make = |kind, title: &str, body: String| Candidate {
            kind,
            key: ev.id.clone(),
            notification: Notification {
                title: title.into(),
                body,
            },
        };
        match ev.action.as_str() {
            // Una señal enviada a propósito (`docker stop`/`kill`) precede a su `die`.
            "kill" => {
                if self.recent_kills.len() >= MAX_TRACKED {
                    self.recent_kills
                        .retain(|_, t| now.saturating_duration_since(*t) < KILL_MEMORY);
                }
                self.recent_kills.insert(ev.id.clone(), now);
                None
            }
            "die" if enabled.die => {
                let code: i64 = ev.attributes.get("exitCode")?.parse().ok()?;
                if code == 0 {
                    return None;
                }
                let intentional = self
                    .recent_kills
                    .remove(&ev.id)
                    .is_some_and(|t| now.saturating_duration_since(t) < KILL_MEMORY);
                if intentional {
                    return None;
                }
                Some(make(
                    NotifyKind::Die,
                    "Contenedor detenido con error",
                    format!("{} terminó con código {code}", name()),
                ))
            }
            "oom" if enabled.oom => Some(make(
                NotifyKind::Oom,
                "Contenedor sin memoria",
                format!("{} fue terminado por falta de memoria (OOM)", name()),
            )),
            "health_status: unhealthy" if enabled.unhealthy => Some(make(
                NotifyKind::Unhealthy,
                "Contenedor no saludable",
                format!("{} no supera su comprobación de salud", name()),
            )),
            _ => None,
        }
    }
}

/// Acciones de contenedor tras las que cambia el número de contenedores en marcha.
fn changes_running(action: &str) -> bool {
    matches!(
        action,
        "start" | "die" | "stop" | "kill" | "destroy" | "restart" | "pause" | "unpause" | "oom"
    )
}

/// Cuenta los contenedores en marcha y lo guarda en el estado (y en la bandeja).
async fn refresh_running(state: &AppState) {
    if !state.shell.tray_alive() {
        return;
    }
    if let Ok(list) = state.engine.list_containers(false).await {
        let n = list
            .iter()
            .filter(|c| c.state == ContainerState::Running)
            .count();
        state.shell.set_running(n);
    }
}

const RETRY_START: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(30);
const COUNT_DEBOUNCE: Duration = Duration::from_secs(2);
const SUMMARY_TICK: Duration = Duration::from_secs(5);

/// Tarea permanente: consume los eventos del motor para avisar y mantener el contador de la
/// bandeja. Se reconecta con espera creciente (motor apagado, cambio de conexión).
pub async fn run_watcher<R: Runtime>(app: AppHandle<R>) {
    let mut backoff = RETRY_START;
    let mut rules = EventRules::default();
    loop {
        let state = app.state::<AppState>();
        let engine = state.engine.clone();
        refresh_running(&state).await;
        let mut stream = engine.events();
        let mut got_any = false;
        let mut count_due: Option<tokio::time::Instant> = None;
        let mut tick = tokio::time::interval(SUMMARY_TICK);
        loop {
            tokio::select! {
                item = stream.next() => match item {
                    Some(Ok(ev)) => {
                        got_any = true;
                        let now = Instant::now();
                        let enabled = state.shell.prefs().notify_events;
                        if let Some(c) = rules.evaluate(&ev, &enabled, now) {
                            deliver(&state.shell, c.kind, &c.key, &c.notification, now);
                        }
                        if ev.kind == EngineEventKind::Container
                            && changes_running(&ev.action)
                            && count_due.is_none()
                        {
                            count_due = Some(tokio::time::Instant::now() + COUNT_DEBOUNCE);
                        }
                    }
                    Some(Err(_)) | None => break,
                },
                _ = tick.tick() => {
                    flush_summary(&state.shell, Instant::now());
                }
                _ = async {
                    match count_due {
                        Some(t) => tokio::time::sleep_until(t).await,
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    count_due = None;
                    refresh_running(&state).await;
                }
            }
        }
        if got_any {
            backoff = RETRY_START;
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(RETRY_MAX);
    }
}

/// Doble de pruebas: guarda los avisos recibidos.
#[cfg(test)]
pub mod testing {
    use std::sync::{Arc, Mutex};

    use super::{Notification, Notifier};

    #[derive(Default)]
    pub struct MockNotifier {
        shown: Mutex<Vec<Notification>>,
    }

    impl MockNotifier {
        pub fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        pub fn shown(&self) -> Vec<Notification> {
            self.shown.lock().unwrap().clone()
        }
    }

    impl Notifier for MockNotifier {
        fn show(&self, n: &Notification) {
            self.shown.lock().unwrap().push(n.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use std::sync::Arc;

    use super::testing::MockNotifier;
    use super::*;

    fn ev(action: &str, id: &str, attrs: &[(&str, &str)]) -> EngineEvent {
        EngineEvent {
            kind: EngineEventKind::Container,
            action: action.into(),
            id: id.into(),
            name: None,
            time_nano: 0,
            attributes: attrs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<BTreeMap<_, _>>(),
        }
    }

    fn shell_with(notifier: Arc<MockNotifier>, enabled: bool) -> ShellState {
        let s = ShellState::with_notifier(notifier);
        let mut p = s.prefs();
        p.notify_enabled = enabled;
        s.set_prefs(p);
        s
    }

    fn note(t: &str) -> Notification {
        Notification {
            title: t.into(),
            body: String::new(),
        }
    }

    #[test]
    fn die_con_codigo_distinto_de_cero_avisa() {
        let mut r = EventRules::default();
        let t = Instant::now();
        let all = NotifyEvents::default();
        let e = ev("die", "c1", &[("exitCode", "1"), ("name", "web")]);
        let c = r.evaluate(&e, &all, t).expect("aviso");
        assert_eq!(c.kind, NotifyKind::Die);
        assert!(c.notification.body.contains("web") && c.notification.body.contains('1'));
        assert!(
            r.evaluate(&ev("die", "c1", &[("exitCode", "0")]), &all, t)
                .is_none()
        );
        // Sin código o con código no numérico: no se avisa.
        assert!(r.evaluate(&ev("die", "c1", &[]), &all, t).is_none());
        assert!(
            r.evaluate(&ev("die", "c1", &[("exitCode", "x")]), &all, t)
                .is_none()
        );
    }

    #[test]
    fn una_parada_intencionada_no_avisa_pero_una_caida_posterior_si() {
        let mut r = EventRules::default();
        let t = Instant::now();
        let all = NotifyEvents::default();
        assert!(
            r.evaluate(&ev("kill", "c1", &[("signal", "15")]), &all, t)
                .is_none()
        );
        // `docker stop` a un contenedor que no atiende SIGTERM: die 137 tras el kill.
        assert!(
            r.evaluate(&ev("die", "c1", &[("exitCode", "137")]), &all, t)
                .is_none()
        );
        // El kill se consume: la siguiente caída sí avisa.
        assert!(
            r.evaluate(&ev("die", "c1", &[("exitCode", "137")]), &all, t)
                .is_some()
        );
        // Un kill antiguo (>15 s) ya no excusa la caída.
        r.evaluate(&ev("kill", "c2", &[]), &all, t);
        let late = t + Duration::from_secs(16);
        assert!(
            r.evaluate(&ev("die", "c2", &[("exitCode", "1")]), &all, late)
                .is_some()
        );
    }

    #[test]
    fn oom_y_unhealthy_avisan_y_respetan_los_eventos_activos() {
        let mut r = EventRules::default();
        let t = Instant::now();
        let all = NotifyEvents::default();
        assert_eq!(
            r.evaluate(&ev("oom", "c1", &[]), &all, t).unwrap().kind,
            NotifyKind::Oom
        );
        assert_eq!(
            r.evaluate(&ev("health_status: unhealthy", "c1", &[]), &all, t)
                .unwrap()
                .kind,
            NotifyKind::Unhealthy
        );
        assert!(
            r.evaluate(&ev("health_status: healthy", "c1", &[]), &all, t)
                .is_none()
        );
        let off = NotifyEvents {
            oom: false,
            unhealthy: false,
            die: false,
            op_done: true,
        };
        assert!(r.evaluate(&ev("oom", "c1", &[]), &off, t).is_none());
        assert!(
            r.evaluate(&ev("health_status: unhealthy", "c1", &[]), &off, t)
                .is_none()
        );
        assert!(
            r.evaluate(&ev("die", "c1", &[("exitCode", "2")]), &off, t)
                .is_none()
        );
    }

    #[test]
    fn eventos_que_no_son_de_contenedor_se_ignoran() {
        let mut r = EventRules::default();
        let mut e = ev("oom", "x", &[]);
        e.kind = EngineEventKind::Image;
        assert!(
            r.evaluate(&e, &NotifyEvents::default(), Instant::now())
                .is_none()
        );
    }

    #[test]
    fn el_nombre_del_contenedor_se_limpia_de_marcado() {
        let mut r = EventRules::default();
        let e = ev("oom", "c1", &[("name", "<b>x</b>&amp;\u{7}")]);
        let c = r
            .evaluate(&e, &NotifyEvents::default(), Instant::now())
            .unwrap();
        for bad in ['<', '>', '&', '\u{7}'] {
            assert!(!c.notification.body.contains(bad), "{bad}");
        }
    }

    #[test]
    fn maximo_un_aviso_por_contenedor_cada_30_segundos() {
        let mut f = NoiseFilter::default();
        let t = Instant::now();
        assert_eq!(f.admit("c1", t), Verdict::Show);
        assert_eq!(
            f.admit("c1", t + Duration::from_secs(29)),
            Verdict::Suppress
        );
        assert_eq!(f.admit("c1", t + Duration::from_secs(31)), Verdict::Show);
        // Otro contenedor no queda afectado.
        assert_eq!(f.admit("c2", t + Duration::from_secs(1)), Verdict::Show);
    }

    #[test]
    fn una_rafaga_muestra_tres_y_agrupa_el_resto_en_un_resumen() {
        let mut f = NoiseFilter::default();
        let t = Instant::now();
        let verdicts: Vec<Verdict> = (0..6)
            .map(|i| f.admit(&format!("c{i}"), t + Duration::from_millis(i)))
            .collect();
        assert_eq!(
            verdicts.iter().filter(|v| **v == Verdict::Show).count(),
            BURST_MAX as usize
        );
        // La ráfaga sigue abierta: aún no hay resumen.
        assert_eq!(f.take_summary(t + Duration::from_secs(2)), None);
        assert_eq!(
            f.take_summary(t + BURST_WINDOW + Duration::from_secs(1)),
            Some(3)
        );
        // Una sola vez.
        assert_eq!(
            f.take_summary(t + BURST_WINDOW + Duration::from_secs(2)),
            None
        );
    }

    #[test]
    fn deliver_respeta_el_interruptor_general_y_el_anti_ruido() {
        let n = MockNotifier::new();
        let off = shell_with(n.clone(), false);
        let t = Instant::now();
        assert!(!deliver(&off, NotifyKind::Die, "c1", &note("x"), t));
        assert!(n.shown().is_empty());

        let on = shell_with(n.clone(), true);
        assert!(deliver(&on, NotifyKind::Die, "c1", &note("uno"), t));
        assert!(!deliver(&on, NotifyKind::Die, "c1", &note("dup"), t));
        assert_eq!(n.shown(), vec![note("uno")]);
    }

    #[test]
    fn deliver_respeta_los_eventos_apagados() {
        let n = MockNotifier::new();
        let s = shell_with(n.clone(), true);
        s.apply_pref("notify_events", &serde_json::json!({"op_done": false}));
        let t = Instant::now();
        assert!(!deliver(&s, NotifyKind::OpDone, "k", &note("x"), t));
        assert!(deliver(&s, NotifyKind::Die, "k", &note("x"), t));
    }

    #[test]
    fn el_resumen_se_muestra_como_un_solo_aviso() {
        let n = MockNotifier::new();
        let s = shell_with(n.clone(), true);
        let t = Instant::now();
        for i in 0..5 {
            deliver(
                &s,
                NotifyKind::Die,
                &format!("c{i}"),
                &note(&format!("n{i}")),
                t,
            );
        }
        assert_eq!(n.shown().len(), BURST_MAX as usize);
        assert!(!flush_summary(&s, t));
        assert!(flush_summary(&s, t + BURST_WINDOW + Duration::from_secs(1)));
        let last = n.shown().pop().unwrap();
        assert!(last.body.starts_with("2 avisos"));
    }

    #[test]
    fn validacion_de_lo_que_envia_la_webview() {
        let ok = validate_user_notification("Build listo", "imagen <b>web</b> & más").unwrap();
        assert_eq!(ok.title, "Build listo");
        assert_eq!(ok.body, "imagen bweb/b más");
        assert!(validate_user_notification("", "x").is_err());
        assert!(validate_user_notification("  <>  ", "x").is_err());
        assert!(validate_user_notification(&"a".repeat(81), "").is_err());
        assert!(validate_user_notification("t", &"a".repeat(241)).is_err());
        assert!(validate_user_notification(&"a".repeat(80), &"b".repeat(240)).is_ok());
        let ctrl = validate_user_notification("a\u{0}b\nc", "x\ty").unwrap();
        assert_eq!(ctrl.title, "a b c");
        assert_eq!(ctrl.body, "x y");
    }

    #[test]
    fn tipo_de_aviso_en_lista_cerrada() {
        for k in ["die", "oom", "unhealthy", "op_done"] {
            assert_eq!(NotifyKind::parse(k).unwrap().as_str(), k);
        }
        for bad in ["", "DIE", "die ", "start", "../x"] {
            let e = NotifyKind::parse(bad).unwrap_err();
            assert_eq!(e.code, ApiErrorCode::InvalidInput);
        }
    }
}
