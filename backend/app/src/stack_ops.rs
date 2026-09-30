//! Registro de operaciones Compose que no deben quedar huérfanas al cerrar.

use std::sync::Arc;

use crate::window_ctl::WindowController;

pub struct OperationGuard {
    controller: Arc<WindowController>,
    finished: bool,
}

impl OperationGuard {
    pub fn finish(mut self) -> bool {
        self.finished = true;
        self.controller.operation_finished()
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.controller.operation_finished();
        }
    }
}

pub fn begin(controller: Arc<WindowController>) -> Option<OperationGuard> {
    controller.operation_started().then_some(OperationGuard {
        controller,
        finished: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_guard_libera_la_operacion_incluso_si_se_descarta() {
        let controller = Arc::new(WindowController::default());
        let guard = begin(Arc::clone(&controller)).expect("operación aceptada");
        assert_eq!(controller.active_operations(), 1);
        drop(guard);
        assert_eq!(controller.active_operations(), 0);
    }
}
