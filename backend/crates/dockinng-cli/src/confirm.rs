//! Confirmación de acciones destructivas en la terminal. La decisión la toma el núcleo
//! (`ConfirmationPolicy`, vía `ActionService::plan_with`); aquí solo se pregunta.

use crate::error::CliError;
use std::io::{self, BufRead, IsTerminal, Write};

use engine_core::{Decision, Interactivity, PlanDecision, PlanDenyReason};

/// Quién responde a las preguntas (stdin real o un guion en los tests).
pub trait Asker {
    /// Pregunta sí/no; solo "s", "si", "sí", "y", "yes" cuentan como sí.
    fn ask(&mut self, question: &str) -> bool;
    /// Confirmación escrita: devuelve lo tecleado.
    fn ask_typed(&mut self, expected: &str) -> Option<String>;
}

pub struct Stdin;

impl Asker for Stdin {
    fn ask(&mut self, question: &str) -> bool {
        // Los avisos van a stderr: con `--json` stdout debe seguir siendo JSON válido.
        prompt_ask(&mut io::stderr(), &mut io::stdin().lock(), question)
    }

    fn ask_typed(&mut self, expected: &str) -> Option<String> {
        prompt_typed(&mut io::stderr(), &mut io::stdin().lock(), expected)
    }
}

/// Escribe la pregunta en `out` y lee la respuesta de `input` (parametrizado para los tests).
pub fn prompt_ask(out: &mut dyn Write, input: &mut dyn BufRead, question: &str) -> bool {
    let _ = write!(out, "{question} [s/N] ");
    let _ = out.flush();
    let mut answer = String::new();
    if input.read_line(&mut answer).is_err() {
        return false;
    }
    is_yes(&answer)
}

pub fn prompt_typed(
    out: &mut dyn Write,
    input: &mut dyn BufRead,
    expected: &str,
) -> Option<String> {
    let _ = write!(out, "Escribe «{expected}» para confirmar: ");
    let _ = out.flush();
    let mut answer = String::new();
    input.read_line(&mut answer).ok()?;
    Some(answer)
}

pub fn is_yes(answer: &str) -> bool {
    matches!(
        answer.trim().to_lowercase().as_str(),
        "s" | "si" | "sí" | "y" | "yes"
    )
}

/// Con TTY se puede preguntar; sin él (scripts, CI) no.
pub fn interactivity() -> Interactivity {
    if io::stdin().is_terminal() {
        Interactivity::Interactive
    } else {
        Interactivity::NonInteractive
    }
}

