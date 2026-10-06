//! Flujo plan -> ticket -> ejecución de acciones destructivas.
//!
//! El backend resuelve los objetivos por sí mismo (`plan`), decide con la política y emite
//! un ticket de un solo uso. `execute` recibe solo el ticket: nunca objetivos del cliente.
//! Antes de tocar cada elemento se re-verifica (id completo, fingerprint) y jamás se
//! escala a `force`. Los prunes se ejecutan como N borrados unitarios, nunca con `/prune`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::api::{ApiError, ApiErrorCode};
use crate::approval::{Approval, ApprovalPrompt};
use crate::broker::{Broker, Clock, RedeemError, SystemClock, TICKET_TTL};
use crate::cleanup::CleanupSelection;
use crate::client::EngineClient;
use crate::error::EngineError;
use crate::model::ContainerState;
use crate::policy::{Action, Decision, DenyReason, Interactivity, decide, decide_batch};
use crate::stacks::StackControl;
use crate::validate;

/// Máximo de elementos por ticket.
pub const MAX_ITEMS: usize = 500;

/// Petición de la UI. Solo describe la intención; el backend resuelve los objetivos.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActionRequest {
    RemoveContainers {
        ids: Vec<String>,
    },
    RemoveImage {
        reference: String,
    },
    PruneImages,
    RemoveVolume {
        name: String,
    },
    PruneVolumes,
    RemoveNetwork {
        id: String,
    },
    StackDown {
        project: String,
    },
    /// Borra los archivos de un stack propio (irreversible).
    StackDelete {
        name: String,
    },
    /// Limpieza guiada: el usuario marca elementos concretos (nunca un prune ciego).
    Cleanup {
        selection: CleanupSelection,
    },
    PruneSystem,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Container,
    Image,
    Volume,
    Network,
    Stack,
}

