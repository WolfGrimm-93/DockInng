//! Mock mínimo de `StackDiscovery` + `StackControl`.

use std::sync::{Mutex, MutexGuard};

use async_trait::async_trait;

use crate::error::EngineError;
use crate::stacks::{ComposeContainer, StackControl, StackDiscovery, StackOrigin};

#[derive(Default)]
pub struct MockStacks {
    pub containers: Mutex<Vec<ComposeContainer>>,
    pub calls: Mutex<Vec<String>>,
    pub origins: Mutex<Vec<(String, StackOrigin)>>,
}

impl MockStacks {
    fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
        m.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn calls(&self) -> Vec<String> {
        Self::lock(&self.calls).clone()
    }
}

#[async_trait]
impl StackDiscovery for MockStacks {
    async fn list_compose_containers(&self) -> Result<Vec<ComposeContainer>, EngineError> {
        Ok(Self::lock(&self.containers).clone())
    }
}

#[async_trait]
impl StackControl for MockStacks {
    async fn down(&self, project: &str) -> Result<(), EngineError> {
        Self::lock(&self.calls).push(format!("down:{project}"));
        Ok(())
    }

    async fn delete_files(&self, name: &str) -> Result<(), EngineError> {
        Self::lock(&self.calls).push(format!("delete_files:{name}"));
        Ok(())
    }

