//! Motor simulado en memoria para tests (política, tickets, acciones, comandos).

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use async_trait::async_trait;

use crate::client::{EngineClient, EngineStream};
use crate::*;

#[derive(Default)]
pub struct MockState {
    pub containers: Vec<ContainerDetail>,
    pub images: Vec<Image>,
    pub volumes: Vec<Volume>,
    pub networks: Vec<Network>,
    /// Registro de llamadas, ej. `remove_container:<id>:force=true`.
    pub calls: Vec<String>,
    /// Errores a inyectar: clave = nombre de la operación (`remove_volume`, ...).
    pub fail: HashMap<String, EngineError>,
    /// Retardo artificial de `stats_snapshot` (tests con tiempo pausado).
    pub stats_delay: Option<std::time::Duration>,
}

#[derive(Default)]
pub struct MockEngine {
    state: Mutex<MockState>,
}

impl MockEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> MutexGuard<'_, MockState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn calls(&self) -> Vec<String> {
        self.state().calls.clone()
    }

    /// Detalle de contenedor mínimo para tests.
    pub fn container(
        id: &str,
        name: &str,
        state: ContainerState,
        created_at: &str,
    ) -> ContainerDetail {
        ContainerDetail {
            summary: Container {
                id: id.into(),
                names: vec![name.into()],
                image: "img".into(),
                image_id: "sha256:img".into(),
                state,
                status: String::new(),
                created: 0,
                compose_project: None,
                compose_service: None,
                ports: vec![],
                mounts: vec![],
                networks: vec![],
            },
            created_at: created_at.into(),
            ip_address: None,
            started_at: None,
            finished_at: None,
            exit_code: None,
            pid: None,
            oom_killed: false,
            restart_count: 0,
            error: None,
            tty: false,
            restart_policy: None,
            memory_limit_bytes: None,
            cpu_limit: None,
            networks: vec![],
            raw: serde_json::Value::Null,
        }
    }

    pub fn volume(name: &str, created_at: &str, used_by: &[&str]) -> Volume {
        Volume {
            name: name.into(),
            driver: "local".into(),
            mountpoint: String::new(),
            created_at: Some(created_at.into()),
            labels: HashMap::new(),
            compose_project: None,
            size_bytes: Some(10),
            used_by: used_by.iter().map(|s| s.to_string()).collect(),
            anonymous: false,
        }
    }

    pub fn image(id: &str, reference: &str, containers: u32) -> Image {
        Image {
            id: id.into(),
            reference: reference.into(),
            repository: reference.into(),
            tag: "latest".into(),
            size_bytes: 100,
            created: 0,
            containers,
            dangling: false,
        }
    }

    pub fn network(id: &str, name: &str, connected: &[&str], system: bool) -> Network {
        Network {
            id: id.into(),
            name: name.into(),
            driver: "bridge".into(),
            scope: "local".into(),
            subnets: vec![],
            internal: false,
            system,
            connected: connected.iter().map(|s| s.to_string()).collect(),
            compose_project: None,
        }
    }

    fn record(&self, call: String, op: &str) -> Result<(), EngineError> {
        let mut s = self.state();
        s.calls.push(call);
        match s.fail.get(op) {
            Some(e) => Err(e.clone()),
            None => Ok(()),
        }
    }
}

fn zero_stats() -> ContainerStats {
    ContainerStats {
        read_at: String::new(),
        cpu_percent: 0.0,
        mem_used_bytes: 0,
        mem_limit_bytes: 0,
        mem_percent: 0.0,
        net_rx_bytes: 0,
        net_tx_bytes: 0,
        net_rx_bytes_per_sec: 0.0,
        net_tx_bytes_per_sec: 0.0,
        block_read_bytes: 0,
        block_write_bytes: 0,
        pids: 0,
    }
}

#[async_trait]
impl EngineClient for MockEngine {
    async fn ping(&self) -> Result<(), EngineError> {
        self.record("ping".into(), "ping")
    }

    async fn info(&self) -> Result<EngineInfo, EngineError> {
        Ok(EngineInfo {
            version: "mock".into(),
            api_version: "1.0".into(),
            os: "linux".into(),
            arch: "x86_64".into(),
        })
    }

