//! Estado del «shell» de escritorio: preferencias de ventana/bandeja/notificaciones cacheadas,
//! estado de la bandeja, decisión de cierre y resumen de operaciones en curso.
//!
//! La lógica de decisión es pura (sin Tauri) para poder probarla sin sesión gráfica; las piezas
//! que tocan la ventana real viven en `tray.rs`, `window_ctl.rs` y `lib.rs`.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;

use crate::notify::{DesktopNotifier, NoiseFilter, Notifier};
use crate::tray::TrayControl;

/// Qué eventos se notifican (todos activos si la preferencia nunca se guardó).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotifyEvents {
    pub die: bool,
    pub oom: bool,
    pub unhealthy: bool,
    pub op_done: bool,
}

impl Default for NotifyEvents {
    fn default() -> Self {
        Self {
            die: true,
            oom: true,
            unhealthy: true,
            op_done: true,
        }
    }
}

/// Copia en memoria de las preferencias del shell (la fuente de verdad es el almacén).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShellPrefs {
    /// Apagado por defecto: las notificaciones son opt-in.
    pub notify_enabled: bool,
    pub notify_events: NotifyEvents,
    pub tray_enabled: bool,
    /// Apagado por defecto: si no, «la app no cierra» sorprende al usuario.
    pub close_to_tray: bool,
    pub window_decorations: bool,
    pub start_minimized: bool,
}

impl Default for ShellPrefs {
    fn default() -> Self {
        Self {
            notify_enabled: false,
            notify_events: NotifyEvents::default(),
            tray_enabled: true,
            close_to_tray: false,
            window_decorations: true,
            start_minimized: false,
        }
    }
}

impl ShellPrefs {
    /// Aplica una preferencia ya validada por el almacén; `null` restaura el valor por defecto.
    /// Devuelve `false` si la clave no pertenece al shell.
    pub fn apply(&mut self, key: &str, value: &Value) -> bool {
        let def = ShellPrefs::default();
        let flag = |default: bool| value.as_bool().unwrap_or(default);
        match key {
            "notify_enabled" => self.notify_enabled = flag(def.notify_enabled),
            "tray_enabled" => self.tray_enabled = flag(def.tray_enabled),
            "close_to_tray" => self.close_to_tray = flag(def.close_to_tray),
            "window_decorations" => self.window_decorations = flag(def.window_decorations),
            "start_minimized" => self.start_minimized = flag(def.start_minimized),
            "notify_events" => {
                let mut ev = NotifyEvents::default();
                if let Some(map) = value.as_object() {
                    let get = |k: &str, d: bool| map.get(k).and_then(Value::as_bool).unwrap_or(d);
                    ev.die = get("die", ev.die);
                    ev.oom = get("oom", ev.oom);
                    ev.unhealthy = get("unhealthy", ev.unhealthy);
                    ev.op_done = get("op_done", ev.op_done);
                }
                self.notify_events = ev;
            }
            _ => return false,
        }
        true
    }
}

/// Estado de la bandeja de sistema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TrayStatus {
    /// La bandeja existe (se pudo crear).
    pub available: bool,
    /// Por qué no se pudo crear (p. ej. falta libayatana/libappindicator).
    pub error: Option<String>,
}

/// Operaciones en curso que un cierre interrumpiría.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct BusySummary {
    /// Operaciones de stack (`up`/`down`/...).
    pub stacks: u32,
    /// Descargas de imagen.
    pub pulls: u32,
    /// Builds de imagen.
    pub builds: u32,
    /// Terminales exec abiertas.
    pub terminals: u32,
}

impl BusySummary {
    pub fn total(&self) -> u32 {
        self.stacks + self.pulls + self.builds + self.terminals
    }

    pub fn is_idle(&self) -> bool {
        self.total() == 0
    }
}

/// Mensajes del backend a la UI por el canal de `subscribe_app_events` (no se usan eventos de
/// Tauri: escucharlos exigiría un permiso `core:event:*` para la webview).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AppFeed {
    /// Se pidió salir (cerrar la ventana o «Salir» de la bandeja) con operaciones en curso: la
    /// UI confirma y responde con `quit_app(true)`.
    QuitRequested { summary: BusySummary },
    /// La ventana se ocultó a la bandeja o volvió a mostrarse.
    WindowVisibility { visible: bool },
}

/// Qué hacer ante una petición de cierre de la ventana principal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Cerrar normalmente (la app termina).
    Allow,
    /// Ocultar la ventana; la app sigue en la bandeja.
    HideToTray,
    /// Impedir el cierre y pedir confirmación a la UI con el resumen.
    AskConfirmation(BusySummary),
}

