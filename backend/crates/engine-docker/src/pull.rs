//! Descarga de imágenes con progreso, sobre bollard.
//!
//! - Sin credenciales: las imágenes privadas fallan con `auth_required` hasta que exista la
//!   gestión de registros.
//! - Soltar el stream aborta la descarga en el daemon (verificado contra un registro local).
//! - Los errores llegan como HTTP 4xx/5xx ANTES del stream o como `DockerStreamError`
//!   dentro; ambos pasan por el mismo clasificador.

use std::time::Duration;

use bollard::errors::Error as BollardError;
use bollard::models::CreateImageInfo;
use bollard::query_parameters::CreateImageOptionsBuilder;
use engine_core::pull::{classify_pull_error, split_reference, validate_reference};
use engine_core::{EngineError, EngineStream, PullEngine, PullEvent};
use futures_util::{StreamExt, stream};

use crate::{DockerEngine, error_map};

/// Cabeceras de respuesta del daemon (resolver la referencia contra el registro puede tardar).
const HEADERS_TIMEOUT: Duration = Duration::from_secs(60);
/// Sin ningún evento durante este tiempo => `timeout`.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// Evento del daemon a evento del dominio.
pub(crate) fn convert_info(i: CreateImageInfo) -> PullEvent {
    let detail = i.progress_detail;
    PullEvent {
        id: i.id,
        status: i.status.unwrap_or_default(),
        current: detail
            .as_ref()
            .and_then(|d| d.current)
            .and_then(|c| u64::try_from(c).ok()),
        total: detail
            .as_ref()
            .and_then(|d| d.total)
            .and_then(|t| u64::try_from(t).ok()),
    }
}

/// Error de bollard durante un pull a error del dominio.
pub(crate) fn convert_error(e: &BollardError) -> EngineError {
    match e {
        BollardError::DockerResponseServerError {
            status_code,
            message,
        } => classify_pull_error(Some(*status_code), message)
            .unwrap_or_else(|| error_map::from_status(*status_code, message)),
        // Error a mitad de stream (`errorDetail`): el clasificador estándar lo mandaría a `Internal`.
        BollardError::DockerStreamError { error } => classify_pull_error(None, error)
            .unwrap_or_else(|| EngineError::Engine {
                status: 500,
                message: error.clone(),
            }),
        other => error_map::classify(other),
    }
}