    async fn diagnose(&self) -> ConnectionStatus {
        ConnectionStatus::Connected {
            endpoint: "mock".into(),
            server: EngineInfo {
                version: "mock".into(),
                api_version: "1.0".into(),
                os: "linux".into(),
                arch: "x86_64".into(),
            },
        }
    }

    async fn reconnect(&self) -> ConnectionStatus {
        self.diagnose().await
    }

    async fn list_containers(&self, all: bool) -> Result<Vec<Container>, EngineError> {
        self.record("list_containers".into(), "list_containers")?;
        Ok(self
            .state()
            .containers
            .iter()
            .map(|d| d.summary.clone())
            .filter(|c| all || c.state == ContainerState::Running)
            .collect())
    }

    async fn inspect_container(&self, id: &str) -> Result<ContainerDetail, EngineError> {
        self.record(format!("inspect_container:{id}"), "inspect_container")?;
        self.state()
            .containers
            .iter()
            .find(|d| d.summary.id == id || d.summary.names.iter().any(|n| n == id))
            .cloned()
            .ok_or_else(|| EngineError::NotFound(id.into()))
    }

    async fn start_container(&self, id: &str) -> Result<(), EngineError> {
        self.record(format!("start_container:{id}"), "start_container")
    }

    async fn stop_container(&self, id: &str) -> Result<(), EngineError> {
        self.record(format!("stop_container:{id}"), "stop_container")
    }

    async fn restart_container(&self, id: &str) -> Result<(), EngineError> {
        self.record(format!("restart_container:{id}"), "restart_container")
    }

    async fn remove_container(&self, id: &str, force: bool) -> Result<(), EngineError> {
        self.record(
            format!("remove_container:{id}:force={force}"),
            "remove_container",
        )?;
        let mut s = self.state();
        let pos = s.containers.iter().position(|d| d.summary.id == id);
        let Some(pos) = pos else {
            return Err(EngineError::NotFound(id.into()));
        };
        if s.containers[pos].summary.state.is_live() && !force {
            return Err(EngineError::Conflict("contenedor en ejecución".into()));
        }
        s.containers.remove(pos);
        Ok(())
    }

    async fn stats_snapshot(&self, id: &str) -> Result<ContainerStats, EngineError> {
        let delay = self.state().stats_delay;
        if let Some(d) = delay {
            tokio::time::sleep(d).await;
        }
        self.record(format!("stats_snapshot:{id}"), "stats_snapshot")?;
        Ok(zero_stats())
    }

    async fn system_usage(&self) -> Result<SystemUsage, EngineError> {
        self.record("system_usage".into(), "system_usage")?;
        Ok(SystemUsage {
            host: HostResources {
                cpu_count: 8,
                mem_total_bytes: 16 * 1024 * 1024 * 1024,
            },
            disk: DiskUsage::default(),
            container_disk: Vec::new(),
            disk_known: false,
        })
    }

    async fn list_images(&self) -> Result<Vec<Image>, EngineError> {
        self.record("list_images".into(), "list_images")?;
        // Igual que el adaptador real: el uso se calcula con list_containers y su fallo se propaga.
        self.record("list_containers".into(), "list_containers")?;
        Ok(self.state().images.clone())
    }

    async fn remove_image(&self, reference: &str) -> Result<(), EngineError> {
        self.record(format!("remove_image:{reference}"), "remove_image")?;
        let mut s = self.state();
        s.images.retain(|i| i.reference != reference);
        Ok(())
    }

    async fn list_volumes(&self) -> Result<Vec<Volume>, EngineError> {
        self.record("list_volumes".into(), "list_volumes")?;
        // Igual que el adaptador real: el uso se calcula con list_containers y su fallo se propaga.
        self.record("list_containers".into(), "list_containers")?;
        Ok(self.state().volumes.clone())
    }

