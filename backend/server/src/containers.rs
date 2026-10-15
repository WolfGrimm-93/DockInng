//! Prueba de concepto: un endpoint real contra el motor, para confirmar que el servidor es
//! un adaptador más de `engine-core`/`engine-docker`, igual que la CLI y la app de escritorio.
//! Listar contenedores no modifica nada: cualquier usuario autenticado puede.

use axum::Json;
use axum::extract::State;
use engine_core::Container;

use crate::auth::CurrentUser;
use crate::error::HttpError;
use crate::state::AppState;

pub async fn list_containers(
    _user: CurrentUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<Container>>, HttpError> {
    let items = state.engine.list_containers(true).await?;
    Ok(Json(items))
}