    async fn origin_of(&self, name: &str) -> Result<Option<StackOrigin>, EngineError> {
        Ok(Self::lock(&self.origins)
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, o)| *o))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::actions::{
        ActionError, ActionRequest, ActionService, ItemKind, PlanDecision, PlanWarning,
    };
    use crate::api::{ApiError, ApiErrorCode};
    use crate::broker::tests::FakeClock;
    use crate::model::{ContainerState, MountInfo, MountKind};
    use crate::testing::MockEngine;

    fn setup() -> (Arc<MockEngine>, Arc<MockStacks>, ActionService) {
        let engine = Arc::new(MockEngine::new());
        let stacks = Arc::new(MockStacks::default());
        let svc = ActionService::with_stacks(engine.clone(), Some(stacks.clone()));
        let _ = FakeClock::default;
        (engine, stacks, svc)
    }

    fn add_container(e: &MockEngine, id: &str, project: &str, state: ContainerState) {
        let mut c = MockEngine::container(
            id,
            &format!("{project}-{id}"),
            state,
            "2026-01-01T00:00:00Z",
        );
        c.summary.compose_project = Some(project.into());
        c.summary.mounts = vec![
            MountInfo {
                kind: MountKind::Volume,
                name: Some("datos".into()),
                source: "/v".into(),
                destination: "/d".into(),
                read_write: true,
            },
            MountInfo {
                kind: MountKind::Bind,
                name: None,
                source: "/srv/x".into(),
                destination: "/x".into(),
                read_write: true,
            },
        ];
        e.state().containers.push(c);
    }

    fn api(e: ActionError) -> ApiError {
        e.into()
    }

    #[tokio::test]
    async fn down_planifica_con_backend_fijando_objetivos_y_pide_el_nombre_exacto() {
        let (engine, stacks, svc) = setup();
        add_container(&engine, "c1", "tienda", ContainerState::Running);
        add_container(&engine, "c2", "tienda", ContainerState::Exited);
        add_container(&engine, "c3", "otro", ContainerState::Running);
        let plan = svc
            .plan(ActionRequest::StackDown {
                project: "tienda".into(),
            })
            .await
            .unwrap();
        assert_eq!(
            plan.decision,
            PlanDecision::ConfirmTyped {
                expected: "tienda".into()
            }
        );
        assert!(plan.ticket.is_some());
        // Se muestra el stack y SUS contenedores (no los de otro proyecto).
        let kinds: Vec<_> = plan
            .affected
            .iter()
            .map(|a| (a.kind, a.name.as_str()))
            .collect();
        assert_eq!(kinds[0], (ItemKind::Stack, "tienda"));
        assert_eq!(
            plan.affected
                .iter()
                .filter(|a| a.kind == ItemKind::Container)
                .count(),
            2
        );
        assert!(plan.warnings.contains(&PlanWarning::VolumesKept {
            items: vec!["datos".into()]
        }));
        assert!(plan.warnings.contains(&PlanWarning::BindMountsKept {
            items: vec!["/srv/x".into()]
        }));
        let ticket = plan.ticket.unwrap();
        // Confirmación incorrecta / ausente.
        assert!(matches!(
            svc.execute(&ticket, Some("Tienda")).await,
            Err(ActionError::TypedMismatch)
        ));
        // Un fallo de confirmación no gasta el ticket? Se reemite el plan para el caso feliz.
        let plan = svc
            .plan(ActionRequest::StackDown {
                project: "tienda".into(),
            })
            .await
            .unwrap();
        let out = svc
            .execute(plan.ticket.as_deref().unwrap(), Some("tienda"))
            .await
            .unwrap();
        assert_eq!(out.succeeded.len(), 1);
        assert_eq!(out.succeeded[0].kind, ItemKind::Stack);
        assert_eq!(stacks.calls(), vec!["down:tienda"]);
        // Nunca se borraron contenedores por esta vía.
        assert!(engine.calls().iter().all(|c| !c.starts_with("remove_")));
        // Un solo uso.
        assert!(matches!(
            svc.execute(plan.ticket.as_deref().unwrap(), Some("tienda"))
                .await,
            Err(ActionError::TicketInvalid)
        ));
    }

    #[tokio::test]
    async fn down_revalida_y_detecta_que_el_stack_cambio_o_desaparecio() {
        let (engine, stacks, svc) = setup();
        add_container(&engine, "c1", "tienda", ContainerState::Running);
        let plan = svc
            .plan(ActionRequest::StackDown {
                project: "tienda".into(),
            })
            .await
            .unwrap();
        // Aparece un contenedor nuevo entre plan y ejecución.
        add_container(&engine, "c2", "tienda", ContainerState::Running);
        let out = svc
            .execute(plan.ticket.as_deref().unwrap(), Some("tienda"))
            .await
            .unwrap();
        assert!(out.succeeded.is_empty());
        assert_eq!(out.failed[0].error.code, ApiErrorCode::StateChanged);
        assert!(stacks.calls().is_empty());
        // Desaparece.
        let plan = svc
            .plan(ActionRequest::StackDown {
                project: "tienda".into(),
            })
            .await
            .unwrap();
        engine.state().containers.clear();
        let out = svc
            .execute(plan.ticket.as_deref().unwrap(), Some("tienda"))
            .await
            .unwrap();
        assert_eq!(out.failed[0].error.code, ApiErrorCode::StateChanged);
        assert!(stacks.calls().is_empty());
    }

    #[tokio::test]
    async fn down_rechaza_nombres_hostiles_e_inexistentes() {
        let (_engine, _stacks, svc) = setup();
        for bad in ["", "../x", "A", "a b", "a;b", "-x", "$(x)"] {
            let e = svc
                .plan(ActionRequest::StackDown {
                    project: bad.into(),
                })
                .await
                .unwrap_err();
            assert_eq!(api(e).code, ApiErrorCode::InvalidInput, "{bad:?}");
        }
        let e = svc
            .plan(ActionRequest::StackDown {
                project: "nada".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(api(e).code, ApiErrorCode::NotFound);
    }

    #[tokio::test]
    async fn borrar_solo_managed_sin_contenedores_y_con_nombre_exacto() {
        let (engine, stacks, svc) = setup();
        stacks.origins.lock().unwrap().extend([
            ("propio".to_string(), StackOrigin::Managed),
            ("vinculado".to_string(), StackOrigin::Linked),
            ("activo".to_string(), StackOrigin::Managed),
        ]);
        add_container(&engine, "c1", "activo", ContainerState::Running);
        // Vinculado: no se borra.
        let e = svc
            .plan(ActionRequest::StackDelete {
                name: "vinculado".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(api(e).code, ApiErrorCode::Conflict);
        // Con contenedores: bájalo antes.
        let e = svc
            .plan(ActionRequest::StackDelete {
                name: "activo".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(api(e).code, ApiErrorCode::Conflict);
        // Inexistente y discovered (sin archivos propios).
        let e = svc
            .plan(ActionRequest::StackDelete {
                name: "ajeno".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(api(e).code, ApiErrorCode::NotFound);
        // Feliz.
        let plan = svc
            .plan(ActionRequest::StackDelete {
                name: "propio".into(),
            })
            .await
            .unwrap();
        assert_eq!(
            plan.decision,
            PlanDecision::ConfirmTyped {
                expected: "propio".into()
            }
        );
        assert!(matches!(
            svc.execute(plan.ticket.as_deref().unwrap(), Some("otro"))
                .await,
            Err(ActionError::TypedMismatch)
        ));
        let plan = svc
            .plan(ActionRequest::StackDelete {
                name: "propio".into(),
            })
            .await
            .unwrap();
        // Entre plan y ejecución aparecen contenedores: no se borra.
        add_container(&engine, "c9", "propio", ContainerState::Exited);
        let out = svc
            .execute(plan.ticket.as_deref().unwrap(), Some("propio"))
            .await
            .unwrap();
        assert_eq!(out.failed[0].error.code, ApiErrorCode::StateChanged);
        assert!(stacks.calls().is_empty());
        engine.state().containers.retain(|c| c.summary.id != "c9");
        let plan = svc
            .plan(ActionRequest::StackDelete {
                name: "propio".into(),
            })
            .await
            .unwrap();
        let out = svc
            .execute(plan.ticket.as_deref().unwrap(), Some("propio"))
            .await
            .unwrap();
        assert_eq!(out.succeeded.len(), 1);
        assert_eq!(stacks.calls(), vec!["delete_files:propio"]);
    }

    #[tokio::test]
    async fn sin_control_de_stacks_no_esta_disponible() {
        let engine = Arc::new(MockEngine::new());
        let svc = ActionService::new(engine);
        let e = svc
            .plan(ActionRequest::StackDown {
                project: "x".into(),
            })
            .await
            .unwrap_err();
        assert!(matches!(e, ActionError::NotImplemented(_)));
    }
}
