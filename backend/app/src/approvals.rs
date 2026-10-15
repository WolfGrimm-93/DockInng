//! Aprobación humana de las acciones que exigen confirmación (T1).
//!
//! El webview NO puede aprobar: los comandos IPC no reciben ningún booleano de confirmación. El
//! único origen de un `Approval` en la app es [`NativeApprovals`], que muestra un diálogo NATIVO
//! de Tauri (no dibujado por el webview) con el título, el detalle y la acción. Si el usuario no
//! acepta, la acción se rechaza con `PolicyDenied` y el ticket no se consume.
//!
//! Las acciones con `ConfirmTyped` muestran el mismo diálogo (un diálogo nativo no puede pedir
//! texto): el texto escrito lo envía el webview en `typed` y el núcleo lo valida después. Son dos
//! pasos: la persona escribe el texto en la app y además acepta el diálogo nativo.
//!
//! Limitación: quien acepta el diálogo sin leerlo aprueba igualmente; el diálogo muestra la
//! acción exacta, pero no puede impedir un clic automático de un proceso con acceso al escritorio.

use std::sync::{Arc, OnceLock};

use engine_core::{ApiError, ApiErrorCode, Approval, ApprovalPrompt};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Origen de aprobaciones. Bloqueante: se llama desde un hilo de bloqueo, nunca desde el
/// runtime asíncrono.
pub trait ApprovalSource: Send + Sync {
    /// Muestra `prompt` y devuelve la aprobación solo si la persona la concede.
    fn request(&self, prompt: &ApprovalPrompt) -> Option<Approval>;
}

/// Sin ventana (tests, arranque): nunca aprueba. Es el valor por defecto de `AppState`.
pub struct DenyApprovals;

impl ApprovalSource for DenyApprovals {
    fn request(&self, _prompt: &ApprovalPrompt) -> Option<Approval> {
        None
    }
}

/// Diálogo nativo de Tauri. La ventana se enlaza en `setup`; antes de eso no aprueba nada.
#[derive(Default)]
pub struct NativeApprovals {
    app: OnceLock<AppHandle>,
}

impl NativeApprovals {
    pub fn attach(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }
}

/// Texto del diálogo: título, detalle y, si hace falta, la palabra a escribir después.
pub fn dialog_text(prompt: &ApprovalPrompt) -> String {
    let mut texto = prompt.lines.join("\n");
    if let Some(esperado) = &prompt.typed_hint {
        texto.push_str(&format!(
            "\n\nDespués de aceptar, escribe exactamente «{esperado}» en DockInng para confirmar."
        ));
    }
    texto
}

impl ApprovalSource for NativeApprovals {
    fn request(&self, prompt: &ApprovalPrompt) -> Option<Approval> {
        let app = self.app.get()?;
        let aceptado = app
            .dialog()
            .message(dialog_text(prompt))
            .title(prompt.title.clone())
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Confirmar".into(),
                "Cancelar".into(),
            ))
            .blocking_show();
        aceptado.then(Approval::from_native_dialog)
    }
}

/// Obtiene la aprobación para `prompt` (si la hay). `Ok(None)` cuando la decisión no exige
/// aprobación. Si el usuario no acepta, `PolicyDenied` (sin tocar el ticket).
pub async fn obtain_approval(
    source: Arc<dyn ApprovalSource>,
    prompt: Option<ApprovalPrompt>,
) -> Result<Option<Approval>, ApiError> {
    let Some(prompt) = prompt else {
        return Ok(None);
    };
    let concedida = tokio::task::spawn_blocking(move || source.request(&prompt))
        .await
        .map_err(|_| ApiError::new(ApiErrorCode::Internal, "el diálogo de aprobación falló"))?;
    concedida
        .map(Some)
        .ok_or_else(|| ApiError::new(ApiErrorCode::PolicyDenied, "la acción no fue aprobada"))
}

/// Origen de aprobaciones falso para tests: acepta o rechaza según `aceptar`, y guarda lo que se
/// le pidió mostrar.
#[cfg(test)]
pub struct FakeApprovals {
    pub aceptar: std::sync::atomic::AtomicBool,
    pub pedidos: std::sync::Mutex<Vec<ApprovalPrompt>>,
}

#[cfg(test)]
impl FakeApprovals {
    pub fn new(aceptar: bool) -> Arc<Self> {
        Arc::new(Self {
            aceptar: std::sync::atomic::AtomicBool::new(aceptar),
            pedidos: std::sync::Mutex::new(Vec::new()),
        })
    }

    pub fn fijar(&self, aceptar: bool) {
        self.aceptar
            .store(aceptar, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn pedidos(&self) -> Vec<ApprovalPrompt> {
        self.pedidos
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

#[cfg(test)]
impl ApprovalSource for FakeApprovals {
    fn request(&self, prompt: &ApprovalPrompt) -> Option<Approval> {
        self.pedidos
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(prompt.clone());
        self.aceptar
            .load(std::sync::atomic::Ordering::SeqCst)
            .then(Approval::for_tests)
    }
}