/// Decisión tal como viaja a la UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PlanDecision {
    Allow,
    Confirm,
    ConfirmTyped { expected: String },
    Deny { reason: PlanDenyReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanDenyReason {
    Forbidden,
    NeedsConfirmationNonInteractive,
}

impl From<&Decision> for PlanDecision {
    fn from(d: &Decision) -> Self {
        match d {
            Decision::Allow => Self::Allow,
            Decision::Confirm => Self::Confirm,
            Decision::ConfirmTyped { expected } => Self::ConfirmTyped {
                expected: expected.clone(),
            },
            Decision::Deny(DenyReason::Forbidden) => Self::Deny {
                reason: PlanDenyReason::Forbidden,
            },
            Decision::Deny(DenyReason::NeedsConfirmationNonInteractive) => Self::Deny {
                reason: PlanDenyReason::NeedsConfirmationNonInteractive,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AffectedItem {
    pub kind: ItemKind,
    pub id: String,
    pub name: String,
    pub state: Option<ContainerState>,
    pub size_bytes: Option<u64>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PlanWarning {
    /// Contenedores en ejecución que se borrarán con force.
    RunningForce { count: u32 },
    /// Volúmenes con nombre montados: NO se borran con el contenedor.
    VolumesKept { items: Vec<String> },
    /// Carpetas del equipo montadas: no se tocan.
    BindMountsKept { items: Vec<String> },
    /// Imagen usada por contenedores.
    InUse { count: u32 },
    /// Limpieza: elementos omitidos porque ya no existen o pasaron a estar en uso.
    Skipped { items: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionPlan {
    pub decision: PlanDecision,
    /// UUID v7; `None` si la decisión es `allow` o `deny`.
    pub ticket: Option<String>,
    pub expires_in_secs: u32,
    pub affected: Vec<AffectedItem>,
    pub warnings: Vec<PlanWarning>,
    pub total_size_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemRef {
    pub kind: ItemKind,
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailedItem {
    pub item: ItemRef,
    pub error: ApiError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionOutcome {
    pub succeeded: Vec<ItemRef>,
    pub failed: Vec<FailedItem>,
    pub freed_bytes: Option<u64>,
}

/// Errores del flujo de acciones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionError {
    Engine(EngineError),
    PolicyDenied(String),
    TicketInvalid,
    TicketExpired,
    TypedMismatch,
    NotImplemented(String),
    /// Demasiados planes pendientes de confirmar.
    TooManyPending,
}

impl From<EngineError> for ActionError {
    fn from(e: EngineError) -> Self {
        Self::Engine(e)
    }
}

impl From<ActionError> for ApiError {
    fn from(e: ActionError) -> Self {
        match e {
            ActionError::Engine(e) => e.into(),
            ActionError::PolicyDenied(m) => ApiError::new(ApiErrorCode::PolicyDenied, m),
            ActionError::TicketInvalid => ApiError::new(
                ApiErrorCode::TicketInvalid,
                "el ticket no existe o ya se usó",
            ),
            ActionError::TicketExpired => {
                ApiError::new(ApiErrorCode::TicketExpired, "el ticket expiró")
            }
            ActionError::TypedMismatch => ApiError::new(
                ApiErrorCode::TypedMismatch,
                "la confirmación escrita no coincide",
            ),
            ActionError::NotImplemented(m) => ApiError::new(ApiErrorCode::NotImplemented, m),
            ActionError::TooManyPending => ApiError::new(
                ApiErrorCode::Conflict,
                "demasiados planes pendientes: confirma o cancela alguno antes de crear otro",
            ),
        }
    }
}

#[derive(Debug, Clone)]
struct PlannedItem {
    kind: ItemKind,
    id: String,
    name: String,
    action: Action,
    force: bool,
    /// Huella para detectar recreaciones: created_at (contenedor/volumen), id (imagen/red).
    fingerprint: Option<String>,
    size_bytes: Option<u64>,
    /// Estado real del contenedor al planificar (solo contenedores).
    state: Option<ContainerState>,
}

#[derive(Debug, Clone)]
struct Payload {
    items: Vec<PlannedItem>,
}

/// Máximo de elementos listados en el diálogo de aprobación.
const PROMPT_MAX_LINES: usize = 10;

fn redeem_error(e: RedeemError) -> ActionError {
    match e {
        RedeemError::Invalid => ActionError::TicketInvalid,
        RedeemError::Expired => ActionError::TicketExpired,
        RedeemError::TypedMismatch => ActionError::TypedMismatch,
        RedeemError::NotConfirmed => {
            ActionError::PolicyDenied("la acción requiere la aprobación del usuario".into())
        }
    }
}

fn kind_label(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Container => "contenedor",
        ItemKind::Image => "imagen",
        ItemKind::Volume => "volumen",
        ItemKind::Network => "red",
        ItemKind::Stack => "stack",
    }
}

pub struct ActionService {
    engine: Arc<dyn EngineClient>,
    broker: Broker<Payload>,
    /// Control de stacks (bajar / borrar). `None` en la CLI y en tests sin stacks.
    stacks: Option<Arc<dyn StackControl>>,
}

impl ActionService {
    pub fn new(engine: Arc<dyn EngineClient>) -> Self {
        Self::with_clock(engine, Arc::new(SystemClock::new()))
    }

    pub fn with_clock(engine: Arc<dyn EngineClient>, clock: Arc<dyn Clock>) -> Self {
        Self {
            engine,
            broker: Broker::new(clock),
            stacks: None,
        }
    }

    /// Servicio con control de stacks (bajar y borrar stacks).
    pub fn with_stacks(
        engine: Arc<dyn EngineClient>,
        stacks: Option<Arc<dyn StackControl>>,
    ) -> Self {
        let mut s = Self::new(engine);
        s.stacks = stacks;
        s
    }

    pub fn cancel(&self, ticket: &str) -> bool {
        self.broker.cancel(ticket)
    }

    /// Tickets vigentes (diagnóstico y tests).
    pub fn pending_tickets(&self) -> usize {
        self.broker.pending()
    }

    /// Invalida todos los tickets pendientes.
    pub fn invalidate_all(&self) {
        self.broker.clear();
    }

    /// Resuelve objetivos, aplica la política y emite el ticket. La GUI siempre es
    /// interactiva y sin `assume_yes`.
    pub async fn plan(&self, req: ActionRequest) -> Result<ActionPlan, ActionError> {
        self.plan_with(req, Interactivity::Interactive, false).await
    }

    /// Como [`Self::plan`] pero con la interactividad y el `--yes` reales del llamador (CLI).
    /// El ticket se emite con la exigencia máxima (la de una persona delante): `assume_yes` solo
    /// relaja la decisión mostrada al llamador para las confirmaciones simples, nunca la
    /// confirmación escrita ni los prunes de imágenes. Con `Deny` no hay ticket.
    pub async fn plan_with(
        &self,
        req: ActionRequest,
        interactivity: Interactivity,
        assume_yes: bool,
    ) -> Result<ActionPlan, ActionError> {
        let mut warnings = Vec::new();
        // Elementos que solo se muestran en el plan (p. ej. los contenedores de un stack que
        // se baja: `down` los detiene, pero no se ejecuta nada por ellos).
        let mut display_only: Vec<AffectedItem> = Vec::new();
        let items: Vec<PlannedItem> = match req {
            ActionRequest::PruneSystem => {
                return Ok(ActionPlan {
                    decision: PlanDecision::from(&decide(
                        &Action::PruneSystem,
                        interactivity,
                        assume_yes,
                    )),
                    ticket: None,
                    expires_in_secs: 0,
                    affected: vec![],
                    warnings,
                    total_size_bytes: None,
                });
            }
            ActionRequest::StackDown { project } => {
                self.plan_stack_down(project, &mut warnings, &mut display_only)
                    .await?
            }
            ActionRequest::StackDelete { name } => self.plan_stack_delete(name).await?,
            ActionRequest::RemoveContainers { ids } => {
                self.plan_containers(ids, &mut warnings).await?
            }
            ActionRequest::Cleanup { selection } => {
                self.plan_cleanup(selection, &mut warnings).await?
            }
            ActionRequest::RemoveImage { reference } => {
                validate::image_reference(&reference)?;
                let images = self.engine.list_images().await?;
                let row = images
                    .iter()
                    .find(|i| i.reference == reference || i.id == reference)
                    .ok_or_else(|| EngineError::NotFound(format!("imagen {reference}")))?;
                if row.containers > 0 {
                    warnings.push(PlanWarning::InUse {
                        count: row.containers,
                    });
                }
                vec![image_item(row, Action::RemoveImage)]
            }
            ActionRequest::PruneImages => {
                let images = self.engine.list_images().await?;
                images
                    .iter()
                    .filter(|i| i.containers == 0)
                    .map(|i| image_item(i, Action::PruneImages))
                    .collect()
            }
            ActionRequest::RemoveVolume { name } => {
                validate::volume_name(&name)?;
                let vols = self.engine.list_volumes().await?;
                let v = vols
                    .iter()
                    .find(|v| v.name == name)
                    .ok_or_else(|| EngineError::NotFound(format!("volumen {name}")))?;
                if !v.used_by.is_empty() {
                    return Err(EngineError::Conflict(format!(
                        "el volumen {name} está en uso por: {}",
                        v.used_by.join(", ")
                    ))
                    .into());
                }
                vec![volume_item(v, Action::RemoveVolume { name })]
            }
            ActionRequest::PruneVolumes => {
                let vols = self.engine.list_volumes().await?;
                vols.iter()
                    .filter(|v| v.used_by.is_empty())
                    .map(|v| volume_item(v, Action::PruneVolumes))
                    .collect()
            }
            ActionRequest::RemoveNetwork { id } => {
                validate::container_id(&id)?;
                let nets = self.engine.list_networks().await?;
                let n = resolve_network(&nets, &id)?
                    .ok_or_else(|| EngineError::NotFound(format!("red {id}")))?;
                if n.system {
                    return Err(EngineError::Conflict(format!(
                        "la red {} es del sistema y no se puede eliminar",
                        n.name
                    ))
                    .into());
                }
                if !n.connected.is_empty() {
                    return Err(EngineError::Conflict(format!(
                        "la red {} tiene contenedores conectados: {}",
                        n.name,
                        n.connected.join(", ")
                    ))
                    .into());
                }
                vec![PlannedItem {
                    kind: ItemKind::Network,
                    id: n.id.clone(),
                    name: n.name.clone(),
                    action: Action::RemoveNetwork,
                    force: false,
                    fingerprint: Some(n.id.clone()),
                    size_bytes: None,
                    state: None,
                }]
            }
        };

        if items.len() > MAX_ITEMS {
            return Err(EngineError::InvalidInput(format!(
                "demasiados elementos ({}, máximo {MAX_ITEMS})",
                items.len()
            ))
            .into());
        }

        let actions: Vec<Action> = items.iter().map(|i| i.action.clone()).collect();
        // Exigencia máxima (persona delante) = la del ticket; `effective` = la del llamador.
        let decision = decide_batch(&actions, Interactivity::Interactive, false);
        let effective = decide_batch(&actions, interactivity, assume_yes);
        // Una imagen con varias etiquetas ocupa el espacio una sola vez.
        let mut counted = std::collections::HashSet::new();
        let known: Vec<u64> = items
            .iter()
            .filter(|i| counted.insert((i.kind, i.id.clone())))
            .filter_map(|i| i.size_bytes)
            .collect();
        let total_size_bytes = if known.is_empty() {
            None
        } else {
            Some(known.iter().sum())
        };
        let affected = items
            .iter()
            .map(|i| AffectedItem {
                kind: i.kind,
                id: i.id.clone(),
                name: i.name.clone(),
                state: i.state,
                size_bytes: i.size_bytes,
                detail: None,
            })
            .chain(display_only)
            .collect::<Vec<_>>();
        let needs_ticket = !items.is_empty()
            && !matches!(decision, Decision::Allow | Decision::Deny(_))
            && !matches!(effective, Decision::Deny(_));
        let ticket = if needs_ticket {
            Some(
                self.broker
                    .issue(Payload { items }, decision.clone())
                    .map_err(|_| ActionError::TooManyPending)?,
            )
        } else {
            None
        };
        Ok(ActionPlan {
            decision: PlanDecision::from(&effective),
            ticket,
            expires_in_secs: TICKET_TTL.as_secs() as u32,
            affected,
            warnings,
            total_size_bytes,
        })
    }

    fn stack_control(&self) -> Result<&Arc<dyn StackControl>, ActionError> {
        self.stacks.as_ref().ok_or_else(|| {
            ActionError::NotImplemented(
                "el control de stacks no está disponible en esta interfaz".into(),
            )
        })
    }

    /// Contenedores (de cualquier estado) del proyecto de Compose, con el mismo criterio que
    /// el descubrimiento por labels.
    async fn project_containers(
        &self,
        project: &str,
    ) -> Result<Vec<crate::model::Container>, EngineError> {
        Ok(self
            .engine
            .list_containers(true)
            .await?
            .into_iter()
            .filter(|c| c.compose_project.as_deref() == Some(project))
            .collect())
    }

    /// `down` de un stack: el backend fija los objetivos (contenedores del proyecto) y la huella.
    async fn plan_stack_down(
        &self,
        project: String,
        warnings: &mut Vec<PlanWarning>,
        display_only: &mut Vec<AffectedItem>,
    ) -> Result<Vec<PlannedItem>, ActionError> {
        stack_name_ok(&project)?;
        let stacks = self.stack_control()?;
        let containers = self.project_containers(&project).await?;
        let origin = stacks.origin_of(&project).await?;
        if origin.is_none() && containers.is_empty() {
            return Err(EngineError::NotFound(format!("stack {project}")).into());
        }
        let (mut volumes, mut binds) = (Vec::new(), Vec::new());
        for c in &containers {
            for m in &c.mounts {
                match m.kind {
                    crate::model::MountKind::Volume => {
                        volumes.push(m.name.clone().unwrap_or_else(|| m.source.clone()))
                    }
                    crate::model::MountKind::Bind => binds.push(m.source.clone()),
                    _ => {}
                }
            }
            display_only.push(AffectedItem {
                kind: ItemKind::Container,
                id: c.id.clone(),
                name: c.names.first().cloned().unwrap_or_default(),
                state: Some(c.state),
                size_bytes: None,
                detail: None,
            });
        }
        // `down` nunca usa `-v`: los volúmenes con nombre y las carpetas montadas se conservan.
        volumes.sort();
        volumes.dedup();
        binds.sort();
        binds.dedup();
        if !volumes.is_empty() {
            warnings.push(PlanWarning::VolumesKept { items: volumes });
        }
        if !binds.is_empty() {
            warnings.push(PlanWarning::BindMountsKept { items: binds });
        }
        Ok(vec![PlannedItem {
            kind: ItemKind::Stack,
            id: project.clone(),
            name: project.clone(),
            action: Action::StackDown {
                project: project.clone(),
            },
            force: false,
            fingerprint: Some(stack_fingerprint(&containers)),
            size_bytes: None,
            state: None,
        }])
    }

    /// Borrar los archivos de un stack propio (irreversible): solo `managed` y sin contenedores.
    async fn plan_stack_delete(&self, name: String) -> Result<Vec<PlannedItem>, ActionError> {
        stack_name_ok(&name)?;
        let stacks = self.stack_control()?;
        match stacks.origin_of(&name).await? {
            None => return Err(EngineError::NotFound(format!("stack {name}")).into()),
            Some(crate::stacks::StackOrigin::Managed) => {}
            Some(_) => {
                return Err(EngineError::Conflict(
                    "un stack vinculado se desvincula, no se borra (tus archivos no se tocan)"
                        .into(),
                )
                .into());
            }
        }
        if !self.project_containers(&name).await?.is_empty() {
            return Err(EngineError::Conflict(format!(
                "el stack {name} todavía tiene contenedores: bájalo antes de borrarlo"
            ))
            .into());
        }
        Ok(vec![PlannedItem {
            kind: ItemKind::Stack,
            id: name.clone(),
            name: name.clone(),
            action: Action::StackDelete { name },
            force: false,
            fingerprint: Some("managed".into()),
            size_bytes: None,
            state: None,
        }])
    }

    async fn run_stack_item(&self, item: &PlannedItem) -> Result<(), ApiError> {
        let changed = |m: String| ApiError::new(ApiErrorCode::StateChanged, m);
        let stacks = self.stack_control().map_err(ApiError::from)?.clone();
        match &item.action {
            Action::StackDown { project } => {
                let containers = self.project_containers(project).await?;
                let exists = !containers.is_empty() || stacks.origin_of(project).await?.is_some();
                if !exists {
                    return Err(changed(format!("el stack {project} ya no existe")));
                }
                if Some(stack_fingerprint(&containers)) != item.fingerprint {
                    return Err(changed(format!(
                        "el stack {project} cambió desde que se planificó; no se bajó"
                    )));
                }
                stacks.down(project).await?;
                Ok(())
            }
            Action::StackDelete { name } => {
                if stacks.origin_of(name).await? != Some(crate::stacks::StackOrigin::Managed) {
                    return Err(changed(format!("el stack {name} cambió o ya no existe")));
                }
                if !self.project_containers(name).await?.is_empty() {
                    return Err(changed(format!(
                        "el stack {name} ahora tiene contenedores; no se borró"
                    )));
                }
                stacks.delete_files(name).await?;
                Ok(())
            }
            _ => Err(ApiError::new(
                ApiErrorCode::PolicyDenied,
                "acción de stack no reconocida",
            )),
        }
    }

    /// Limpieza guiada: cada elemento marcado se valida por separado y se expande a los mismos
    /// borrados unitarios que el resto de acciones. Un elemento que ya no existe o que pasó a
    /// estar en uso desde que se generó el informe se OMITE con un aviso (no tumba el plan);
    /// la re-verificación por elemento al ejecutar sigue siendo la barrera real.
    async fn plan_cleanup(
        &self,
        sel: CleanupSelection,
        warnings: &mut Vec<PlanWarning>,
    ) -> Result<Vec<PlannedItem>, ActionError> {
        if sel.is_empty() {
            return Err(EngineError::InvalidInput("no hay nada seleccionado".into()).into());
        }
        if sel.len() > MAX_ITEMS {
            return Err(EngineError::InvalidInput(format!(
                "demasiados elementos ({}, máximo {MAX_ITEMS})",
                sel.len()
            ))
            .into());
        }
        let mut out: Vec<PlannedItem> = Vec::new();
        let mut skipped: Vec<String> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for id in &sel.containers {
            validate::container_id(id)?;
            let d = match self.engine.inspect_container(id).await {
                Ok(d) => d,
                Err(EngineError::NotFound(_)) => {
                    skipped.push(id.clone());
                    continue;
                }
                Err(e) => return Err(e.into()),
            };
            if !seen.insert((ItemKind::Container, d.summary.id.clone())) {
                continue;
            }
            if d.summary.state.is_live() {
                skipped.push(
                    d.summary
                        .names
                        .first()
                        .cloned()
                        .unwrap_or_else(|| id.clone()),
                );
                continue;
            }
            out.push(PlannedItem {
                kind: ItemKind::Container,
                id: d.summary.id.clone(),
                name: d.summary.names.first().cloned().unwrap_or_default(),
                action: Action::RemoveContainer { force: false },
                force: false,
                fingerprint: Some(d.created_at.clone()),
                size_bytes: None,
                state: Some(d.summary.state),
            });
        }
        if !sel.images.is_empty() {
            let images = self.engine.list_images().await?;
            for target in &sel.images {
                validate::image_reference(target)?;
                let rows: Vec<&crate::Image> = images
                    .iter()
                    .filter(|i| i.reference == *target || i.id == *target)
                    .collect();
                if rows.is_empty() {
                    skipped.push(target.clone());
                    continue;
                }
                for row in rows {
                    if row.containers > 0 {
                        skipped.push(row.reference.clone());
                        continue;
                    }
                    if seen.insert((ItemKind::Image, row.reference.clone())) {
                        out.push(image_item(row, Action::PruneImages));
                    }
                }
            }
        }
        if !sel.volumes.is_empty() {
            let vols = self.engine.list_volumes().await?;
            for name in &sel.volumes {
                validate::volume_name(name)?;
                match vols.iter().find(|v| v.name == *name) {
                    None => skipped.push(name.clone()),
                    Some(v) if !v.used_by.is_empty() => skipped.push(name.clone()),
                    Some(v) => {
                        if seen.insert((ItemKind::Volume, v.name.clone())) {
                            out.push(volume_item(v, Action::PruneVolumes));
                        }
                    }
                }
            }
        }
        if !sel.networks.is_empty() {
            let nets = self.engine.list_networks().await?;
            for id in &sel.networks {
                validate::container_id(id)?;
                let Some(n) = resolve_network(&nets, id)? else {
                    skipped.push(id.clone());
                    continue;
                };
                // Una red del sistema no es "en uso": es un error de la selección.
                if n.system {
                    return Err(EngineError::Conflict(format!(
                        "la red {} es del sistema y no se puede eliminar",
                        n.name
                    ))
                    .into());
                }
                if !n.connected.is_empty() {
                    skipped.push(n.name.clone());
                    continue;
                }
                if seen.insert((ItemKind::Network, n.id.clone())) {
                    out.push(PlannedItem {
                        kind: ItemKind::Network,
                        id: n.id.clone(),
                        name: n.name.clone(),
                        action: Action::RemoveNetwork,
                        force: false,
                        fingerprint: Some(n.id.clone()),
                        size_bytes: None,
                        state: None,
                    });
                }
            }
        }
        if !skipped.is_empty() {
            if out.is_empty() {
                return Err(EngineError::Conflict(format!(
                    "nada que limpiar: ya no existen o están en uso ({})",
                    skipped.join(", ")
                ))
                .into());
            }
            warnings.push(PlanWarning::Skipped { items: skipped });
        }
        Ok(out)
    }

    async fn plan_containers(
        &self,
        ids: Vec<String>,
        warnings: &mut Vec<PlanWarning>,
    ) -> Result<Vec<PlannedItem>, ActionError> {
        if ids.len() > MAX_ITEMS {
            return Err(EngineError::InvalidInput("demasiados contenedores".into()).into());
        }
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        let (mut running, mut volumes, mut binds) = (0u32, Vec::new(), Vec::new());
        for id in ids {
            validate::container_id(&id)?;
            let d = self.engine.inspect_container(&id).await?;
            // Se identifica por id completo: dos nombres del mismo contenedor cuentan una vez.
            if !seen.insert(d.summary.id.clone()) {
                continue;
            }
            // `force` lo decide el backend por el estado real.
            let force = d.summary.state.is_live();
            if force {
                running += 1;
            }
            for m in &d.summary.mounts {
                match m.kind {
                    crate::model::MountKind::Volume => {
                        volumes.push(m.name.clone().unwrap_or_else(|| m.source.clone()))
                    }
                    crate::model::MountKind::Bind => binds.push(m.source.clone()),
                    _ => {}
                }
            }
            out.push(PlannedItem {
                kind: ItemKind::Container,
                id: d.summary.id.clone(),
                name: d.summary.names.first().cloned().unwrap_or_default(),
                action: Action::RemoveContainer { force },
                force,
                fingerprint: Some(d.created_at.clone()),
                size_bytes: None,
                state: Some(d.summary.state),
            });
        }
        if running > 0 {
            warnings.push(PlanWarning::RunningForce { count: running });
        }
        volumes.sort();
        volumes.dedup();
        binds.sort();
        binds.dedup();
        if !volumes.is_empty() {
            warnings.push(PlanWarning::VolumesKept { items: volumes });
        }
        if !binds.is_empty() {
            warnings.push(PlanWarning::BindMountsKept { items: binds });
        }
        Ok(out)
    }

    /// Lo que la app muestra en el diálogo de aprobación antes de canjear `ticket`. `None` si la
    /// decisión no exige confirmación (o el ticket no existe / expiró).
    pub fn approval_prompt(&self, ticket: &str) -> Result<Option<ApprovalPrompt>, ActionError> {
        self.broker
            .peek(ticket, |payload, decision| {
                if !decision.needs_confirmation() {
                    return None;
                }
                let n = payload.items.len();
                let mut lines: Vec<String> = payload
                    .items
                    .iter()
                    .take(PROMPT_MAX_LINES)
                    .map(|i| format!("{}: {}", kind_label(i.kind), i.name))
                    .collect();
                if n > PROMPT_MAX_LINES {
                    lines.push(format!("y {} más", n - PROMPT_MAX_LINES));
                }
                Some(ApprovalPrompt {
                    title: format!("Confirmar: {} elemento(s)", n),
                    lines,
                    typed_hint: match decision {
                        Decision::ConfirmTyped { expected } => Some(expected.clone()),
                        _ => None,
                    },
                })
            })
            .map_err(redeem_error)
    }

    /// Canjea el ticket y ejecuta elemento a elemento, continuando ante fallos.
    ///
    /// `approval` es la aprobación humana (diálogo nativo de la app o pregunta de la CLI). Si la
    /// decisión del ticket la exige y llega `None`, se rechaza con `PolicyDenied` y el ticket NO
    /// se consume. El webview no puede construir una aprobación: ver `crate::approval`.
    pub async fn execute(
        &self,
        ticket: &str,
        typed: Option<&str>,
        approval: Option<Approval>,
    ) -> Result<ActionOutcome, ActionError> {
        let (payload, decision) = self
            .broker
            .redeem(ticket, typed, approval)
            .map_err(redeem_error)?;

        let mut outcome = ActionOutcome {
            succeeded: vec![],
            failed: vec![],
            freed_bytes: None,
        };
        let mut freed: Option<u64> = None;
        let mut counted = std::collections::HashSet::new();
        // Cachés por ejecución: una sola lista de imágenes / redes.
        let mut images: Option<Vec<crate::Image>> = None;
        let mut networks: Option<Vec<crate::Network>> = None;
        let mut volumes: Option<Vec<crate::Volume>> = None;

        for item in payload.items {
            let r = ItemRef {
                kind: item.kind,
                id: item.id.clone(),
                name: item.name.clone(),
            };
            match self
                .run_item(&item, &decision, &mut images, &mut networks, &mut volumes)
                .await
            {
                Ok(()) => {
                    if let (Some(s), true) = (
                        item.size_bytes,
                        counted.insert((item.kind, item.id.clone())),
                    ) {
                        freed = Some(freed.unwrap_or(0) + s);
                    }
                    outcome.succeeded.push(r);
                }
                Err(error) => outcome.failed.push(FailedItem { item: r, error }),
            }
        }
        outcome.freed_bytes = freed;
        Ok(outcome)
    }

    async fn run_item(
        &self,
        item: &PlannedItem,
        confirmed: &Decision,
        images: &mut Option<Vec<crate::Image>>,
        networks: &mut Option<Vec<crate::Network>>,
        volumes: &mut Option<Vec<crate::Volume>>,
    ) -> Result<(), ApiError> {
        let changed = |m: String| ApiError::new(ApiErrorCode::StateChanged, m);
        // Defensa en profundidad: la política por elemento no puede ser más estricta
        // que lo confirmado (y un Deny nunca se ejecuta).
        let now = decide(&item.action, Interactivity::Interactive, false);
        if matches!(now, Decision::Deny(_)) || now.severity() > confirmed.severity() {
            return Err(ApiError::new(
                ApiErrorCode::PolicyDenied,
                "la política no permite esta acción",
            ));
        }
        match item.kind {
            ItemKind::Container => {
                let d = self.engine.inspect_container(&item.id).await?;
                if d.summary.id != item.id || Some(&d.created_at) != item.fingerprint.as_ref() {
                    return Err(changed(format!(
                        "el contenedor {} fue recreado; no se tocó",
                        item.name
                    )));
                }
                // Nunca se escala a force.
                if !item.force && d.summary.state.is_live() {
                    return Err(changed(format!(
                        "el contenedor {} ahora está en ejecución; no se eliminó",
                        item.name
                    )));
                }
                self.engine.remove_container(&item.id, item.force).await?;
            }
            ItemKind::Image => {
                if images.is_none() {
                    *images = Some(self.engine.list_images().await?);
                }
                let list = images.as_deref().unwrap_or(&[]);
                let row = list.iter().find(|i| i.reference == item.name);
                match row {
                    Some(r) if Some(&r.id) == item.fingerprint.as_ref() => {
                        if item.action == Action::PruneImages && r.containers > 0 {
                            return Err(changed(format!(
                                "la imagen {} ahora está en uso",
                                item.name
                            )));
                        }
                    }
                    _ => {
                        return Err(changed(format!(
                            "la imagen {} cambió o ya no existe",
                            item.name
                        )));
                    }
                }
                self.engine.remove_image(&item.name).await?;
            }
            ItemKind::Volume => {
                let v = self.engine.inspect_volume(&item.name).await?;
                if Some(volume_fingerprint(&v)) != item.fingerprint {
                    return Err(changed(format!(
                        "el volumen {} fue recreado; no se tocó",
                        item.name
                    )));
                }
                // Un prune/limpieza solo borra volúmenes que siguen sin uso.
                if item.action == Action::PruneVolumes {
                    if volumes.is_none() {
                        *volumes = Some(self.engine.list_volumes().await?);
                    }
                    let in_use = volumes
                        .as_deref()
                        .unwrap_or(&[])
                        .iter()
                        .any(|x| x.name == item.name && !x.used_by.is_empty());
                    if in_use {
                        return Err(changed(format!(
                            "el volumen {} ahora está en uso; no se tocó",
                            item.name
                        )));
                    }
                }
                self.engine.remove_volume(&item.name).await?;
            }
            ItemKind::Stack => self.run_stack_item(item).await?,
            ItemKind::Network => {
                if networks.is_none() {
                    *networks = Some(self.engine.list_networks().await?);
                }
                let list = networks.as_deref().unwrap_or(&[]);
                match list.iter().find(|n| n.id == item.id) {
                    Some(n) if n.connected.is_empty() && !n.system => {}
                    Some(_) => {
                        return Err(changed(format!(
                            "la red {} ahora tiene contenedores o es del sistema",
                            item.name
                        )));
                    }
                    None => {
                        return Err(changed(format!("la red {} ya no existe", item.name)));
                    }
                }
                self.engine.remove_network(&item.id).await?;
            }
        }
        Ok(())
    }
}

/// Resuelve una red: primero por id exacto y solo entonces por nombre; un nombre repetido
/// (varias redes con el mismo nombre) es ambiguo y se rechaza. `None` = no existe.
fn resolve_network<'a>(
    nets: &'a [crate::Network],
    id: &str,
) -> Result<Option<&'a crate::Network>, EngineError> {
    if let Some(n) = nets.iter().find(|n| n.id == id) {
        return Ok(Some(n));
    }
    let mut by_name = nets.iter().filter(|n| n.name == id);
    match (by_name.next(), by_name.next()) {
        (Some(_), Some(_)) => Err(EngineError::Conflict(format!(
            "el nombre de red {id} es ambiguo: usa el id"
        ))),
        (found, None) => Ok(found),
        _ => Ok(None),
    }
}

/// Misma regla que un nombre de proyecto de Compose: `^[a-z0-9][a-z0-9_-]{0,62}$`.
fn stack_name_ok(name: &str) -> Result<(), EngineError> {
    let ok = !name.is_empty()
        && name.len() <= 63
        && name.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || (i > 0 && (b == b'_' || b == b'-'))
        });
    if ok {
        Ok(())
    } else {
        Err(EngineError::InvalidInput(
            "nombre de stack con caracteres no permitidos".into(),
        ))
    }
}

/// Huella de un stack: ids completos de sus contenedores, ordenados.
fn stack_fingerprint(containers: &[crate::model::Container]) -> String {
    let mut ids: Vec<&str> = containers.iter().map(|c| c.id.as_str()).collect();
    ids.sort_unstable();
    ids.join(",")
}

fn image_item(i: &crate::Image, action: Action) -> PlannedItem {
    PlannedItem {
        kind: ItemKind::Image,
        id: i.id.clone(),
        name: i.reference.clone(),
        action,
        force: false,
        fingerprint: Some(i.id.clone()),
        size_bytes: Some(i.size_bytes),
        state: None,
    }
}

fn volume_item(v: &crate::Volume, action: Action) -> PlannedItem {
    PlannedItem {
        kind: ItemKind::Volume,
        id: v.name.clone(),
        name: v.name.clone(),
        action,
        force: false,
        fingerprint: Some(volume_fingerprint(v)),
        size_bytes: v.size_bytes,
        state: None,
    }
}

/// Huella compuesta de un volumen: `created_at` puede faltar (daemons antiguos, drivers), así
/// que se suman driver, mountpoint y labels para detectar un volumen recreado con el mismo nombre.
pub fn volume_fingerprint(v: &crate::Volume) -> String {
    let mut labels: Vec<_> = v.labels.iter().collect();
    labels.sort();
    format!(
        "{}|{}|{}|{:?}",
        v.created_at.as_deref().unwrap_or("-"),
        v.driver,
        v.mountpoint,
        labels
    )
}

#[cfg(test)]
mod extra_tests {
    use std::sync::Arc;

    use super::*;
    use crate::broker::tests::FakeClock;
    use crate::testing::MockEngine;
    use crate::{ContainerState, MountInfo, MountKind};

    fn svc(e: &Arc<MockEngine>) -> ActionService {
        ActionService::with_clock(e.clone(), Arc::new(FakeClock::default()))
    }

    fn removes(e: &MockEngine) -> Vec<String> {
        e.calls()
            .into_iter()
            .filter(|c| c.starts_with("remove_"))
            .collect()
    }

    fn mount(kind: MountKind, name: Option<&str>, source: &str) -> MountInfo {
        MountInfo {
            kind,
            name: name.map(String::from),
            source: source.into(),
            destination: "/x".into(),
            read_write: true,
        }
    }

    fn engine_imagenes() -> Arc<MockEngine> {
        let e = Arc::new(MockEngine::new());
        {
            let mut s = e.state();
            s.images.push(MockEngine::image("sha256:aa", "app:1", 0));
            s.images.push(MockEngine::image("sha256:bb", "uso:1", 2));
        }
        e
    }

    // ---- plan RemoveImage
    #[tokio::test]
    async fn plan_remove_image_por_referencia_id_y_advertencia_en_uso() {
        let e = engine_imagenes();
        let s = svc(&e);
        for target in ["app:1", "sha256:aa"] {
            let p = s
                .plan(ActionRequest::RemoveImage {
                    reference: target.into(),
                })
                .await
                .expect("plan");
            assert_eq!(p.decision, PlanDecision::Confirm);
            assert_eq!(p.affected[0].name, "app:1");
            assert!(p.warnings.is_empty());
        }
        let p = s
            .plan(ActionRequest::RemoveImage {
                reference: "uso:1".into(),
            })
            .await
            .expect("plan");
        assert!(p.warnings.contains(&PlanWarning::InUse { count: 2 }));
        assert!(p.ticket.is_some());
        assert!(matches!(
            s.plan(ActionRequest::RemoveImage {
                reference: "no:existe".into()
            })
            .await,
            Err(ActionError::Engine(EngineError::NotFound(_)))
        ));
        assert!(matches!(
            s.plan(ActionRequest::RemoveImage {
                reference: "a b".into()
            })
            .await,
            Err(ActionError::Engine(EngineError::InvalidInput(_)))
        ));
    }

    // ---- plan RemoveVolume
    #[tokio::test]
    async fn plan_remove_volume_en_uso_inexistente_e_invalido() {
        let e = Arc::new(MockEngine::new());
        e.state()
            .volumes
            .push(MockEngine::volume("uso", "t", &["web", "db"]));
        let s = svc(&e);
        let err = s
            .plan(ActionRequest::RemoveVolume { name: "uso".into() })
            .await
            .expect_err("en uso");
        let ActionError::Engine(EngineError::Conflict(m)) = err else {
            panic!("esperaba Conflict")
        };
        assert!(
            m.contains("está en uso por") && m.contains("web, db"),
            "{m}"
        );
        assert!(matches!(
            s.plan(ActionRequest::RemoveVolume {
                name: "nada".into()
            })
            .await,
            Err(ActionError::Engine(EngineError::NotFound(_)))
        ));
        assert!(matches!(
            s.plan(ActionRequest::RemoveVolume { name: "a/b".into() })
                .await,
            Err(ActionError::Engine(EngineError::InvalidInput(_)))
        ));
    }

    // ---- plan RemoveNetwork: por nombre y mensajes
    #[tokio::test]
    async fn plan_remove_network_por_nombre_y_mensajes() {
        let e = Arc::new(MockEngine::new());
        {
            let mut st = e.state();
            st.networks
                .push(MockEngine::network("n1", "bridge", &[], true));
            st.networks
                .push(MockEngine::network("n2", "app", &["web"], false));
            st.networks
                .push(MockEngine::network("n3", "libre", &[], false));
        }
        let s = svc(&e);
        let m = |r: Result<ActionPlan, ActionError>| match r {
            Err(ActionError::Engine(EngineError::Conflict(m))) => m,
            other => panic!("esperaba Conflict: {other:?}"),
        };
        assert!(
            m(s.plan(ActionRequest::RemoveNetwork {
                id: "bridge".into()
            })
            .await)
            .contains("del sistema")
        );
        assert!(
            m(s.plan(ActionRequest::RemoveNetwork { id: "app".into() })
                .await)
            .contains("contenedores conectados: web")
        );
        let p = s
            .plan(ActionRequest::RemoveNetwork { id: "libre".into() })
            .await
            .expect("plan");
        assert_eq!(p.affected[0].id, "n3");
        assert!(matches!(
            s.plan(ActionRequest::RemoveNetwork { id: "zzz".into() })
                .await,
            Err(ActionError::Engine(EngineError::NotFound(_)))
        ));
    }

    // ---- plan de contenedores: advertencias y dedup
    #[tokio::test]
    async fn plan_contenedores_advertencias_de_montajes_y_dedup_por_id() {
        let e = Arc::new(MockEngine::new());
        {
            let mut a = MockEngine::container("aaa", "web", ContainerState::Exited, "t1");
            a.summary.names.push("alias".into());
            a.summary.mounts = vec![
                mount(MountKind::Volume, Some("zeta"), "/v/zeta"),
                mount(MountKind::Volume, Some("alfa"), "/v/alfa"),
                mount(MountKind::Volume, Some("alfa"), "/v/alfa"),
                mount(MountKind::Volume, None, "/v/anonimo"),
                mount(MountKind::Bind, None, "/home/x"),
                mount(MountKind::Tmpfs, None, "tmpfs"),
            ];
            e.state().containers.push(a);
        }
        let s = svc(&e);
        let p = s
            .plan(ActionRequest::RemoveContainers {
                ids: vec!["web".into(), "alias".into(), "aaa".into()],
            })
            .await
            .expect("plan");
        assert_eq!(p.affected.len(), 1);
        assert!(p.warnings.contains(&PlanWarning::VolumesKept {
            items: vec!["/v/anonimo".into(), "alfa".into(), "zeta".into()]
        }));
        assert!(p.warnings.contains(&PlanWarning::BindMountsKept {
            items: vec!["/home/x".into()]
        }));
        assert!(
            !p.warnings
                .iter()
                .any(|w| matches!(w, PlanWarning::RunningForce { .. }))
        );
    }

    #[tokio::test]
    async fn error_de_inspect_en_el_segundo_id_aborta_sin_ticket() {
        let e = Arc::new(MockEngine::new());
        {
            let mut st = e.state();
            st.containers.push(MockEngine::container(
                "aaa",
                "a",
                ContainerState::Exited,
                "t",
            ));
            st.containers.push(MockEngine::container(
                "bbb",
                "b",
                ContainerState::Exited,
                "t",
            ));
        }
        let s = svc(&e);
        let r = s
            .plan(ActionRequest::RemoveContainers {
                ids: vec!["aaa".into(), "nope".into(), "bbb".into()],
            })
            .await;
        assert!(matches!(
            r,
            Err(ActionError::Engine(EngineError::NotFound(_)))
        ));
        assert_eq!(s.pending_tickets(), 0);
    }

    // ---- límite de 500 elementos vía prunes; prunes vacíos
    #[tokio::test]
    async fn prunes_con_mas_de_500_elementos_se_rechazan() {
        let e = Arc::new(MockEngine::new());
        {
            let mut st = e.state();
            for i in 0..501 {
                st.images.push(MockEngine::image(
                    &format!("sha256:{i}"),
                    &format!("i{i}:1"),
                    0,
                ));
                st.volumes
                    .push(MockEngine::volume(&format!("v{i}"), "t", &[]));
            }
        }
        let s = svc(&e);
        for req in [ActionRequest::PruneImages, ActionRequest::PruneVolumes] {
            match s.plan(req).await {
                Err(ActionError::Engine(EngineError::InvalidInput(m))) => {
                    assert!(m.contains("demasiados elementos (501"), "{m}");
                }
                other => panic!("esperaba InvalidInput: {other:?}"),
            }
        }
        assert_eq!(s.pending_tickets(), 0);
        // Exactamente 500 sí pasa.
        e.state().volumes.pop();
        assert!(
            s.plan(ActionRequest::PruneVolumes)
                .await
                .expect("500")
                .ticket
                .is_some()
        );
    }

    #[tokio::test]
    async fn prunes_sin_elementos_son_allow_sin_ticket() {
        let e = Arc::new(MockEngine::new());
        e.state()
            .volumes
            .push(MockEngine::volume("uso", "t", &["web"]));
        e.state()
            .images
            .push(MockEngine::image("sha256:1", "a:1", 1));
        let s = svc(&e);
        for req in [ActionRequest::PruneVolumes, ActionRequest::PruneImages] {
            let p = s.plan(req).await.expect("plan");
            assert_eq!(p.decision, PlanDecision::Allow);
            assert!(p.ticket.is_none() && p.affected.is_empty());
        }
    }

    // ---- run_item de imagen
    async fn plan_y_ticket(s: &ActionService, req: ActionRequest) -> String {
        s.plan(req).await.expect("plan").ticket.expect("ticket")
    }

    #[tokio::test]
    async fn ejecutar_imagen_borrada_retagueada_en_uso_y_exito() {
        let e = engine_imagenes();
        let s = svc(&e);
        let req = || ActionRequest::RemoveImage {
            reference: "app:1".into(),
        };

        // (a) ya no existe
        let t = plan_y_ticket(&s, req()).await;
        e.state().images.retain(|i| i.reference != "app:1");
        let out = s
            .execute(&t, None, Some(crate::Approval::for_tests()))
            .await
            .expect("exec");
        assert_eq!(out.failed[0].error.code, ApiErrorCode::StateChanged);
        assert!(
            out.failed[0]
                .error
                .message
                .contains("cambió o ya no existe")
        );

        // (b) retag: la referencia apunta a otro id
        e.state()
            .images
            .push(MockEngine::image("sha256:aa", "app:1", 0));
        let t = plan_y_ticket(&s, req()).await;
        e.state().images[1].id = "sha256:otro".into();
        let out = s
            .execute(&t, None, Some(crate::Approval::for_tests()))
            .await
            .expect("exec");
        assert_eq!(out.failed[0].error.code, ApiErrorCode::StateChanged);
        assert!(removes(&e).is_empty());

        // (d) éxito: remove_image recibe el nombre de la referencia
        e.state().images[1].id = "sha256:aa".into();
        let t = plan_y_ticket(&s, req()).await;
        let out = s
            .execute(&t, None, Some(crate::Approval::for_tests()))
            .await
            .expect("exec");
        assert_eq!(out.succeeded.len(), 1);
        assert_eq!(removes(&e), vec!["remove_image:app:1"]);
    }

    #[tokio::test]
    async fn prune_de_imagen_que_pasa_a_estar_en_uso_no_se_borra() {
        let e = engine_imagenes();
        let s = svc(&e);
        let t = plan_y_ticket(&s, ActionRequest::PruneImages).await;
        e.state().images[0].containers = 1;
        let out = s
            .execute(&t, None, Some(crate::Approval::for_tests()))
            .await
            .expect("exec");
        assert_eq!(out.failed[0].error.code, ApiErrorCode::StateChanged);
        assert!(out.failed[0].error.message.contains("ahora está en uso"));
        assert!(removes(&e).is_empty());
    }

    // ---- run_item de red
    #[tokio::test]
    async fn ejecutar_red_desaparecida_o_ahora_conectada() {
        let e = Arc::new(MockEngine::new());
        {
            let mut st = e.state();
            st.networks
                .push(MockEngine::network("n1", "libre", &[], false));
        }
        let s = svc(&e);
        let req = || ActionRequest::RemoveNetwork { id: "n1".into() };
        let t = plan_y_ticket(&s, req()).await;
        e.state().networks[0].connected = vec!["web".into()];
        let out = s
            .execute(&t, None, Some(crate::Approval::for_tests()))
            .await
            .expect("exec");
        assert!(
            out.failed[0]
                .error
                .message
                .contains("ahora tiene contenedores")
        );
        e.state().networks[0].connected.clear();
        let t = plan_y_ticket(&s, req()).await;
        e.state().networks.clear();
        let out = s
            .execute(&t, None, Some(crate::Approval::for_tests()))
            .await
            .expect("exec");
        assert!(out.failed[0].error.message.contains("ya no existe"));
        assert!(removes(&e).is_empty());
    }

    // ---- volumen inexistente en la ejecución: continúa con el resto
    #[tokio::test]
    async fn volumen_inexistente_al_ejecutar_falla_con_not_found_por_elemento() {
        let e = Arc::new(MockEngine::new());
        {
            let mut st = e.state();
            st.volumes.push(MockEngine::volume("a", "t", &[]));
            st.volumes.push(MockEngine::volume("b", "t", &[]));
        }
        let s = svc(&e);
        let t = plan_y_ticket(&s, ActionRequest::PruneVolumes).await;
        e.state().volumes.retain(|v| v.name != "a");
        // Se inyecta NotFound en `inspect_volume`: cada elemento falla por separado con su
        // código y la ejecución no se aborta.
        e.state()
            .fail
            .insert("inspect_volume".into(), EngineError::NotFound("a".into()));
        let s2 = s
            .execute(&t, Some("ELIMINAR"), Some(crate::Approval::for_tests()))
            .await
            .expect("exec");
        // Ninguno se borra y ambos se reportan.
        assert_eq!(s2.failed.len(), 2);
        assert!(
            s2.failed
                .iter()
                .all(|f| f.error.code == ApiErrorCode::NotFound)
        );
        assert!(removes(&e).is_empty());
    }

    // ---- defensa en profundidad de run_item
    #[tokio::test]
    async fn run_item_deniega_si_la_politica_es_mas_estricta_que_lo_confirmado() {
        let e = Arc::new(MockEngine::new());
        let s = svc(&e);
        let item = |action: Action| PlannedItem {
            kind: ItemKind::Volume,
            id: "v".into(),
            name: "v".into(),
            action,
            force: false,
            fingerprint: None,
            size_bytes: None,
            state: None,
        };
        let payload = Payload {
            items: vec![
                item(Action::PruneSystem),
                item(Action::RemoveVolume { name: "v".into() }),
            ],
        };
        // Ticket emitido con solo `Confirm`: PruneSystem (Deny) y RemoveVolume (typed) exceden.
        let t = s.broker.issue(payload, Decision::Confirm).expect("cupo");
        let out = s
            .execute(&t, None, Some(crate::Approval::for_tests()))
            .await
            .expect("exec");
        assert_eq!(out.failed.len(), 2);
        assert!(
            out.failed
                .iter()
                .all(|f| f.error.code == ApiErrorCode::PolicyDenied)
        );
        assert!(
            e.calls().is_empty(),
            "no debe llegar al motor: {:?}",
            e.calls()
        );
    }

    // B-1: `execute` sin confirmación explícita rechaza un ticket que exige confirmar, no
    // toca el motor y deja el ticket canjeable con confirmación.
    #[tokio::test]
    async fn execute_sin_confirmar_rechaza_y_no_consume_el_ticket() {
        let e = engine_imagenes();
        let s = svc(&e);
        let p = s
            .plan(ActionRequest::RemoveImage {
                reference: "app:1".into(),
            })
            .await
            .expect("plan");
        assert_eq!(p.decision, PlanDecision::Confirm);
        let t = p.ticket.expect("ticket");

        let err = s.execute(&t, None, None).await.expect_err("sin confirmar");
        assert!(matches!(err, ActionError::PolicyDenied(_)));
        assert_eq!(ApiError::from(err).code, ApiErrorCode::PolicyDenied);
        assert!(removes(&e).is_empty(), "no debe llegar al motor");
        assert_eq!(s.pending_tickets(), 1, "el ticket sigue vivo");

        let out = s
            .execute(&t, None, Some(crate::Approval::for_tests()))
            .await
            .expect("confirmado");
        assert_eq!(out.succeeded.len(), 1);
        assert_eq!(removes(&e), vec!["remove_image:app:1"]);
    }

    #[tokio::test]
    async fn approval_prompt_describe_lo_que_se_aprueba() {
        let e = engine_imagenes();
        let s = svc(&e);
        // Sin confirmación no hay diálogo.
        let allow = s
            .plan(ActionRequest::RemoveImage {
                reference: "app:1".into(),
            })
            .await
            .expect("plan");
        assert!(allow.ticket.is_some());
        let prompt = s
            .approval_prompt(allow.ticket.as_deref().expect("t"))
            .expect("consulta")
            .expect("exige aprobación");
        assert!(
            prompt.lines.iter().any(|l| l.contains("app:1")),
            "{prompt:?}"
        );
        assert_eq!(prompt.typed_hint, None);
        // Ticket inexistente: error, nunca un diálogo.
        assert_eq!(
            s.approval_prompt("no-existe").expect_err("inexistente"),
            ActionError::TicketInvalid
        );
        // El diálogo no consume el ticket.
        assert_eq!(s.pending_tickets(), 1);
    }

    // ---- cancel e invalidate_all
    #[tokio::test]
    async fn cancel_e_invalidate_all() {
        let e = engine_imagenes();
        let s = svc(&e);
        let req = || ActionRequest::RemoveImage {
            reference: "app:1".into(),
        };
        let t = plan_y_ticket(&s, req()).await;
        assert!(s.cancel(&t));
        assert!(!s.cancel(&t));
        assert_eq!(
            s.execute(&t, None, Some(crate::Approval::for_tests()))
                .await,
            Err(ActionError::TicketInvalid)
        );
        let t1 = plan_y_ticket(&s, req()).await;
        let _t2 = plan_y_ticket(&s, req()).await;
        assert_eq!(s.pending_tickets(), 2);
        s.invalidate_all();
        assert_eq!(s.pending_tickets(), 0);
        assert_eq!(
            s.execute(&t1, None, Some(crate::Approval::for_tests()))
                .await,
            Err(ActionError::TicketInvalid)
        );
    }

    // ---- ActionError -> ApiError
    #[test]
    fn tabla_de_conversion_action_error_a_api_error() {
        let casos: Vec<(ActionError, ApiErrorCode)> = vec![
            (
                ActionError::Engine(EngineError::Timeout),
                ApiErrorCode::Timeout,
            ),
            (
                ActionError::PolicyDenied("x".into()),
                ApiErrorCode::PolicyDenied,
            ),
            (ActionError::TicketInvalid, ApiErrorCode::TicketInvalid),
            (ActionError::TicketExpired, ApiErrorCode::TicketExpired),
            (ActionError::TypedMismatch, ApiErrorCode::TypedMismatch),
            (
                ActionError::NotImplemented("x".into()),
                ApiErrorCode::NotImplemented,
            ),
            (ActionError::TooManyPending, ApiErrorCode::Conflict),
        ];
        for (err, code) in casos {
            let api = ApiError::from(err.clone());
            assert_eq!(api.code, code, "{err:?}");
            assert!(!api.message.is_empty());
            assert!(api.cause.is_none());
        }
        assert_eq!(
            ApiError::from(ActionError::PolicyDenied("m".into())).message,
            "m"
        );
    }

    // ---- tamaños: sin duplicar por etiqueta, sin sumar lo fallido, None sin datos
    #[tokio::test]
    async fn total_y_liberado_cuentan_una_vez_por_imagen_y_no_suman_fallos() {
        let e = Arc::new(MockEngine::new());
        {
            let mut st = e.state();
            st.images.push(MockEngine::image("sha256:aa", "a:1", 0));
            st.images.push(MockEngine::image("sha256:aa", "a:2", 0));
            st.images.push(MockEngine::image("sha256:bb", "b:1", 0));
        }
        let s = svc(&e);
        let p = s.plan(ActionRequest::PruneImages).await.expect("plan");
        assert_eq!(p.total_size_bytes, Some(200));
        let t = p.ticket.expect("t");
        // b:1 cambia antes de ejecutar: su tamaño no cuenta como liberado.
        e.state().images[2].id = "sha256:zz".into();
        let out = s
            .execute(&t, None, Some(crate::Approval::for_tests()))
            .await
            .expect("exec");
        assert_eq!(out.succeeded.len(), 2);
        assert_eq!(out.failed.len(), 1);
        assert_eq!(out.freed_bytes, Some(100));
        // Sin tamaños conocidos => None.
        let e2 = Arc::new(MockEngine::new());
        e2.state()
            .networks
            .push(MockEngine::network("n", "libre", &[], false));
        let s2 = svc(&e2);
        let p = s2
            .plan(ActionRequest::RemoveNetwork { id: "n".into() })
            .await
            .expect("plan");
        assert_eq!(p.total_size_bytes, None);
        let out = s2
            .execute(
                &p.ticket.expect("t"),
                None,
                Some(crate::Approval::for_tests()),
            )
            .await
            .expect("exec");
        assert_eq!(out.freed_bytes, None);
    }

    // ---- force planificado y contenedor que se detiene: se elimina igual
    #[tokio::test]
    async fn contenedor_que_se_detiene_tras_el_plan_se_elimina_con_el_force_planificado() {
        let e = Arc::new(MockEngine::new());
        e.state().containers.push(MockEngine::container(
            "aaa",
            "web",
            ContainerState::Running,
            "t",
        ));
        let s = svc(&e);
        let t = plan_y_ticket(
            &s,
            ActionRequest::RemoveContainers {
                ids: vec!["aaa".into()],
            },
        )
        .await;
        e.state().containers[0].summary.state = ContainerState::Exited;
        let out = s
            .execute(&t, None, Some(crate::Approval::for_tests()))
            .await
            .expect("exec");
        assert_eq!(out.succeeded.len(), 1);
        assert_eq!(removes(&e), vec!["remove_container:aaa:force=true"]);
    }

    // ---- concurrencia sobre el mismo ticket
    #[tokio::test]
    async fn dos_execute_concurrentes_del_mismo_ticket_solo_borran_una_vez() {
        let e = Arc::new(MockEngine::new());
        e.state().containers.push(MockEngine::container(
            "aaa",
            "web",
            ContainerState::Exited,
            "t",
        ));
        let s = Arc::new(svc(&e));
        let t = plan_y_ticket(
            &s,
            ActionRequest::RemoveContainers {
                ids: vec!["aaa".into()],
            },
        )
        .await;
        let (a, b) = tokio::join!(
            {
                let s = s.clone();
                let t = t.clone();
                async move {
                    s.execute(&t, None, Some(crate::Approval::for_tests()))
                        .await
                }
            },
            {
                let s = s.clone();
                let t = t.clone();
                async move {
                    s.execute(&t, None, Some(crate::Approval::for_tests()))
                        .await
                }
            }
        );
        let oks = [a.is_ok(), b.is_ok()].iter().filter(|x| **x).count();
        assert_eq!(oks, 1);
        assert_eq!(removes(&e).len(), 1);
    }
}
