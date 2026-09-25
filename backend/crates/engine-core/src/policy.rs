//! Política de confirmación de acciones destructivas.
//! Vive en el núcleo (no en la UI): una sola función de decisión para GUI y CLI.

/// Acciones que el usuario puede pedir sobre el motor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    StartContainer,
    StopContainer,
    RestartContainer,
    RemoveContainer {
        force: bool,
    },
    RemoveImage,
    /// Borrar todas las imágenes sin usar (se ejecuta por elemento).
    PruneImages,
    /// Confirmación escrita: el nombre.
    RemoveVolume {
        name: String,
    },
    /// Borrar todos los volúmenes sin usar (confirmación escrita: ELIMINAR).
    PruneVolumes,
    RemoveNetwork,
    /// Confirmación escrita: el nombre del stack.
    StackDown {
        project: String,
    },
    /// Limpieza total del sistema (equivale a `system prune`). Prohibida.
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

/// Palabra que sirve de confirmación escrita para los borrados masivos.
pub const CONFIRM_WORD: &str = "ELIMINAR";

/// Resultado de evaluar una acción.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Ejecutar sin preguntar.
    Allow,
    /// Pedir confirmación al usuario.
    Confirm,
    /// Confirmación escrita: hay que teclear exactamente `expected`. Para un solo objetivo es
    /// su nombre (ELIMINAR no vale); `expected == ELIMINAR` en prunes/lotes. Caso borde
    /// aceptado: un volumen llamado literalmente `ELIMINAR` coincide con su propio nombre.
    ConfirmTyped { expected: String },
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

impl Decision {
    /// ¿Vale `typed` como confirmación? `Deny` nunca acepta.
    pub fn accepts(&self, typed: Option<&str>) -> bool {
        match self {
            Decision::Allow | Decision::Confirm => true,
            Decision::Deny(_) => false,
            Decision::ConfirmTyped { expected } => {
                let Some(t) = typed else { return false };
                let t = t.trim();
                !expected.is_empty() && t == expected
            }
        }
    }

    /// Severidad para comparar decisiones (mayor = más estricta).
    pub fn severity(&self) -> u8 {
        match self {
            Decision::Allow => 0,
            Decision::Confirm => 1,
            Decision::ConfirmTyped { .. } => 2,
            Decision::Deny(DenyReason::NeedsConfirmationNonInteractive) => 3,
            Decision::Deny(DenyReason::Forbidden) => 4,
        }
    }
}

pub struct ConfirmationPolicy;

impl ConfirmationPolicy {
    /// Decide qué hacer con `action`. `assume_yes` es el `--yes` de la CLI.
    pub fn decide(action: &Action, interactivity: Interactivity, assume_yes: bool) -> Decision {
        use Action::*;
        let interactive = interactivity == Interactivity::Interactive;
        // Confirmación simple: `--yes` la salta.
        let simple = || {
            if assume_yes {
                Decision::Allow
            } else if interactive {
                Decision::Confirm
            } else {
                Decision::Deny(DenyReason::NeedsConfirmationNonInteractive)
            }
        };
        // Confirmación escrita: nunca se salta con `--yes`.
        let typed = |expected: &str| {
            if interactive {
                Decision::ConfirmTyped {
                    expected: expected.to_string(),
                }
            } else {
                Decision::Deny(DenyReason::NeedsConfirmationNonInteractive)
            }
        };
        match action {
            // Piso inviolable: no se ejecuta desde la política aunque el usuario diga sí.
            PruneSystem => Decision::Deny(DenyReason::Forbidden),
            StartContainer | StopContainer | RestartContainer => Decision::Allow,
            // PruneImages siempre exige humano: `--yes` no lo salta.
            PruneImages => {
                if interactive {
                    Decision::Confirm
                } else {
                    Decision::Deny(DenyReason::NeedsConfirmationNonInteractive)
                }
            }
            RemoveContainer { .. } | RemoveImage | RemoveNetwork => simple(),
            RemoveVolume { name } => typed(name),
            PruneVolumes => typed(CONFIRM_WORD),
            StackDown { project } => typed(project),
        }
    }