    async fn inspect_volume(&self, name: &str) -> Result<Volume, EngineError> {
        self.record(format!("inspect_volume:{name}"), "inspect_volume")?;
        self.state()
            .volumes
            .iter()
            .find(|v| v.name == name)
            .cloned()
            .ok_or_else(|| EngineError::NotFound(name.into()))
    }

    async fn remove_volume(&self, name: &str) -> Result<(), EngineError> {
        self.record(format!("remove_volume:{name}"), "remove_volume")?;
        self.state().volumes.retain(|v| v.name != name);
        Ok(())
    }

    async fn list_networks(&self) -> Result<Vec<Network>, EngineError> {
        self.record("list_networks".into(), "list_networks")?;
        // Igual que el adaptador real: el uso se calcula con list_containers y su fallo se propaga.
        self.record("list_containers".into(), "list_containers")?;
        Ok(self.state().networks.clone())
    }

    async fn remove_network(&self, id: &str) -> Result<(), EngineError> {
        self.record(format!("remove_network:{id}"), "remove_network")?;
        self.state().networks.retain(|n| n.id != id);
        Ok(())
    }

    fn events(&self) -> EngineStream<EngineEvent> {
        Box::pin(futures_util::stream::empty())
    }

    fn logs(&self, _id: &str, _req: LogsRequest) -> EngineStream<LogLine> {
        Box::pin(futures_util::stream::empty())
    }

    fn stats(&self, _id: &str) -> EngineStream<ContainerStats> {
        Box::pin(futures_util::stream::empty())
    }
}

