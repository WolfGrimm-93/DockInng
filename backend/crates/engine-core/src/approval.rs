//! Aprobación humana para canjear tickets que exigen confirmación.
//!
//! Un `Approval` es la prueba de que una persona aceptó la acción en un diálogo (nativo de la
//! app o pregunta de la CLI). El núcleo NO lo fabrica: solo los adaptadores (la app Tauri y la
//! CLI) lo construyen, con un constructor que nombra su origen. El campo es privado, así que
//! fuera de este crate no hay forma de crear uno con un literal de struct.
//!
//! El webview no tiene ningún camino para obtener un `Approval`: el comando IPC
//! `execute_action(ticket, typed)` no recibe ningún booleano de confirmación; la aprobación la
//! obtiene el adaptador de la app mostrando un diálogo nativo que el webview no dibuja.
//!
//! No es `Clone`: cada canje necesita su propia aprobación, consumida al canjear.

/// De dónde viene la aprobación (para auditoría y mensajes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalOrigin {
    /// Diálogo nativo de la app de escritorio.
    NativeDialog,
    /// Pregunta interactiva de la CLI, o `--yes` tras pasar el gate de la CLI.
    CliPrompt,
    /// Solo tests: aprobación falsa.
    #[cfg(any(test, feature = "testing"))]
    Test,
}

/// Prueba de aprobación humana. Solo se construye en un adaptador.
///
/// Fuera de este crate no se puede fabricar con un literal (el campo es privado):
///
/// ```compile_fail
/// let _ = engine_core::Approval { origin: engine_core::ApprovalOrigin::CliPrompt, _sellado: () };
/// ```
///
/// Ni con `Clone` (cada canje necesita su propia aprobación):
///
/// ```compile_fail
/// fn exige_clone<T: Clone>(_: T) {}
/// exige_clone(engine_core::Approval::from_cli_prompt());
/// ```
#[derive(Debug)]
#[must_use = "una aprobación sin canjear no hace nada"]
pub struct Approval {
    origin: ApprovalOrigin,
    /// Campo privado: impide construirla con un literal fuera de este módulo.
    _sellado: (),
}

impl Approval {
    /// Adaptador de la app: el usuario pulsó «Confirmar» en el diálogo nativo.
    pub fn from_native_dialog() -> Self {
        Self::con_origen(ApprovalOrigin::NativeDialog)
    }

    /// Adaptador de la CLI: el usuario respondió «sí» a la pregunta, o el gate permitió `--yes`.
    /// Llamarlo solo DESPUÉS del gate de la CLI.
    pub fn from_cli_prompt() -> Self {
        Self::con_origen(ApprovalOrigin::CliPrompt)
    }

    /// Aprobación falsa para tests de este crate y de los que activan la feature `testing`.
    /// No existe en el binario de producción.
    #[cfg(any(test, feature = "testing"))]
    pub fn for_tests() -> Self {
        Self::con_origen(ApprovalOrigin::Test)
    }

    fn con_origen(origin: ApprovalOrigin) -> Self {
        Self {
            origin,
            _sellado: (),
        }
    }

    pub fn origin(&self) -> ApprovalOrigin {
        self.origin
    }
}

/// Texto que el adaptador muestra al pedir la aprobación: qué se va a hacer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalPrompt {
    /// Título corto (p. ej. «Confirmar eliminación»).
    pub title: String,
    /// Líneas de detalle: la acción y los elementos afectados.
    pub lines: Vec<String>,
    /// Si la acción exige además escribir una palabra o nombre (`ConfirmTyped`). El diálogo no
    /// puede pedir texto: el webview lo envía en `typed` y el núcleo lo valida después de la
    /// aprobación. Se muestra aquí para que la persona sepa que tendrá que escribirlo.
    pub typed_hint: Option<String>,
}