    /// Itera la política por elemento: gana el más estricto. Vacío = `Allow`.
    /// Con varios `ConfirmTyped` distintos se exige el de la acción agregada
    /// (la palabra ELIMINAR), nunca N frases.
    pub fn decide_batch(
        actions: &[Action],
        interactivity: Interactivity,
        assume_yes: bool,
    ) -> Decision {
        let mut best = Decision::Allow;
        for a in actions {
            let d = Self::decide(a, interactivity, assume_yes);
            if d.severity() > best.severity() {
                best = d;
            } else if d.severity() == best.severity()
                && d != best
                && matches!(
                    (&d, &best),
                    (Decision::ConfirmTyped { .. }, Decision::ConfirmTyped { .. })
                )
            {
                best = Decision::ConfirmTyped {
                    expected: CONFIRM_WORD.to_string(),
                };
            }
        }
        best
    }
}

/// Atajos libres.
pub fn decide(action: &Action, interactivity: Interactivity, assume_yes: bool) -> Decision {
    ConfirmationPolicy::decide(action, interactivity, assume_yes)
}

pub fn decide_batch(
    actions: &[Action],
    interactivity: Interactivity,
    assume_yes: bool,
) -> Decision {
    ConfirmationPolicy::decide_batch(actions, interactivity, assume_yes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use Interactivity::*;

    const NCNI: Decision = Decision::Deny(DenyReason::NeedsConfirmationNonInteractive);

    fn d(a: &Action, i: Interactivity, y: bool) -> Decision {
        decide(a, i, y)
    }

    fn vol(n: &str) -> Action {
        Action::RemoveVolume { name: n.into() }
    }

    #[test]
    fn reversibles_se_permiten_en_las_4_combinaciones() {
        for a in [
            Action::StartContainer,
            Action::StopContainer,
            Action::RestartContainer,
        ] {
            for i in [Interactive, NonInteractive] {
                for y in [false, true] {
                    assert_eq!(d(&a, i, y), Decision::Allow, "{a:?} {i:?} {y}");
                }
            }
        }
    }

    /// Matriz de las acciones con confirmación simple que `--yes` sí salta.
    fn matriz_simple(a: Action) {
        assert_eq!(d(&a, Interactive, false), Decision::Confirm);
        assert_eq!(d(&a, Interactive, true), Decision::Allow);
        assert_eq!(d(&a, NonInteractive, false), NCNI);
        assert_eq!(d(&a, NonInteractive, true), Decision::Allow);
    }

    #[test]
    fn remove_container_force_y_no_force_mismas_reglas() {
        matriz_simple(Action::RemoveContainer { force: false });
        matriz_simple(Action::RemoveContainer { force: true });
    }

    #[test]
    fn remove_image_matriz_completa() {
        matriz_simple(Action::RemoveImage);
    }

    #[test]
    fn remove_network_matriz_completa() {
        matriz_simple(Action::RemoveNetwork);
    }

    #[test]
    fn prune_images_nunca_se_salta_con_yes() {
        let a = Action::PruneImages;
        assert_eq!(d(&a, Interactive, false), Decision::Confirm);
        assert_eq!(d(&a, Interactive, true), Decision::Confirm);
        assert_eq!(d(&a, NonInteractive, false), NCNI);
        assert_eq!(d(&a, NonInteractive, true), NCNI);
    }

    #[test]
    fn remove_volume_pide_nombre_exacto() {
        let dec = d(&vol("datos"), Interactive, false);
        assert_eq!(
            dec,
            Decision::ConfirmTyped {
                expected: "datos".into()
            }
        );
        assert!(dec.accepts(Some("datos")));
        assert!(!dec.accepts(Some("Datos")));
        assert!(dec.accepts(Some(" datos ")));
        assert!(!dec.accepts(None));
        assert!(!dec.accepts(Some("")));
        // La palabra ELIMINAR NO vale para un solo objetivo.
        assert!(!dec.accepts(Some("ELIMINAR")));
        assert!(!dec.accepts(Some("eliminar")));
    }

    #[test]
    fn typed_espacios_mayusculas_unicode_y_expected_vacio() {
        let dec = Decision::ConfirmTyped {
            expected: "café-datos".into(),
        };
        assert!(dec.accepts(Some("café-datos")));
        assert!(dec.accepts(Some("\tcafé-datos\n")));
        assert!(!dec.accepts(Some("CAFÉ-DATOS")));
        // "é" descompuesta (e + acento combinante) no es el mismo texto.
        assert!(!dec.accepts(Some("cafe\u{301}-datos")));
        // Caracteres invisibles no se recortan.
        assert!(!dec.accepts(Some("café-datos\u{200b}")));
        assert!(!dec.accepts(Some("café - datos")));
        for typed in [None, Some(""), Some("  "), Some("ELIMINAR")] {
            assert!(
                !Decision::ConfirmTyped {
                    expected: String::new()
                }
                .accepts(typed)
            );
        }
    }

    #[test]
    fn eliminar_solo_vale_en_lotes_no_en_un_objetivo() {
        let stack = d(
            &Action::StackDown {
                project: "tienda".into(),
            },
            Interactive,
            false,
        );
        assert!(!stack.accepts(Some("ELIMINAR")));
        assert!(stack.accepts(Some("tienda")));
        let prune = d(&Action::PruneVolumes, Interactive, false);
        assert!(prune.accepts(Some("ELIMINAR")));
        assert!(!prune.accepts(Some("otra cosa")));
        // Un lote de volúmenes distintos exige la palabra, no los nombres.
        let batch = decide_batch(&[vol("a"), vol("b")], Interactive, false);
        assert!(batch.accepts(Some("ELIMINAR")));
        assert!(!batch.accepts(Some("a")));
    }

    #[test]
    fn remove_volume_yes_no_lo_salta() {
        assert!(matches!(
            d(&vol("x"), Interactive, true),
            Decision::ConfirmTyped { .. }
        ));
        assert_eq!(d(&vol("x"), NonInteractive, true), NCNI);
        assert_eq!(d(&vol("x"), NonInteractive, false), NCNI);
    }

    #[test]
    fn prune_volumes_exige_eliminar_y_es_case_sensitive() {
        let a = Action::PruneVolumes;
        let dec = d(&a, Interactive, true);
        assert_eq!(
            dec,
            Decision::ConfirmTyped {
                expected: "ELIMINAR".into()
            }
        );
        assert!(dec.accepts(Some("ELIMINAR")));
        assert!(!dec.accepts(Some("eliminar")));
        assert_eq!(d(&a, NonInteractive, true), NCNI);
        assert_eq!(d(&a, NonInteractive, false), NCNI);
    }

    #[test]
    fn stack_down_pide_nombre_y_no_lo_salta_yes() {
        let a = Action::StackDown {
            project: "tienda".into(),
        };
        let dec = d(&a, Interactive, true);
        assert!(dec.accepts(Some("tienda")));
        assert!(!dec.accepts(Some("otro")));
        assert_eq!(d(&a, NonInteractive, true), NCNI);
        assert_eq!(d(&a, Interactive, false), dec);
    }

    #[test]
    fn prune_system_forbidden_en_las_4_combinaciones() {
        for i in [Interactive, NonInteractive] {
            for y in [false, true] {
                assert_eq!(
                    d(&Action::PruneSystem, i, y),
                    Decision::Deny(DenyReason::Forbidden)
                );
            }
        }
    }

    #[test]
    fn batch_vacio_es_allow() {
        assert_eq!(decide_batch(&[], NonInteractive, false), Decision::Allow);
    }

    #[test]
    fn batch_mezcla_con_uno_prohibido_es_forbidden() {
        let b = [
            Action::RemoveContainer { force: false },
            Action::PruneSystem,
            vol("x"),
        ];
        assert_eq!(
            decide_batch(&b, Interactive, false),
            Decision::Deny(DenyReason::Forbidden)
        );
    }

    #[test]
    fn batch_confirm_mas_typed_devuelve_typed() {
        let b = [Action::RemoveContainer { force: true }, vol("x")];
        assert_eq!(
            decide_batch(&b, Interactive, false),
            Decision::ConfirmTyped {
                expected: "x".into()
            }
        );
    }

    #[test]
    fn batch_varios_typed_distintos_exigen_eliminar() {
        let b = [vol("a"), vol("b")];
        let dec = decide_batch(&b, Interactive, false);
        assert_eq!(
            dec,
            Decision::ConfirmTyped {
                expected: "ELIMINAR".into()
            }
        );
        // Dos iguales conservan el nombre.
        let same = decide_batch(&[vol("a"), vol("a")], Interactive, false);
        assert_eq!(
            same,
            Decision::ConfirmTyped {
                expected: "a".into()
            }
        );
    }

    #[test]
    fn batch_noninteractive_sin_yes_deny_ncni() {
        let b = [
            Action::RemoveContainer { force: false },
            Action::RemoveImage,
        ];
        assert_eq!(decide_batch(&b, NonInteractive, false), NCNI);
    }

    #[test]
    fn batch_con_yes_solo_permite_lo_no_escrito() {
        let b = [
            Action::RemoveContainer { force: false },
            Action::RemoveNetwork,
        ];
        assert_eq!(decide_batch(&b, NonInteractive, true), Decision::Allow);
        let c = [Action::RemoveContainer { force: false }, vol("x")];
        assert_eq!(decide_batch(&c, NonInteractive, true), NCNI);
        // Interactivo con yes: contenedores Allow, volumen sigue pidiendo texto.
        assert!(matches!(
            decide_batch(&c, Interactive, true),
            Decision::ConfirmTyped { .. }
        ));
    }

    #[test]
    fn decision_accepts_no_permite_deny() {
        assert!(!NCNI.accepts(Some("ELIMINAR")));
        assert!(!Decision::Deny(DenyReason::Forbidden).accepts(None));
        assert!(Decision::Allow.accepts(None));
        assert!(Decision::Confirm.accepts(None));
    }
}

#[cfg(test)]
mod extra_tests {
    use super::*;
    use Interactivity::*;

    fn vol(n: &str) -> Action {
        Action::RemoveVolume { name: n.into() }
    }

    const NCNI: Decision = Decision::Deny(DenyReason::NeedsConfirmationNonInteractive);

    #[test]
    fn batch_prune_images_mas_volumen() {
        let b = [Action::PruneImages, vol("v")];
        assert_eq!(
            decide_batch(&b, Interactive, false),
            Decision::ConfirmTyped {
                expected: "v".into()
            }
        );
        assert_eq!(decide_batch(&b, NonInteractive, false), NCNI);
        // PruneImages no se salta con --yes, tampoco dentro de un lote.
        assert_eq!(
            decide_batch(&[Action::PruneImages], NonInteractive, true),
            NCNI
        );
        assert_eq!(
            decide_batch(
                &[Action::PruneImages, Action::RemoveNetwork],
                Interactive,
                true
            ),
            Decision::Confirm
        );
    }

    #[test]
    fn batch_forbidden_gana_sin_importar_el_orden() {
        let a = [rm_container(), Action::PruneSystem];
        let b = [Action::PruneSystem, rm_container()];
        for batch in [&a, &b] {
            assert_eq!(
                decide_batch(batch, NonInteractive, false),
                Decision::Deny(DenyReason::Forbidden)
            );
        }
    }

    fn rm_container() -> Action {
        Action::RemoveContainer { force: false }
    }

    #[test]
    fn batch_typed_mezclados_en_cualquier_orden() {
        let eliminar = Decision::ConfirmTyped {
            expected: "ELIMINAR".into(),
        };
        assert_eq!(
            decide_batch(&[vol("a"), Action::PruneVolumes], Interactive, false),
            eliminar
        );
        assert_eq!(
            decide_batch(&[Action::PruneVolumes, vol("a")], Interactive, false),
            eliminar
        );
        // Mismo `expected` en dos acciones distintas: se conserva el nombre.
        let stack = Action::StackDown {
            project: "a".into(),
        };
        assert_eq!(
            decide_batch(&[vol("a"), stack], Interactive, false),
            Decision::ConfirmTyped {
                expected: "a".into()
            }
        );
    }

    #[test]
    fn expected_con_espacios_no_acepta_lo_recortado() {
        let dec = Decision::ConfirmTyped {
            expected: " a ".into(),
        };
        assert!(!dec.accepts(Some("a")));
        assert!(!dec.accepts(Some(" a ")));
    }

    #[test]
    fn severidad_estrictamente_ordenada() {
        let orden = [
            Decision::Allow,
            Decision::Confirm,
            Decision::ConfirmTyped {
                expected: "x".into(),
            },
            NCNI,
            Decision::Deny(DenyReason::Forbidden),
        ];
        for w in orden.windows(2) {
            assert!(w[0].severity() < w[1].severity());
        }
    }

    /// CASO BORDE FIJADO: un volumen que se llama literalmente `ELIMINAR` hace que
    /// `expected == "ELIMINAR"`. Se ACEPTA porque coincide con el nombre exacto (es lo que se
    /// pide teclear); no debilita nada: para cualquier otro volumen ELIMINAR sigue rechazado.
    #[test]
    fn volumen_llamado_eliminar_se_acepta_por_coincidir_con_su_nombre() {
        let dec = decide(&vol("ELIMINAR"), Interactive, false);
        assert_eq!(
            dec,
            Decision::ConfirmTyped {
                expected: "ELIMINAR".into()
            }
        );
        assert!(dec.accepts(Some("ELIMINAR")));
        assert!(!dec.accepts(Some("eliminar")));
        assert!(!decide(&vol("otro"), Interactive, false).accepts(Some("ELIMINAR")));
    }
}