#[cfg(test)]
mod actions_tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use crate::broker::tests::FakeClock;

    fn svc(engine: &Arc<MockEngine>) -> (ActionService, Arc<FakeClock>) {
        let clock = Arc::new(FakeClock::default());
        (
            ActionService::with_clock(engine.clone(), clock.clone()),
            clock,
        )
    }

    fn engine_con_contenedores() -> Arc<MockEngine> {
        let e = Arc::new(MockEngine::new());
        {
            let mut s = e.state();
            s.containers.push(MockEngine::container(
                "aaa",
                "web",
                ContainerState::Exited,
                "2026-01-01T00:00:00Z",
            ));
            s.containers.push(MockEngine::container(
                "bbb",
                "db",
                ContainerState::Running,
                "2026-01-02T00:00:00Z",
            ));
        }
        e
    }

    fn removes(e: &MockEngine) -> Vec<String> {
        e.calls()
            .into_iter()
            .filter(|c| c.starts_with("remove_"))
            .collect()
    }

    #[tokio::test]
    async fn plan_de_contenedores_fija_force_por_estado_real() {
        let e = engine_con_contenedores();
        let (s, _) = svc(&e);
        let plan = s
            .plan(ActionRequest::RemoveContainers {
                ids: vec!["web".into(), "bbb".into(), "aaa".into()],
            })
            .await
            .expect("plan");
        assert_eq!(plan.decision, PlanDecision::Confirm);
        assert!(plan.ticket.is_some());
        // "web" y "aaa" son el mismo contenedor: cuenta una vez.
        assert_eq!(plan.affected.len(), 2);
        // El estado real viaja en el plan (la UI lo pinta).
        assert_eq!(plan.affected[0].state, Some(ContainerState::Exited));
        assert_eq!(plan.affected[1].state, Some(ContainerState::Running));
        assert!(
            plan.warnings
                .contains(&PlanWarning::RunningForce { count: 1 })
        );
        let out = s
            .execute(plan.ticket.as_deref().expect("ticket"), None)
            .await
            .expect("exec");
        assert_eq!(out.succeeded.len(), 2);
        assert_eq!(
            removes(&e),
            vec![
                "remove_container:aaa:force=false",
                "remove_container:bbb:force=true"
            ]
        );
    }

    #[tokio::test]
    async fn ticket_de_un_solo_uso_y_expira() {
        let e = engine_con_contenedores();
        let (s, clock) = svc(&e);
        let req = ActionRequest::RemoveContainers {
            ids: vec!["aaa".into()],
        };
        let t = s.plan(req.clone()).await.expect("plan").ticket.expect("t");
        s.execute(&t, None).await.expect("primera");
        assert_eq!(s.execute(&t, None).await, Err(ActionError::TicketInvalid));
        let e2 = engine_con_contenedores();
        let (s2, clock2) = svc(&e2);
        let t2 = s2.plan(req).await.expect("plan").ticket.expect("t");
        clock2.advance(Duration::from_secs(121));
        assert_eq!(s2.execute(&t2, None).await, Err(ActionError::TicketExpired));
        assert!(removes(&e2).is_empty());
        let _ = clock;
    }

    #[tokio::test]
    async fn execute_sin_ticket_valido_falla_sin_tocar_nada() {
        let e = engine_con_contenedores();
        let (s, _) = svc(&e);
        assert_eq!(
            s.execute("no-existe", None).await,
            Err(ActionError::TicketInvalid)
        );
        assert!(removes(&e).is_empty());
    }

    #[tokio::test]
    async fn toctou_contenedor_recreado_con_otro_created_at_se_rechaza() {
        let e = engine_con_contenedores();
        let (s, _) = svc(&e);
        let t = s
            .plan(ActionRequest::RemoveContainers {
                ids: vec!["aaa".into()],
            })
            .await
            .expect("plan")
            .ticket
            .expect("t");
        e.state().containers[0].created_at = "2026-06-06T00:00:00Z".into();
        let out = s.execute(&t, None).await.expect("exec");
        assert!(out.succeeded.is_empty());
        assert_eq!(out.failed[0].error.code, ApiErrorCode::StateChanged);
        assert!(removes(&e).is_empty());
    }

    #[tokio::test]
    async fn contenedor_que_arranca_tras_el_plan_no_escala_a_force() {
        let e = engine_con_contenedores();
        let (s, _) = svc(&e);
        let t = s
            .plan(ActionRequest::RemoveContainers {
                ids: vec!["aaa".into()],
            })
            .await
            .expect("plan")
            .ticket
            .expect("t");
        e.state().containers[0].summary.state = ContainerState::Running;
        let out = s.execute(&t, None).await.expect("exec");
        assert_eq!(out.failed[0].error.code, ApiErrorCode::StateChanged);
        assert!(removes(&e).is_empty(), "{:?}", e.calls());
    }

    #[tokio::test]
    async fn volumen_recreado_con_otro_created_at_se_rechaza() {
        let e = Arc::new(MockEngine::new());
        e.state()
            .volumes
            .push(MockEngine::volume("datos", "t1", &[]));
        let (s, _) = svc(&e);
        let plan = s
            .plan(ActionRequest::RemoveVolume {
                name: "datos".into(),
            })
            .await
            .expect("plan");
        assert_eq!(
            plan.decision,
            PlanDecision::ConfirmTyped {
                expected: "datos".into()
            }
        );
        let t = plan.ticket.expect("t");
        e.state().volumes[0].created_at = Some("t2".into());
        // Sin texto correcto no se consume; con texto correcto, la huella falla.
        assert_eq!(
            s.execute(&t, Some("otro")).await,
            Err(ActionError::TypedMismatch)
        );
        let out = s.execute(&t, Some("datos")).await.expect("exec");
        assert_eq!(out.failed[0].error.code, ApiErrorCode::StateChanged);
        assert!(removes(&e).is_empty());
    }

    #[tokio::test]
    async fn prune_de_volumenes_es_n_borrados_unitarios_con_eliminar() {
        let e = Arc::new(MockEngine::new());
        {
            let mut st = e.state();
            st.volumes.push(MockEngine::volume("a", "t", &[]));
            st.volumes.push(MockEngine::volume("b", "t", &[]));
            st.volumes.push(MockEngine::volume("uso", "t", &["web"]));
        }
        let (s, _) = svc(&e);
        let plan = s.plan(ActionRequest::PruneVolumes).await.expect("plan");
        assert_eq!(
            plan.decision,
            PlanDecision::ConfirmTyped {
                expected: "ELIMINAR".into()
            }
        );
        assert_eq!(plan.affected.len(), 2);
        assert_eq!(plan.total_size_bytes, Some(20));
        let t = plan.ticket.expect("t");
        assert_eq!(
            s.execute(&t, Some("eliminar")).await,
            Err(ActionError::TypedMismatch)
        );
        let out = s.execute(&t, Some("ELIMINAR")).await.expect("exec");
        assert_eq!(out.succeeded.len(), 2);
        assert_eq!(out.freed_bytes, Some(20));
        assert_eq!(removes(&e), vec!["remove_volume:a", "remove_volume:b"]);
        // Nunca existe una llamada de prune en el trait: solo borrados unitarios.
    }

    #[tokio::test]
    async fn prune_continua_ante_fallos() {
        let e = Arc::new(MockEngine::new());
        {
            let mut st = e.state();
            st.images.push(MockEngine::image("sha256:1", "a:1", 0));
            st.images.push(MockEngine::image("sha256:2", "b:1", 0));
            st.images.push(MockEngine::image("sha256:3", "c:1", 2));
            st.fail
                .insert("remove_image".into(), EngineError::Conflict("x".into()));
        }
        let (s, _) = svc(&e);
        let plan = s.plan(ActionRequest::PruneImages).await.expect("plan");
        assert_eq!(plan.decision, PlanDecision::Confirm);
        assert_eq!(plan.affected.len(), 2);
        let out = s
            .execute(plan.ticket.as_deref().expect("t"), None)
            .await
            .expect("exec");
        assert_eq!(out.failed.len(), 2);
        assert_eq!(out.failed[0].error.code, ApiErrorCode::Conflict);
    }

    #[tokio::test]
    async fn si_falla_list_containers_el_plan_aborta_y_no_incluye_todo() {
        let e = Arc::new(MockEngine::new());
        {
            let mut st = e.state();
            st.volumes.push(MockEngine::volume("en-uso", "t", &["web"]));
            st.images.push(MockEngine::image("sha256:1", "a:1", 1));
            st.networks
                .push(MockEngine::network("n", "app", &["web"], false));
            st.fail.insert(
                "list_containers".into(),
                EngineError::Connection {
                    cause: ConnectionCause::DaemonDown,
                    message: "caído".into(),
                },
            );
        }
        let (s, _) = svc(&e);
        for req in [
            ActionRequest::PruneVolumes,
            ActionRequest::PruneImages,
            ActionRequest::RemoveVolume {
                name: "en-uso".into(),
            },
            ActionRequest::RemoveNetwork { id: "n".into() },
        ] {
            let err = s.plan(req).await.expect_err("debe abortar");
            let api: ApiError = err.into();
            assert_eq!(api.code, ApiErrorCode::Connection);
        }
        assert_eq!(s.pending_tickets(), 0, "no debe emitirse ningún ticket");
    }

    #[tokio::test]
    async fn volumen_sin_created_at_recreado_se_detecta_por_huella_compuesta() {
        let e = Arc::new(MockEngine::new());
        {
            let mut v = MockEngine::volume("datos", "", &[]);
            v.created_at = None;
            v.mountpoint = "/var/lib/docker/volumes/datos/_data".into();
            e.state().volumes.push(v);
        }
        let (s, _) = svc(&e);
        let t = s
            .plan(ActionRequest::RemoveVolume {
                name: "datos".into(),
            })
            .await
            .expect("plan")
            .ticket
            .expect("t");
        // Recreado con otro mountpoint y labels, también sin created_at.
        {
            let mut st = e.state();
            st.volumes[0].mountpoint = "/otro/_data".into();
            st.volumes[0].labels.insert("nuevo".into(), "1".into());
        }
        let out = s.execute(&t, Some("datos")).await.expect("exec");
        assert_eq!(out.failed[0].error.code, ApiErrorCode::StateChanged);
        assert!(removes(&e).is_empty());
        // Sin cambios: se borra.
        let (e2, s2) = {
            let e2 = Arc::new(MockEngine::new());
            let mut v = MockEngine::volume("datos", "", &[]);
            v.created_at = None;
            e2.state().volumes.push(v);
            let (s2, _) = svc(&e2);
            (e2, s2)
        };
        let t2 = s2
            .plan(ActionRequest::RemoveVolume {
                name: "datos".into(),
            })
            .await
            .expect("plan")
            .ticket
            .expect("t");
        assert_eq!(
            s2.execute(&t2, Some("datos"))
                .await
                .expect("exec")
                .succeeded
                .len(),
            1
        );
        assert_eq!(removes(&e2), vec!["remove_volume:datos"]);
    }

    #[tokio::test]
    async fn plan_rechazado_con_conflict_si_hay_32_pendientes() {
        let e = engine_con_contenedores();
        let (s, _) = svc(&e);
        let req = ActionRequest::RemoveContainers {
            ids: vec!["aaa".into()],
        };
        let first = s.plan(req.clone()).await.expect("plan").ticket.expect("t");
        for _ in 1..crate::broker::MAX_PENDING {
            s.plan(req.clone()).await.expect("plan");
        }
        let err = s.plan(req).await.expect_err("lleno");
        assert_eq!(err, ActionError::TooManyPending);
        assert_eq!(ApiError::from(err).code, ApiErrorCode::Conflict);
        // El ticket legítimo del principio sigue siendo canjeable.
        assert!(s.execute(&first, None).await.is_ok());
    }

    #[tokio::test]
    async fn prune_system_deny_y_stack_down_no_implementado() {
        let e = Arc::new(MockEngine::new());
        let (s, _) = svc(&e);
        let p = s.plan(ActionRequest::PruneSystem).await.expect("plan");
        assert_eq!(
            p.decision,
            PlanDecision::Deny {
                reason: PlanDenyReason::Forbidden
            }
        );
        assert!(p.ticket.is_none());
        assert!(matches!(
            s.plan(ActionRequest::StackDown {
                project: "x".into()
            })
            .await,
            Err(ActionError::NotImplemented(_))
        ));
    }

    #[tokio::test]
    async fn plan_vacio_no_emite_ticket_y_redes_bloqueadas() {
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
        let (s, _) = svc(&e);
        let p = s.plan(ActionRequest::PruneImages).await.expect("plan");
        assert_eq!(p.decision, PlanDecision::Allow);
        assert!(p.ticket.is_none());
        for id in ["n1", "n2"] {
            assert!(matches!(
                s.plan(ActionRequest::RemoveNetwork { id: id.into() }).await,
                Err(ActionError::Engine(EngineError::Conflict(_)))
            ));
        }
        let t = s
            .plan(ActionRequest::RemoveNetwork { id: "n3".into() })
            .await
            .expect("plan")
            .ticket
            .expect("t");
        let out = s.execute(&t, None).await.expect("exec");
        assert_eq!(out.succeeded.len(), 1);
    }

    #[tokio::test]
    async fn ids_invalidos_se_rechazan_en_el_plan() {
        let e = Arc::new(MockEngine::new());
        let (s, _) = svc(&e);
        assert!(matches!(
            s.plan(ActionRequest::RemoveContainers {
                ids: vec!["a/../b".into()]
            })
            .await,
            Err(ActionError::Engine(EngineError::InvalidInput(_)))
        ));
        let many: Vec<String> = (0..501).map(|i| format!("c{i}")).collect();
        assert!(matches!(
            s.plan(ActionRequest::RemoveContainers { ids: many }).await,
            Err(ActionError::Engine(EngineError::InvalidInput(_)))
        ));
    }

    #[test]
    fn contrato_serde_del_plan() {
        let d = PlanDecision::ConfirmTyped {
            expected: "x".into(),
        };
        assert_eq!(
            serde_json::to_string(&d).expect("json"),
            r#"{"type":"confirm_typed","expected":"x"}"#
        );
        let d = PlanDecision::Deny {
            reason: PlanDenyReason::Forbidden,
        };
        assert_eq!(
            serde_json::to_string(&d).expect("json"),
            r#"{"type":"deny","reason":"forbidden"}"#
        );
        let r: ActionRequest =
            serde_json::from_str(r#"{"type":"remove_containers","ids":["a"]}"#).expect("req");
        assert_eq!(
            r,
            ActionRequest::RemoveContainers {
                ids: vec!["a".into()]
            }
        );
    }
}
