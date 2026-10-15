//! Construcción de imágenes hacia la UI: adaptador entre el `Sink` de la ventana y el
//! servicio `builder`, más el arranque de la tarea (cancelar = `unsubscribe`).

use std::sync::Arc;

use builder::{BuildService, BuildSink, BuildTarget};
use engine_core::{ApiError, ApiErrorCode, BuildFeed, BuildOutcome, BuildSpec};

use crate::approvals::obtain_approval;
use crate::state::AppState;
use crate::streams::{Sink, StreamKind};

/// Servicio de builds compartido por todas las ventanas (un build a la vez en toda la app).
pub struct BuildGuards {
    pub service: BuildService,
}

impl BuildGuards {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            service: BuildService::new(),
        })
    }

    /// Builds en curso (a lo sumo uno en toda la app).
    pub fn active_count(&self) -> usize {
        usize::from(self.service.is_active())
    }
}

/// `Sink` de la ventana visto como destino del builder.
struct SinkAdapter(Arc<dyn Sink<BuildFeed>>);

impl BuildSink for SinkAdapter {
    fn send(&self, feed: BuildFeed) -> bool {
        self.0.send(feed)
    }
}

/// Destino del `docker build` según la conexión activa (vacío con motores simulados).
pub fn target_of(state: &AppState) -> BuildTarget {
    match state.subprocess_env() {
        Some((docker_host, env)) => BuildTarget {
            docker_host: Some(docker_host),
            env,
        },
        None => BuildTarget::default(),
    }
}

fn ended_error(error: ApiError) -> BuildFeed {
    BuildFeed::Ended {
        outcome: BuildOutcome::Failed,
        image_id: None,
        error: Some(error),
    }
}

/// Valida la especificación (errores síncronos) y lanza la construcción como tarea de la
/// ventana. Devuelve el id de suscripción; soltar la tarea mata el `docker build` (grupo de
/// procesos con SIGTERM y remate).
pub fn start_build(
    state: &AppState,
    window: &str,
    spec: BuildSpec,
    ticket: Option<String>,
    sink: Arc<dyn Sink<BuildFeed>>,
) -> Result<String, ApiError> {
    // Falla pronto (contexto inexistente, Dockerfile fuera, etc.) sin abrir suscripción.
    state.builds.clone().service.prepare(&spec)?;
    let builds = state.builds.clone();
    // Destino REAL del subproceso (socket del túnel / TLS con su directorio de certificados),
    // nunca la etiqueta `ssh://` de la conexión.
    let target = target_of(state);
    let approvals = state.approvals.clone();
    let task_sink = sink.clone();
    let panic_sink = sink;
    state.streams.spawn(
        window,
        StreamKind::Build,
        async move {
            let adapter = SinkAdapter(task_sink.clone());
            // Aprobación humana (diálogo nativo) solo si el contexto es sensible.
            let prompt = builds.service.approval_prompt(ticket.as_deref());
            let approval = match obtain_approval(approvals, prompt).await {
                Ok(a) => a,
                Err(e) => {
                    task_sink.send(ended_error(e));
                    return;
                }
            };
            let r = builds
                .service
                .run(
                    &spec,
                    ticket.as_deref(),
                    approval,
                    &target,
                    &adapter,
                    std::future::pending(),
                )
                .await;
            if let Err(e) = r {
                task_sink.send(ended_error(e));
            }
        },
        move || {
            panic_sink.send(ended_error(ApiError::new(
                ApiErrorCode::Internal,
                "error interno en la construcción",
            )));
        },
    )
}