/// Aplica la decisión del plan. `Ok(typed)` = se puede ejecutar (con la confirmación escrita
/// si la hubo); `Err` = no se ejecuta. La confirmación escrita se comprueba aquí con la misma
/// regla que el núcleo (`Decision::accepts`) y el ticket la vuelve a comprobar al canjearse.
pub fn gate(
    decision: &PlanDecision,
    assume_yes: bool,
    question: &str,
    asker: &mut dyn Asker,
) -> Result<Option<String>, CliError> {
    match decision {
        PlanDecision::Allow => Ok(None),
        PlanDecision::Confirm => {
            if asker.ask(question) {
                Ok(None)
            } else {
                Err("cancelado por el usuario".into())
            }
        }
        PlanDecision::ConfirmTyped { expected } => {
            let typed = asker
                .ask_typed(expected)
                .ok_or_else(|| "cancelado por el usuario".to_string())?;
            let accepted = Decision::ConfirmTyped {
                expected: expected.clone(),
            }
            .accepts(Some(&typed));
            if accepted {
                Ok(Some(typed))
            } else {
                Err("la confirmación escrita no coincide: cancelado".into())
            }
        }
        PlanDecision::Deny {
            reason: PlanDenyReason::Forbidden,
        } => Err("acción prohibida por la política de seguridad".into()),
        PlanDecision::Deny {
            reason: PlanDenyReason::NeedsConfirmationNonInteractive,
        } => Err(if assume_yes {
            "requiere confirmación en una terminal: --yes no la sustituye en esta acción".into()
        } else {
            "requiere confirmación: usa --yes (solo confirmaciones simples) o ejecútalo en una terminal"
                .into()
        }),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Guion de respuestas para los tests.
    #[derive(Default)]
    pub struct Script {
        pub yes: bool,
        pub typed: Option<String>,
        pub asked: usize,
    }

    impl Asker for Script {
        fn ask(&mut self, _q: &str) -> bool {
            self.asked += 1;
            self.yes
        }
        fn ask_typed(&mut self, _e: &str) -> Option<String> {
            self.asked += 1;
            self.typed.clone()
        }
    }

    #[test]
    fn sin_tty_se_deniega_y_el_mensaje_explica_yes() {
        let mut s = Script::default();
        let d = PlanDecision::Deny {
            reason: PlanDenyReason::NeedsConfirmationNonInteractive,
        };
        let e = gate(&d, false, "?", &mut s).unwrap_err();
        assert!(e.to_string().contains("--yes"), "{e}");
        let e = gate(&d, true, "?", &mut s).unwrap_err();
        assert!(e.to_string().contains("no la sustituye"), "{e}");
        assert_eq!(s.asked, 0, "sin TTY nunca se pregunta");
    }

    #[test]
    fn prohibido_nunca_se_ejecuta() {
        let mut s = Script {
            yes: true,
            ..Script::default()
        };
        let d = PlanDecision::Deny {
            reason: PlanDenyReason::Forbidden,
        };
        assert!(gate(&d, true, "?", &mut s).is_err());
        assert_eq!(s.asked, 0);
    }

    #[test]
    fn confirm_pregunta_y_solo_el_si_ejecuta() {
        let mut si = Script {
            yes: true,
            ..Script::default()
        };
        assert_eq!(gate(&PlanDecision::Confirm, false, "?", &mut si), Ok(None));
        let mut no = Script::default();
        assert!(gate(&PlanDecision::Confirm, false, "?", &mut no).is_err());
        assert_eq!(no.asked, 1);
    }

    #[test]
    fn allow_ejecuta_sin_preguntar_solo_tras_yes() {
        let mut s = Script::default();
        assert_eq!(gate(&PlanDecision::Allow, true, "?", &mut s), Ok(None));
        assert_eq!(s.asked, 0);
    }

    #[test]
    fn la_confirmacion_escrita_nunca_se_salta_y_es_exacta() {
        let d = PlanDecision::ConfirmTyped {
            expected: "ELIMINAR".into(),
        };
        // Aunque el usuario pase --yes, se pregunta.
        let mut ok = Script {
            typed: Some("ELIMINAR\n".into()),
            ..Script::default()
        };
        assert_eq!(gate(&d, true, "?", &mut ok), Ok(Some("ELIMINAR\n".into())));
        assert_eq!(ok.asked, 1);
        for wrong in [
            None,
            Some("eliminar".to_string()),
            Some("".to_string()),
            Some("si".into()),
        ] {
            let mut s = Script {
                typed: wrong,
                ..Script::default()
            };
            assert!(gate(&d, true, "?", &mut s).is_err());
        }
    }

    #[test]
    fn los_avisos_van_al_escritor_indicado_no_a_stdout() {
        let mut out = Vec::new();
        let mut input = io::Cursor::new(b"s\n".to_vec());
        assert!(prompt_ask(&mut out, &mut input, "¿Seguro?"));
        assert_eq!(String::from_utf8(out).unwrap(), "¿Seguro? [s/N] ");
        let mut out = Vec::new();
        let mut input = io::Cursor::new(b"ELIMINAR\n".to_vec());
        assert_eq!(
            prompt_typed(&mut out, &mut input, "ELIMINAR").as_deref(),
            Some("ELIMINAR\n")
        );
        assert!(String::from_utf8(out).unwrap().contains("«ELIMINAR»"));
        // Fin de entrada: no es un sí.
        let mut input = io::Cursor::new(Vec::new());
        assert!(!prompt_ask(&mut Vec::new(), &mut input, "?"));
    }

    #[test]
    fn respuestas_afirmativas() {
        for y in ["s", "S\n", "si", "sí", "y", "YES"] {
            assert!(is_yes(y), "{y}");
        }
        for n in ["", "n", "no", "ok", "1", "sip"] {
            assert!(!is_yes(n), "{n}");
        }
    }
}