/// Decisión de cierre (pura).
/// - `quitting`: ya se confirmó la salida; se deja cerrar sin más preguntas.
/// - Con `close_to_tray` activo y la bandeja viva se oculta (las operaciones siguen en segundo
///   plano). Sin bandeja `close_to_tray` se ignora: la app quedaría invisible e inalcanzable.
pub fn decide_close(
    prefs: &ShellPrefs,
    tray_alive: bool,
    busy: BusySummary,
    quitting: bool,
) -> CloseAction {
    if quitting {
        return CloseAction::Allow;
    }
    if prefs.close_to_tray && prefs.tray_enabled && tray_alive {
        return CloseAction::HideToTray;
    }
    if busy.is_idle() {
        CloseAction::Allow
    } else {
        CloseAction::AskConfirmation(busy)
    }
}

/// Estado compartido del shell (dentro de `AppState`).
pub struct ShellState {
    prefs: RwLock<ShellPrefs>,
    tray_error: Mutex<Option<String>>,
    tray_alive: AtomicBool,
    quitting: AtomicBool,
    /// La ventana está oculta a la bandeja (no solo sin foco).
    hidden: AtomicBool,
    running: AtomicUsize,
    pub notifier: Arc<dyn Notifier>,
    pub noise: Mutex<NoiseFilter>,
    tray: Mutex<Option<Arc<dyn TrayControl>>>,
    /// Canal de la ventana suscrita a `AppFeed` (una sola: una nueva suscripción reemplaza).
    feed: Mutex<Option<Channel<AppFeed>>>,
}

impl ShellState {
    pub fn new() -> Self {
        Self::with_notifier(Arc::new(DesktopNotifier))
    }

    pub fn with_notifier(notifier: Arc<dyn Notifier>) -> Self {
        Self {
            prefs: RwLock::new(ShellPrefs::default()),
            tray_error: Mutex::new(None),
            tray_alive: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            hidden: AtomicBool::new(false),
            running: AtomicUsize::new(0),
            notifier,
            noise: Mutex::new(NoiseFilter::default()),
            tray: Mutex::new(None),
            feed: Mutex::new(None),
        }
    }

    pub fn prefs(&self) -> ShellPrefs {
        *self.prefs.read().unwrap_or_else(|e| e.into_inner())
    }

    /// Reemplaza todas las preferencias (solo tests: en ejecución se aplican una a una).
    #[cfg(test)]
    pub fn set_prefs(&self, prefs: ShellPrefs) {
        *self.prefs.write().unwrap_or_else(|e| e.into_inner()) = prefs;
    }

    /// Aplica una preferencia; `true` si era del shell.
    pub fn apply_pref(&self, key: &str, value: &Value) -> bool {
        self.prefs
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .apply(key, value)
    }

    fn tray_slot(&self) -> MutexGuard<'_, Option<Arc<dyn TrayControl>>> {
        self.tray.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Registra la bandeja creada (o el motivo de que no exista).
    pub fn set_tray(&self, tray: Result<Arc<dyn TrayControl>, String>) {
        match tray {
            Ok(t) => {
                *self.tray_slot() = Some(t);
                self.tray_alive.store(true, Ordering::SeqCst);
                *self.tray_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
            }
            Err(e) => {
                *self.tray_slot() = None;
                self.tray_alive.store(false, Ordering::SeqCst);
                *self.tray_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(e);
            }
        }
    }

    /// Registra (reemplazando) el canal de mensajes del backend a la UI.
    pub fn subscribe_feed(&self, channel: Channel<AppFeed>) {
        *self.feed.lock().unwrap_or_else(|e| e.into_inner()) = Some(channel);
    }

    /// Envía un mensaje a la UI. `false` si nadie está suscrito o el canal ya no existe.
    pub fn emit(&self, feed: AppFeed) -> bool {
        let mut slot = self.feed.lock().unwrap_or_else(|e| e.into_inner());
        match slot.as_ref().map(|c| c.send(feed)) {
            Some(Ok(())) => true,
            Some(Err(_)) => {
                *slot = None;
                false
            }
            None => false,
        }
    }

    pub fn tray(&self) -> Option<Arc<dyn TrayControl>> {
        self.tray_slot().clone()
    }

    pub fn tray_alive(&self) -> bool {
        self.tray_alive.load(Ordering::SeqCst)
    }

    pub fn tray_status(&self) -> TrayStatus {
        TrayStatus {
            available: self.tray_alive(),
            error: self
                .tray_error
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
        }
    }

