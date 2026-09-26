//! Comandos IPC de conexiones SSH/TLS y selector de contexto.
//! Todos devuelven `Result<T, ApiError>`; los argumentos llegan en camelCase desde JS.
//!
//! Firmas (`ConnSpec` = `{kind:'ssh', name, host, port, user, mode:'explicit'|'alias',
//! identity:{type:'agent'}|{type:'file', path}}` | `{kind:'tls', name, host, port, ca_path,
//! cert_path, key_path}`; solo RUTAS, nunca contenido de llaves):
//!   connection_list() -> ConnectionProfile[]                 (sin el motor local; ese es `local`)
//!   connection_probe_host_key(spec) -> HostKeyProbe          (solo lectura: NO confía en nada)
//!   connection_trust_host_key(spec, fingerprint) -> HostKeyProbe
//!        (re-sondea y escribe en el known_hosts PROPIO solo si la huella coincide con la vista;
//!         una clave cambiada da `connection` con causa `host_key_changed` y nunca se acepta)
//!   connection_test(spec) -> ConnTestResult                   (no activa; el fallo va dentro)
//!   connection_save(spec, id?) -> ConnectionProfile           (sin `id` CREA: un nombre ya usado da `conflict`;
//!        con `id` EDITA esa conexión, que no puede ser la activa; el nombre no puede ser el de otra)
//!   connection_delete(id, confirmed) -> ()                    (Action::RemoveConnection; no borra la activa)
//!   connection_select(id) -> ConnectionStatus                 (`local` o un id guardado; si falla, `ApiError`
//!        `connection` con `cause` clasificada y el motor sigue en el destino anterior)

use engine_core::{
    Action, ApiError, ApiErrorCode, ConnSpec, ConnTestResult, ConnectionProfile, ConnectionStatus,
    EngineError, HostKeyProbe, SshIdentity, connections::validate_spec,
};
use tauri::State;
use transport::keyscan;
use transport::ssh_args::SshTarget;

use crate::commands_store::{require_confirmed, with_store};
use crate::state::AppState;
use crate::switch::{known_hosts_path, select_connection, test_connection};

type ApiResult<T> = Result<T, ApiError>;

fn ssh_target(spec: &ConnSpec) -> ApiResult<SshTarget> {
    SshTarget::from_spec(spec).map_err(|e| ApiError::from(&e))
}

/// Comprueba que los archivos referenciados existen (no se leen).
fn check_paths_exist(spec: &ConnSpec) -> Result<(), EngineError> {
    let mut paths: Vec<(&str, &str)> = Vec::new();
    match spec {
        ConnSpec::Ssh {
            identity: SshIdentity::File { path },
            ..
        } => paths.push(("llave privada", path)),
        ConnSpec::Ssh { .. } => {}
        ConnSpec::Tls {
            ca_path,
            cert_path,
            key_path,
            ..
        } => {
            paths.push(("CA", ca_path));
            paths.push(("certificado de cliente", cert_path));
            paths.push(("llave de cliente", key_path));
        }
    }
    for (what, p) in paths {
        if !std::path::Path::new(p).is_file() {
            return Err(EngineError::InvalidInput(format!(
                "{what}: no existe el archivo {p}"
            )));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn connection_list(state: State<'_, AppState>) -> ApiResult<Vec<ConnectionProfile>> {
    with_store(&state, |s| s.connection_list()).await
}

#[tauri::command]
pub async fn connection_probe_host_key(
    state: State<'_, AppState>,
    spec: ConnSpec,
) -> ApiResult<HostKeyProbe> {
    let target = ssh_target(&spec)?;
    let kh = known_hosts_path(&state)?;
    keyscan::probe(&target, &kh)
        .await
        .map_err(|e| ApiError::from(&e))
}

#[tauri::command]
pub async fn connection_trust_host_key(
    state: State<'_, AppState>,
    spec: ConnSpec,
    fingerprint: String,
) -> ApiResult<HostKeyProbe> {
    let target = ssh_target(&spec)?;
    let kh = known_hosts_path(&state)?;
    // El directorio de datos existe (lo crea el almacén con 0700) antes de escribir.
    keyscan::trust(&target, &kh, &fingerprint)
        .await
        .map_err(|e| ApiError::from(&e))
}

#[tauri::command]
pub async fn connection_test(
    state: State<'_, AppState>,
    spec: ConnSpec,
) -> ApiResult<ConnTestResult> {
    Ok(test_connection(&state, spec).await)
}

#[tauri::command]
pub async fn connection_save(
    state: State<'_, AppState>,
    spec: ConnSpec,
    id: Option<String>,
) -> ApiResult<ConnectionProfile> {
    // Serializa con el cambio de conexión y protege a la conexión activa de ediciones.
    let _serial = state.switch_lock.write().await;
    if let Some(edit) = &id
        && state.remote.active_id().await.as_deref() == Some(edit.as_str())
    {
        return Err(ApiError::new(
            ApiErrorCode::Conflict,
            "la conexión está activa: cambia a otra antes de editarla",
        ));
    }
    validate_spec(&spec).map_err(|e| ApiError::from(&e))?;
    check_paths_exist(&spec).map_err(|e| ApiError::from(&e))?;
    // La huella en la que se confió (si la hay) se calcula con datos locales, sin red.
    let fp = match &spec {
        ConnSpec::Ssh { .. } => {
            let target = ssh_target(&spec)?;
            let kh = known_hosts_path(&state)?;
            keyscan::stored_fingerprint(&kh, &target)
                .await
                .map_err(|e| ApiError::from(&e))?
        }
        ConnSpec::Tls { .. } => None,
    };
    with_store(&state, move |s| {
        let mut profile = s.connection_save(&spec, id.as_deref())?;
        if let Some(fp) = fp {
            s.connection_set_host_key_fp(&profile.id, &fp)?;
            profile.host_key_fp = Some(fp);
        }
        Ok(profile)
    })
    .await
}

#[tauri::command]
pub async fn connection_delete(
    state: State<'_, AppState>,
    id: String,
    confirmed: bool,
) -> ApiResult<()> {
    require_confirmed(&Action::RemoveConnection, confirmed)?;
    // Serializa con connection_select: no se borra una conexión mientras se activa.
    let _serial = state.switch_lock.write().await;
    if state.remote.active_id().await.as_deref() == Some(id.as_str()) {
        return Err(ApiError::new(
            ApiErrorCode::Conflict,
            "la conexión está activa: cambia a otra antes de borrarla",
        ));
    }
    with_store(&state, move |s| s.connection_delete(&id)).await
}

#[tauri::command]
pub async fn connection_select(
    state: State<'_, AppState>,
    id: String,
) -> ApiResult<ConnectionStatus> {
    select_connection(&state, &id).await
}
