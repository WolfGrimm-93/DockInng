//! Política de confirmación de acciones destructivas.
//! Vive en el núcleo (no en la UI): una sola función de decisión para GUI y CLI.

/// Acciones que el usuario puede pedir sobre el motor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    StartContainer,
    StopContainer,
    RemoveContainer {
        force: bool,
    },
    RemoveVolume,
    /// Borrar todos los volúmenes de golpe (equivale a `volume prune`).
    PruneVolumes,
    /// Limpieza total del sistema (equivale a `system prune`).
    PruneSystem,
}

/// Si hay alguien que pueda responder a una confirmación.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interactivity {
    /// GUI o CLI con TTY: se puede preguntar.
    Interactive,
    /// Sin TTY (scripts, CI): no se puede preguntar.
    NonInteractive,
}

/// Resultado de evaluar una acción.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Ejecutar sin preguntar.
    Allow,
    /// Pedir confirmación al usuario.
    Confirm,
    /// Denegar (y por qué no se puede continuar).
    Deny(DenyReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenyReason {
    /// Acción catastrófica: ni `--yes` la permite.
    Forbidden,
    /// Requería confirmación y no hay quien responda.
    NeedsConfirmationNonInteractive,
}

pub struct ConfirmationPolicy;

impl ConfirmationPolicy {
    /// Decide qué hacer con `action`. `assume_yes` es el `--yes` de la CLI.
    pub fn decide(action: Action, interactivity: Interactivity, assume_yes: bool) -> Decision {
        use Action::*;
        match action {
            // Piso inviolable: no se ejecuta desde la política aunque el usuario diga sí.
            // Si en el futuro se habilita, debe hacerse con un flujo propio y explícito.
            PruneSystem => Decision::Deny(DenyReason::Forbidden),
            // Reversibles: se ejecutan directo.
            StartContainer | StopContainer => Decision::Allow,
            // Destructivas: confirmación explícita.
            RemoveContainer { .. } | RemoveVolume | PruneVolumes => {
                if assume_yes && !matches!(action, PruneVolumes) {
                    Decision::Allow
                } else if interactivity == Interactivity::Interactive {
                    Decision::Confirm
                } else {
                    Decision::Deny(DenyReason::NeedsConfirmationNonInteractive)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reversibles_se_permiten() {
        assert_eq!(
            ConfirmationPolicy::decide(Action::StopContainer, Interactivity::NonInteractive, false),
            Decision::Allow
        );
    }

    #[test]
    fn borrar_pregunta_en_interactivo() {
        let a = Action::RemoveContainer { force: false };
        assert_eq!(
            ConfirmationPolicy::decide(a, Interactivity::Interactive, false),
            Decision::Confirm
        );
    }

    #[test]
    fn borrar_sin_tty_ni_yes_se_deniega() {
        let a = Action::RemoveContainer { force: true };
        assert_eq!(
            ConfirmationPolicy::decide(a, Interactivity::NonInteractive, false),
            Decision::Deny(DenyReason::NeedsConfirmationNonInteractive)
        );
    }

    #[test]
    fn yes_cubre_borrar_contenedor() {
        let a = Action::RemoveContainer { force: false };
        assert_eq!(
            ConfirmationPolicy::decide(a, Interactivity::NonInteractive, true),
            Decision::Allow
        );
    }

    #[test]
    fn el_piso_no_lo_salta_yes() {
        assert_eq!(
            ConfirmationPolicy::decide(Action::PruneSystem, Interactivity::Interactive, true),
            Decision::Deny(DenyReason::Forbidden)
        );
        // Borrar todos los volúmenes exige confirmación humana incluso con --yes.
        assert_eq!(
            ConfirmationPolicy::decide(Action::PruneVolumes, Interactivity::NonInteractive, true),
            Decision::Deny(DenyReason::NeedsConfirmationNonInteractive)
        );
    }
}