impl PullEngine for DockerEngine {
    fn pull_image(&self, reference: &str) -> EngineStream<PullEvent> {
        let this = self.clone();
        let reference = reference.to_string();
        Box::pin(
            stream::once(async move {
                validate_reference(&reference)?;
                Ok((this.client().await?, reference))
            })
            .flat_map(|setup: Result<_, EngineError>| match setup {
                Err(e) => stream::once(async move { Err(e) }).boxed(),
                Ok((d, reference)) => {
                    let (image, tag) = split_reference(&reference);
                    let mut opts = CreateImageOptionsBuilder::default().from_image(&image);
                    if let Some(t) = &tag {
                        opts = opts.tag(t);
                    }
                    // Sin credenciales (`None`): la gestión de registros llega después.
                    let inner = d
                        .with_timeout(HEADERS_TIMEOUT)
                        .create_image(Some(opts.build()), None, None)
                        .boxed();
                    stream::unfold((inner, false), |(mut s, done)| async move {
                        if done {
                            return None;
                        }
                        match tokio::time::timeout(IDLE_TIMEOUT, s.next()).await {
                            Ok(Some(Ok(info))) => Some((Ok(convert_info(info)), (s, false))),
                            // Tras un error el stream termina.
                            Ok(Some(Err(e))) => Some((Err(convert_error(&e)), (s, true))),
                            Ok(None) => None,
                            Err(_) => Some((Err(EngineError::Timeout), (s, true))),
                        }
                    })
                    .boxed()
                }
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use engine_core::pull::{LayerPhase, PullTracker};
    use engine_core::{ApiErrorCode, EngineError};

    use super::*;

    const LAYERS: &str = include_str!("../tests/fixtures/pull/pull_layers_bollard.ndjson");
    const ERRORS: &str = include_str!("../tests/fixtures/pull/pull_errors_bollard.txt");

    #[test]
    fn el_ndjson_real_de_bollard_produce_tres_capas_completas() {
        let mut t = PullTracker::new();
        for line in LAYERS.lines().filter(|l| !l.trim().is_empty()) {
            let info: CreateImageInfo = serde_json::from_str(line).expect("CreateImageInfo real");
            t.feed(&convert_info(info));
        }
        let s = t.snapshot();
        assert_eq!(s.layers.len(), 3);
        assert!(s.layers.iter().all(|l| l.phase == LayerPhase::Complete));
        assert!(s.total_bytes > 10_000_000 && s.done_bytes == s.total_bytes);
    }

    /// Extrae (referencia, status, mensaje) de los bloques del fixture real.
    fn real_errors() -> Vec<(String, u16, String)> {
        let mut out = Vec::new();
        let mut current = String::new();
        for line in ERRORS.lines() {
            if let Some(r) = line.strip_prefix("=== ") {
                current = r.trim().to_string();
            } else if let Some(rest) = line.split("status_code: ").nth(1) {
                let status: u16 = rest
                    .split(',')
                    .next()
                    .expect("status")
                    .trim()
                    .parse()
                    .expect("u16");
                let msg = rest
                    .split("message: \"")
                    .nth(1)
                    .and_then(|m| m.rsplit_once("\" }"))
                    .map(|(m, _)| m.replace("\\\"", "\""))
                    .expect("message");
                out.push((current.clone(), status, msg));
            }
        }
        out
    }

    #[test]
    fn errores_reales_del_fixture_se_clasifican() {
        let errs = real_errors();
        assert_eq!(errs.len(), 5, "{errs:?}");
        let code = |e: &EngineError| match e {
            EngineError::Coded { code, .. } => Some(*code),
            EngineError::InvalidInput(_) => Some(ApiErrorCode::InvalidInput),
            _ => None,
        };
        for (reference, status, message) in errs {
            let e = convert_error(&BollardError::DockerResponseServerError {
                status_code: status,
                message,
            });
            let expected = if reference.ends_with("nope:1") {
                ApiErrorCode::ImageMissing
            } else if reference.ends_with("private:1") {
                ApiErrorCode::AuthRequired
            } else if reference.starts_with("localhost:1/") {
                ApiErrorCode::RegistryUnreachable
            } else {
                ApiErrorCode::InvalidInput
            };
            assert_eq!(code(&e), Some(expected), "{reference}: {e:?}");
        }
    }

    #[test]
    fn error_a_mitad_de_stream_pasa_por_el_clasificador() {
        let e = convert_error(&BollardError::DockerStreamError {
            error: "unauthorized: authentication required".into(),
        });
        assert!(matches!(
            e,
            EngineError::Coded {
                code: ApiErrorCode::AuthRequired,
                ..
            }
        ));
        let e = convert_error(&BollardError::DockerStreamError {
            error: "algo raro".into(),
        });
        assert!(matches!(e, EngineError::Engine { .. }));
    }

    #[tokio::test]
    async fn referencia_invalida_falla_en_la_primera_lectura_sin_tocar_el_daemon() {
        let d = DockerEngine::with_socket("/nonexistent/docker.sock");
        for bad in ["", "a b", "--flag", "x/../y"] {
            let mut s = d.pull_image(bad);
            let first = s.next().await.expect("un error");
            assert!(
                matches!(first, Err(EngineError::InvalidInput(_))),
                "{bad:?}: {first:?}"
            );
            assert!(s.next().await.is_none());
        }
        // Referencia válida pero sin socket: error de conexión, no pánico.
        let first = d.pull_image("alpine:latest").next().await.expect("error");
        assert!(
            matches!(first, Err(EngineError::Connection { .. })),
            "{first:?}"
        );
    }
}