    /// La bandeja está viva Y visible para el usuario (preferencia `tray_enabled`).
    pub fn tray_usable(&self) -> bool {
        self.tray_alive() && self.prefs().tray_enabled
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    pub fn set_quitting(&self, v: bool) {
        self.quitting.store(v, Ordering::SeqCst);
    }

    pub fn is_hidden(&self) -> bool {
        self.hidden.load(Ordering::SeqCst)
    }

    pub fn set_hidden(&self, v: bool) {
        self.hidden.store(v, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub fn running(&self) -> usize {
        self.running.load(Ordering::SeqCst)
    }

    /// Guarda el contador de contenedores en marcha y lo refleja en la bandeja.
    pub fn set_running(&self, n: usize) {
        let prev = self.running.swap(n, Ordering::SeqCst);
        if prev != n
            && let Some(t) = self.tray()
        {
            t.set_running_count(n);
        }
    }
}

impl Default for ShellState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn busy(stacks: u32, pulls: u32, builds: u32, terminals: u32) -> BusySummary {
        BusySummary {
            stacks,
            pulls,
            builds,
            terminals,
        }
    }

    #[test]
    fn valores_por_defecto_conservadores() {
        let p = ShellPrefs::default();
        assert!(!p.notify_enabled && !p.close_to_tray && !p.start_minimized);
        assert!(p.tray_enabled && p.window_decorations);
        assert_eq!(p.notify_events, NotifyEvents::default());
    }

    #[test]
    fn aplica_preferencias_y_null_restaura_el_defecto() {
        let mut p = ShellPrefs::default();
        assert!(p.apply("close_to_tray", &json!(true)));
        assert!(p.apply("window_decorations", &json!(false)));
        assert!(p.close_to_tray && !p.window_decorations);
        assert!(p.apply("close_to_tray", &json!(null)));
        assert!(!p.close_to_tray);
        assert!(p.apply("notify_events", &json!({"oom": false})));
        assert!(!p.notify_events.oom && p.notify_events.die);
        assert!(p.apply("notify_events", &json!(null)));
        assert_eq!(p.notify_events, NotifyEvents::default());
        assert!(!p.apply("polling", &json!({"ms": 1000})));
    }

    #[test]
    fn cierre_sin_operaciones_ni_bandeja_cierra() {
        let p = ShellPrefs::default();
        assert_eq!(
            decide_close(&p, true, BusySummary::default(), false),
            CloseAction::Allow
        );
    }

    #[test]
    fn cerrar_a_bandeja_solo_con_bandeja_viva_y_habilitada() {
        let mut p = ShellPrefs {
            close_to_tray: true,
            ..ShellPrefs::default()
        };
        let idle = BusySummary::default();
        assert_eq!(decide_close(&p, true, idle, false), CloseAction::HideToTray);
        // Con operaciones también se oculta: siguen en segundo plano.
        assert_eq!(
            decide_close(&p, true, busy(1, 0, 0, 0), false),
            CloseAction::HideToTray
        );
        // Sin bandeja (falta libappindicator): se ignora, si no la app quedaría inalcanzable.
        assert_eq!(decide_close(&p, false, idle, false), CloseAction::Allow);
        p.tray_enabled = false;
        assert_eq!(decide_close(&p, true, idle, false), CloseAction::Allow);
    }

    #[test]
    fn con_operaciones_en_curso_pide_confirmacion() {
        let p = ShellPrefs::default();
        let b = busy(1, 2, 0, 3);
        assert_eq!(b.total(), 6);
        assert_eq!(
            decide_close(&p, true, b, false),
            CloseAction::AskConfirmation(b)
        );
        // Ya confirmado: no se vuelve a preguntar.
        assert_eq!(decide_close(&p, true, b, true), CloseAction::Allow);
    }

    #[test]
    fn estado_de_la_bandeja_se_informa() {
        let s = ShellState::new();
        assert_eq!(
            s.tray_status(),
            TrayStatus {
                available: false,
                error: None
            }
        );
        s.set_tray(Err("falta libayatana".into()));
        let st = s.tray_status();
        assert!(!st.available);
        assert_eq!(st.error.as_deref(), Some("falta libayatana"));
        assert!(!s.tray_usable());
    }

    #[test]
    fn el_contador_llega_a_la_bandeja_solo_si_cambia() {
        use crate::tray::testing::MockTray;
        let s = ShellState::new();
        let tray = MockTray::new();
        s.set_tray(Ok(tray.clone()));
        assert!(s.tray_usable());
        s.set_running(3);
        s.set_running(3);
        s.set_running(0);
        assert_eq!(tray.counts(), vec![3, 0]);
        assert_eq!(s.running(), 0);
    }

    #[test]
    fn el_canal_de_la_ui_entrega_y_se_descarta_si_falla() {
        let s = ShellState::new();
        // Sin suscriptor no se entrega.
        assert!(!s.emit(AppFeed::WindowVisibility { visible: false }));
        let got = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = got.clone();
        s.subscribe_feed(Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(j) = body {
                sink.lock().unwrap().push(j);
            }
            Ok(())
        }));
        assert!(s.emit(AppFeed::QuitRequested {
            summary: busy(1, 0, 0, 2)
        }));
        let sent = got.lock().unwrap().clone();
        assert_eq!(
            serde_json::from_str::<Value>(&sent[0]).unwrap(),
            json!({"type": "quit_requested",
                   "summary": {"stacks": 1, "pulls": 0, "builds": 0, "terminals": 2}})
        );
        // Un canal roto se descarta y se informa.
        s.subscribe_feed(Channel::new(|_| Err(tauri::Error::WebviewNotFound)));
        assert!(!s.emit(AppFeed::WindowVisibility { visible: true }));
        assert!(!s.emit(AppFeed::WindowVisibility { visible: true }));
    }
}
