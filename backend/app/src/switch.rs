//! Selector de contexto: cambia el destino del motor (local, túnel SSH o TLS) SIN reconstruir
//! nada, porque todos los servicios comparten el mismo `DockerEngine` cuyo destino es mutable.
//!
//! Orden (para no molestar si el destino no funciona): 1) se PREPARA el destino nuevo (túnel o
//! certificados) y se prueba con un motor auxiliar: si falla aquí NO se toca nada
//! (`ApiError.quiesced` ausente); 2) solo si responde se PAUSA el registro de streams y comandos
//! de acción (rechazan con Conflict reintentable), y se abortan suscripciones, terminales y
//! tickets del contexto anterior; 3) se cambia el destino del motor compartido y se cierra la
//! conexión remota previa; 4) se reanuda. Si el paso 3 falla, el motor vuelve al destino
//! anterior pero lo del paso 2 YA se abortó: el error lleva `quiesced: true` para que la UI
//! reabra sus suscripciones.

use std::time::Duration;

use engine_core::{
    ApiError, ApiErrorCode, ConnSpec, ConnTestResult, ConnectionStatus, LOCAL_CONNECTION_ID,
};
use engine_docker::{DockerEngine, Endpoint, Target};
use transport::Prepared;

use crate::commands_store::with_store;
use crate::state::AppState;

type ApiResult<T> = Result<T, ApiError>;

/// Tiempo máximo que se espera a que las terminales abiertas cierren su shell.
const EXEC_CLOSE_LIMIT: Duration = Duration::from_secs(3);

/// Destino del motor a partir de una conexión remota ya preparada.
pub fn target_for(prepared: &Prepared) -> Target {
    if let Some(socket) = prepared.socket_path() {
        return Target::tunnel(
            &socket.to_string_lossy(),
            &prepared.label(),
            prepared.hint(),
        );
    }
    match prepared.tls() {
        Some((t, certs)) => Target::tls(Endpoint::Tls {
            addr: t.addr(),
            ca: t.ca.to_string_lossy().into_owned(),
            cert: t.cert.to_string_lossy().into_owned(),
            key: t.key.to_string_lossy().into_owned(),
            cert_dir: certs.path().to_string_lossy().into_owned(),
            label: t.label(),
        }),
        // `Prepared` solo tiene dos variantes: sin socket es TLS.
        None => Target::local(),
    }
}

/// Error de API a partir de un estado de conexión fallido.
fn failed_to_error(status: &ConnectionStatus) -> ApiError {
    match status {
        ConnectionStatus::Failed { cause, message, .. } => ApiError {
            code: ApiErrorCode::Connection,
            message: message.clone(),
            cause: Some(*cause),
            quiesced: false,
        },
        ConnectionStatus::Connected { .. } => {
            ApiError::new(ApiErrorCode::Internal, "estado de conexión inesperado")
        }
    }
}

/// Ruta del `known_hosts` propio (requiere el almacén: vive en su directorio de datos).
pub fn known_hosts_path(state: &AppState) -> ApiResult<std::path::PathBuf> {
    crate::commands_store::store_of(state).map(|s| s.known_hosts_path())
}

/// Prepara la conexión y la prueba con un motor auxiliar (sin tocar el motor compartido).
async fn prepare_and_probe(
    state: &AppState,
    spec: &ConnSpec,
) -> ApiResult<(Prepared, ConnectionStatus)> {
    let known_hosts = known_hosts_path(state)?;
    let prepared = state
        .remote
        .prepare(spec, &known_hosts)
        .await
        .map_err(|e| ApiError::from(&e))?;
    let probe = DockerEngine::new();
    probe.set_target(target_for(&prepared));
    let status = engine_core::EngineClient::diagnose(&probe).await;
    Ok((prepared, status))
}

