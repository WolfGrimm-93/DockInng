//! Bandeja del sistema (Tauri 2 `tray-icon`).
//!
//! La creación NO es fatal: sin `libayatana-appindicator`/`libappindicator` la librería
//! entra en pánico al cargarla (dlopen), así que se captura y se registra el motivo; la app
//! sigue sin bandeja y `tray_status` lo informa. Toda la lógica que depende de la bandeja pasa
//! por el trait `TrayControl`, que en los tests se sustituye por un doble.

use std::sync::Arc;

use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Runtime};

use crate::window_ctl;

/// Identificadores del menú.
const ID_TOGGLE: &str = "toggle";
const ID_COUNT: &str = "count";
const ID_QUIT: &str = "quit";

/// Icono monocromo de la bandeja; se incluye solo si existe al compilar (`build.rs` emite
/// `has_tray_png`). Si falta se usa el icono de la aplicación.
#[cfg(has_tray_png)]
const TRAY_PNG: Option<&[u8]> = Some(include_bytes!("../icons/tray.png"));
#[cfg(not(has_tray_png))]
const TRAY_PNG: Option<&[u8]> = None;

/// Operaciones que el resto de la app necesita de la bandeja.
pub trait TrayControl: Send + Sync {
    /// Actualiza el contador de contenedores en marcha (menú y tooltip).
    fn set_running_count(&self, n: usize);
    /// Muestra u oculta el icono (preferencia `tray_enabled`).
    fn set_visible(&self, visible: bool);
}

/// Texto del elemento del menú con el contador.
pub fn count_label(n: usize) -> String {
    format!("Contenedores en marcha: {n}")
}

/// Tooltip de la bandeja.
pub fn tooltip(n: usize) -> String {
    match n {
        0 => "DockInng".into(),
        1 => "DockInng — 1 contenedor en marcha".into(),
        n => format!("DockInng — {n} contenedores en marcha"),
    }
}

/// Icono de la bandeja: el PNG monocromo si está incluido y es válido; si no, el de la app.
fn load_icon<R: Runtime>(app: &AppHandle<R>) -> Option<Image<'static>> {
    TRAY_PNG
        .and_then(|bytes| Image::from_bytes(bytes).ok())
        .map(|i| i.to_owned())
        .or_else(|| app.default_window_icon().map(|i| i.clone().to_owned()))
}

struct TauriTray<R: Runtime> {
    tray: TrayIcon<R>,
    count_item: MenuItem<R>,
}

impl<R: Runtime> TrayControl for TauriTray<R> {
    fn set_running_count(&self, n: usize) {
        let _ = self.count_item.set_text(count_label(n));
        let _ = self.tray.set_tooltip(Some(tooltip(n)));
    }

    fn set_visible(&self, visible: bool) {
        let _ = self.tray.set_visible(visible);
    }
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        ID_TOGGLE => window_ctl::toggle_main(app),
        ID_QUIT => window_ctl::request_quit(app),
        _ => {}
    }
}

fn build<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<dyn TrayControl>, String> {
    let toggle = MenuItem::with_id(
        app,
        ID_TOGGLE,
        "Mostrar/Ocultar DockInng",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let count_item = MenuItem::with_id(app, ID_COUNT, count_label(0), false, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit =
        MenuItem::with_id(app, ID_QUIT, "Salir", true, None::<&str>).map_err(|e| e.to_string())?;
    let sep1 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&toggle, &sep1, &count_item, &sep2, &quit])
        .map_err(|e| e.to_string())?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip(tooltip(0))
        .menu(&menu)
        // Con el menú siempre disponible, el clic izquierdo alterna la ventana.
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                window_ctl::toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = load_icon(app) {
        builder = builder.icon(icon);
    }
    let tray = builder.build(app).map_err(|e| e.to_string())?;
    Ok(Arc::new(TauriTray { tray, count_item }))
}

/// Crea la bandeja. Nunca falla ni entra en pánico hacia el llamador: devuelve el motivo.
pub fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<dyn TrayControl>, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| build(app))).unwrap_or_else(|p| {
        let why = p
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| p.downcast_ref::<&str>().map(|s| (*s).to_string()))
            .unwrap_or_else(|| "pánico al crear la bandeja".into());
        // Solo la primera línea: el mensaje de la librería lista todos los intentos de dlopen.
        Err(format!(
            "falta libayatana-appindicator o libappindicator: {}",
            why.lines().next().unwrap_or_default()
        ))
    })
}

/// Doble de pruebas: registra las llamadas.
#[cfg(test)]
pub mod testing {
    use std::sync::{Arc, Mutex};

    use super::TrayControl;

    #[derive(Default)]
    pub struct MockTray {
        counts: Mutex<Vec<usize>>,
        visible: Mutex<Vec<bool>>,
    }

    impl MockTray {
        pub fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        pub fn counts(&self) -> Vec<usize> {
            self.counts.lock().unwrap().clone()
        }

        pub fn visibility(&self) -> Vec<bool> {
            self.visible.lock().unwrap().clone()
        }
    }

    impl TrayControl for MockTray {
        fn set_running_count(&self, n: usize) {
            self.counts.lock().unwrap().push(n);
        }

        fn set_visible(&self, visible: bool) {
            self.visible.lock().unwrap().push(visible);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn textos_del_contador() {
        assert_eq!(count_label(0), "Contenedores en marcha: 0");
        assert_eq!(count_label(7), "Contenedores en marcha: 7");
        assert_eq!(tooltip(0), "DockInng");
        assert!(tooltip(1).contains("1 contenedor "));
        assert!(tooltip(5).contains("5 contenedores"));
    }
}
