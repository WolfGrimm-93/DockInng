//! Estado de cierre de la ventana y coordinación con operaciones en curso.

use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseDecision {
    Allow,
    AskConfirmation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseConfirmation {
    WaitForOperations,
    Exit,
}

#[derive(Debug, Default)]
struct CloseState {
    active_operations: usize,
    confirmation_pending: bool,
    closing: bool,
}

/// Pequeña máquina de estados compartida por el evento Tauri y los comandos IPC.
/// Nunca permite cerrar mientras una operación siga siendo dueña de un guard.
pub struct WindowController {
    state: Mutex<CloseState>,
}

impl Default for WindowController {
    fn default() -> Self {
        Self { state: Mutex::new(CloseState::default()) }
    }
}

impl WindowController {
    pub fn operation_started(&self) -> bool {
        let Ok(mut state) = self.state.lock() else { return false };
        if state.closing { return false; }
        state.active_operations += 1;
        true
    }

    /// Libera una operación. Devuelve `true` si una confirmación de cierre ya
    /// había cancelado la espera y ahora se puede salir de forma segura.
    pub fn operation_finished(&self) -> bool {
        let Ok(mut state) = self.state.lock() else { return false };
        state.active_operations = state.active_operations.saturating_sub(1);
        state.closing && state.active_operations == 0
    }

    pub fn close_requested(&self) -> CloseDecision {
        let Ok(mut state) = self.state.lock() else { return CloseDecision::AskConfirmation };
        if state.active_operations == 0 {
            CloseDecision::Allow
        } else {
            state.confirmation_pending = true;
            CloseDecision::AskConfirmation
        }
    }

    pub fn confirm_close(&self) -> CloseConfirmation {
        let Ok(mut state) = self.state.lock() else { return CloseConfirmation::WaitForOperations };
        state.confirmation_pending = false;
        state.closing = true;
        if state.active_operations == 0 {
            CloseConfirmation::Exit
        } else {
            CloseConfirmation::WaitForOperations
        }
    }

    pub fn cancel_close(&self) -> bool {
        let Ok(mut state) = self.state.lock() else { return false };
        if state.closing { return false; }
        state.confirmation_pending = false;
        true
    }

    pub fn active_operations(&self) -> usize {
        self.state.lock().map(|state| state.active_operations).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cierre_sin_operaciones_se_permite() {
        let ctl = WindowController::default();
        assert_eq!(ctl.close_requested(), CloseDecision::Allow);
    }

    #[test]
    fn cierre_en_curso_pide_confirmacion_y_cancelar_no_cierra() {
        let ctl = WindowController::default();
        assert!(ctl.operation_started());
        assert_eq!(ctl.close_requested(), CloseDecision::AskConfirmation);
        assert_eq!(ctl.cancel_close(), true);
        assert_eq!(ctl.active_operations(), 1);
        assert!(ctl.operation_finished() == false);
    }

    #[test]
    fn confirmar_cierre_espera_a_que_termine_la_operacion() {
        let ctl = WindowController::default();
        assert!(ctl.operation_started());
        assert_eq!(ctl.confirm_close(), CloseConfirmation::WaitForOperations);
        assert!(!ctl.operation_started());
        assert!(ctl.operation_finished());
    }
}