/// `connection_test`: prueba sin activar. Siempre devuelve un resultado (el fallo va dentro).
pub async fn test_connection(state: &AppState, spec: ConnSpec) -> ConnTestResult {
    if let Err(e) = engine_core::connections::validate_spec(&spec) {
        return ConnTestResult {
            ok: false,
            server: None,
            error: Some(ApiError::from(&e)),
            cause: None,
        };
    }
    match prepare_and_probe(state, &spec).await {
        Err(e) => ConnTestResult {
            ok: false,
            server: None,
            cause: e.cause,
            error: Some(e),
        },
        Ok((prepared, status)) => {
            prepared.abandon().await;
            match status {
                ConnectionStatus::Connected { server, .. } => ConnTestResult {
                    ok: true,
                    server: Some(server),
                    error: None,
                    cause: None,
                },
                failed => {
                    let e = failed_to_error(&failed);
                    ConnTestResult {
                        ok: false,
                        server: None,
                        cause: e.cause,
                        error: Some(e),
                    }
                }
            }
        }
    }
}

/// Pausa el registro de streams y comandos de acción mientras dura el cambio; se reanuda al
/// soltarse (también en pánico o retorno anticipado).
struct SwitchGuard<'a>(&'a AppState);

impl<'a> SwitchGuard<'a> {
    fn new(state: &'a AppState) -> Self {
        state.streams.set_paused(true);
        Self(state)
    }
}

impl Drop for SwitchGuard<'_> {
    fn drop(&mut self) {
        self.0.streams.set_paused(false);
    }
}

/// Aborta lo que dependía del contexto anterior: suscripciones, terminales y tickets.
async fn quiesce(state: &AppState) {
    state.streams.abort_all();
    state.builds.service.invalidate_all();
    state.exec_sessions.close_all(EXEC_CLOSE_LIMIT).await;
    state.actions.invalidate_all();
    state.create.invalidate_all();
}

/// `connection_select`: cambia el contexto activo. `Ok` = conectado al nuevo destino.
pub async fn select_connection(state: &AppState, id: &str) -> ApiResult<ConnectionStatus> {
    let _serial = state.switch_lock.write().await;
    let docker = state.docker.clone().ok_or_else(|| {
        ApiError::new(
            ApiErrorCode::NotImplemented,
            "el cambio de conexión no está disponible con un motor simulado",
        )
    })?;

    if id == LOCAL_CONNECTION_ID {
        let _pause = SwitchGuard::new(state);
        quiesce(state).await;
        docker.set_target(state.local_target.clone().unwrap_or_else(Target::local));
        let status = engine_core::EngineClient::reconnect(docker.as_ref()).await;
        state.remote.deactivate().await;
        return Ok(status);
    }

    let profile = {
        let id = id.to_string();
        with_store(state, move |s| s.connection_get(&id)).await?
    };
    // 1) Preparar y probar con un motor auxiliar: si falla, nada cambia.
    let (prepared, status) = prepare_and_probe(state, &profile.spec).await?;
    if let ConnectionStatus::Failed { .. } = status {
        let err = failed_to_error(&status);
        prepared.abandon().await;
        return Err(err);
    }
    // 2) Ya se sabe que responde: se pausan los comandos nuevos y se abandona el contexto
    //    anterior (a partir de aquí un fallo lleva `quiesced: true`).
    let _pause = SwitchGuard::new(state);
    quiesce(state).await;
    // 3) Se cambia el destino del motor compartido; si aun así falla, se restaura.
    let previous = docker.set_target(target_for(&prepared));
    let status = engine_core::EngineClient::diagnose(docker.as_ref()).await;
    if let ConnectionStatus::Failed { .. } = status {
        let mut err = failed_to_error(&status);
        err.quiesced = true;
        docker.set_target(previous);
        prepared.abandon().await;
        return Err(err);
    }
    state.remote.activate(id, prepared).await;
    let touch_id = id.to_string();
    // La marca de "último uso" es informativa: un fallo aquí no invalida el cambio.
    let _ = with_store(state, move |s| s.connection_touch(&touch_id)).await;
    Ok(status)
}
