//! Limpieza guiada: informe de SOLO LECTURA de lo que se puede recuperar y la selección que el
//! usuario marca. Aquí no se borra nada: la ejecución pasa por `ActionService`
//! (`ActionRequest::Cleanup`), elemento a elemento, con ticket y re-verificación. Nunca se usa
//! un `prune` del motor.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::actions::{ItemKind, MAX_ITEMS};
use crate::client::EngineClient;
use crate::error::EngineError;

/// Segundos por día (antigüedad mínima de imágenes sin usar).
const DAY_SECS: i64 = 86_400;

/// Selección explícita de la persona: solo identificadores, el backend resuelve el resto.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupSelection {
    /// Ids de contenedores detenidos.
    #[serde(default)]
    pub containers: Vec<String>,
    /// Referencias (`repo:tag`) o ids de imágenes sin usar.
    #[serde(default)]
    pub images: Vec<String>,
    /// Nombres de volúmenes sin usar.
    #[serde(default)]
    pub volumes: Vec<String>,
    /// Ids de redes sin contenedores.
    #[serde(default)]
    pub networks: Vec<String>,
}

impl CleanupSelection {
    pub fn len(&self) -> usize {
        self.containers.len() + self.images.len() + self.volumes.len() + self.networks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupCategoryId {
    StoppedContainers,
    DanglingImages,
    UnusedImages,
    UnusedVolumes,
    UnusedNetworks,
    BuildCache,
}

/// Qué tan fiable es el tamaño mostrado.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SizeEstimate {
    Exact,
    /// Las capas compartidas con otras imágenes no se liberan: lo real puede ser menor.
    UpperBound,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupRisk {
    Low,
    Medium,
    /// Puede haber datos que no se recuperan (volúmenes).
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupItem {
    pub kind: ItemKind,
    /// Lo que se pasa a `CleanupSelection` (id, referencia o nombre según el tipo).
    pub id: String,
    pub name: String,
    pub size_bytes: Option<u64>,
    pub estimate: SizeEstimate,
    pub reason: String,
    pub risk: CleanupRisk,
    pub selected_by_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupCategory {
    pub id: CleanupCategoryId,
    pub items: Vec<CleanupItem>,
    /// Suma de los tamaños conocidos (una imagen con varias etiquetas cuenta una vez).
    pub reclaimable_bytes: Option<u64>,
    /// `false` = solo informativo (la caché de build no se borra por elemento).
    pub executable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupReport {
    pub categories: Vec<CleanupCategory>,
    /// Suma de las categorías ejecutables; `None` si no hay ningún tamaño conocido.
    pub total_reclaimable_bytes: Option<u64>,
    /// Elementos cuyo tamaño no se conoce (no entran en el total).
    pub unknown_count: u32,
    /// `true` = había más de `MAX_ITEMS` elementos recomendados y solo los primeros vienen
    /// marcados por defecto (el plan admite como mucho `MAX_ITEMS` por ticket).
    #[serde(default)]
    pub defaults_truncated: bool,
    /// RFC 3339 en UTC (`2026-09-26T12:00:00Z`).
    pub generated_at: String,
}

/// Unix (segundos) a RFC 3339 UTC, sin dependencias (algoritmo civil de Howard Hinnant).
pub fn rfc3339_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Informe de limpieza con la hora del sistema. Solo llama a `list_*` y `system_usage`.
pub async fn cleanup_report(
    engine: &dyn EngineClient,
    min_age_days: u32,
) -> Result<CleanupReport, EngineError> {
    cleanup_report_at(engine, min_age_days, now_unix()).await
}

/// Igual con la hora inyectada (tests deterministas).
pub async fn cleanup_report_at(
    engine: &dyn EngineClient,
    min_age_days: u32,
    now: i64,
) -> Result<CleanupReport, EngineError> {
    let containers = engine.list_containers(true).await?;
    let images = engine.list_images().await?;
    let volumes = engine.list_volumes().await?;
    let networks = engine.list_networks().await?;
    // El uso de disco es opcional: si falla o expira, los tamaños quedan como desconocidos.
    let usage = engine.system_usage().await.ok();
    let rw_sizes: HashMap<&str, u64> = usage
        .as_ref()
        .map(|u| {
            u.container_disk
                .iter()
                .map(|c| (c.id.as_str(), c.size_rw_bytes))
                .collect()
        })
        .unwrap_or_default();

    // --- contenedores detenidos
    let stopped: Vec<(CleanupItem, String)> = containers
        .iter()
        .filter(|c| !c.state.is_live() && c.state != crate::ContainerState::Removing)
        .map(|c| {
            let size = rw_sizes.get(c.id.as_str()).copied();
            let item = CleanupItem {
                kind: ItemKind::Container,
                id: c.id.clone(),
                name: c.names.first().cloned().unwrap_or_else(|| c.id.clone()),
                size_bytes: size,
                estimate: if size.is_some() {
                    SizeEstimate::Exact
                } else {
                    SizeEstimate::Unknown
                },
                reason: match &c.compose_project {
                    Some(p) => format!("detenido (stack {p})"),
                    None => "detenido".into(),
                },
                risk: CleanupRisk::Medium,
                selected_by_default: true,
            };
            let key = item.id.clone();
            (item, key)
        })
        .collect();

    // --- imágenes sin contenedores: colgadas vs. etiquetadas y antiguas
    let min_age = i64::from(min_age_days) * DAY_SECS;
    // La clave de deduplicación es el id: varias etiquetas de la misma imagen ocupan una vez.
    let image_item = |i: &crate::Image, reason: String, risk, sel| {
        let item = CleanupItem {
            kind: ItemKind::Image,
            id: i.reference.clone(),
            name: i.reference.clone(),
            size_bytes: Some(i.size_bytes),
            // El tamaño de una imagen incluye capas que pueden compartir otras.
            estimate: SizeEstimate::UpperBound,
            reason,
            risk,
            selected_by_default: sel,
        };
        (item, i.id.clone())
    };
    let dangling: Vec<(CleanupItem, String)> = images
        .iter()
        .filter(|i| i.containers == 0 && i.dangling)
        .map(|i| {
            image_item(
                i,
                "sin etiqueta y sin contenedores".into(),
                CleanupRisk::Low,
                true,
            )
        })
        .collect();
    let unused: Vec<(CleanupItem, String)> = images
        .iter()
        .filter(|i| i.containers == 0 && !i.dangling && now - i.created >= min_age)
        .map(|i| {
            let reason = if min_age_days == 0 {
                "sin contenedores".to_string()
            } else {
                format!("sin contenedores y con más de {min_age_days} días")
            };
            image_item(i, reason, CleanupRisk::Medium, false)
        })
        .collect();

    // --- volúmenes sin uso: datos, nunca marcados por defecto
    let vols: Vec<(CleanupItem, String)> = volumes
        .iter()
        .filter(|v| v.used_by.is_empty())
        .map(|v| {
            let item = CleanupItem {
                kind: ItemKind::Volume,
                id: v.name.clone(),
                name: v.name.clone(),
                size_bytes: v.size_bytes,
                estimate: if v.size_bytes.is_some() {
                    SizeEstimate::Exact
                } else {
                    SizeEstimate::Unknown
                },
                reason: "sin contenedores; puede contener datos que no se recuperan".into(),
                risk: CleanupRisk::High,
                selected_by_default: false,
            };
            let key = item.id.clone();
            (item, key)
        })
        .collect();

    // --- redes sin contenedores (las del sistema nunca)
    let nets: Vec<(CleanupItem, String)> = networks
        .iter()
        .filter(|n| !n.system && n.connected.is_empty())
        .map(|n| {
            let item = CleanupItem {
                kind: ItemKind::Network,
                id: n.id.clone(),
                name: n.name.clone(),
                // Una red no ocupa disco: su tamaño es exactamente cero, no desconocido.
                size_bytes: Some(0),
                estimate: SizeEstimate::Exact,
                reason: "sin contenedores conectados".into(),
                risk: CleanupRisk::Low,
                selected_by_default: true,
            };
            let key = item.id.clone();
            (item, key)
        })
        .collect();
    let build_cache_bytes = usage
        .as_ref()
        .filter(|u| u.disk_known)
        .and_then(|u| u.disk.build_cache.reclaimable_bytes);

    let mut categories = vec![
        category(CleanupCategoryId::StoppedContainers, stopped),
        category(CleanupCategoryId::DanglingImages, dangling),
        category(CleanupCategoryId::UnusedImages, unused),
        category(CleanupCategoryId::UnusedVolumes, vols),
        category(CleanupCategoryId::UnusedNetworks, nets),
    ];
    // Caché de build: la API no permite borrarla por elemento sin un prune ciego.
    categories.push(CleanupCategory {
        id: CleanupCategoryId::BuildCache,
        items: vec![],
        reclaimable_bytes: build_cache_bytes,
        executable: false,
    });

    // El plan admite `MAX_ITEMS` elementos por ticket: no se marcan por defecto más de los que caben.
    let mut marked = 0usize;
    let mut defaults_truncated = false;
    for item in categories.iter_mut().flat_map(|c| c.items.iter_mut()) {
        if !item.selected_by_default {
            continue;
        }
        if marked >= MAX_ITEMS {
            item.selected_by_default = false;
            defaults_truncated = true;
        } else {
            marked += 1;
        }
    }

    let mut total: Option<u64> = None;
    let mut unknown_count = 0u32;
    for c in categories.iter().filter(|c| c.executable) {
        if let Some(b) = c.reclaimable_bytes {
            total = Some(total.unwrap_or(0) + b);
        }
        unknown_count += c.items.iter().filter(|i| i.size_bytes.is_none()).count() as u32;
    }
    Ok(CleanupReport {
        categories,
        total_reclaimable_bytes: total,
        unknown_count,
        defaults_truncated,
        generated_at: rfc3339_utc(now),
    })
}

/// Suma los tamaños conocidos sin contar dos veces la misma clave (mismo id de imagen).
fn category(id: CleanupCategoryId, rows: Vec<(CleanupItem, String)>) -> CleanupCategory {
    let mut seen: HashSet<String> = HashSet::new();
    let mut sum: Option<u64> = None;
    for (item, key) in &rows {
        if let (Some(s), true) = (item.size_bytes, seen.insert(key.clone())) {
            sum = Some(sum.unwrap_or(0) + s);
        }
    }
    CleanupCategory {
        id,
        items: rows.into_iter().map(|(i, _)| i).collect(),
        reclaimable_bytes: sum,
        executable: true,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::actions::{ActionRequest, ActionService, MAX_ITEMS, PlanDecision};
    use crate::broker::tests::FakeClock;
    use crate::policy::Interactivity;
    use crate::system::{ContainerDisk, DiskCategory, DiskUsage, HostResources, SystemUsage};
    use crate::testing::MockEngine;
    use crate::{ActionError, ContainerState};

    const NOW: i64 = 1_800_000_000;

    fn engine() -> Arc<MockEngine> {
        let e = Arc::new(MockEngine::new());
        {
            let mut s = e.state();
            s.containers.push(MockEngine::container(
                "c1",
                "parado",
                ContainerState::Exited,
                "t1",
            ));
            s.containers.push(MockEngine::container(
                "c2",
                "vivo",
                ContainerState::Running,
                "t2",
            ));
            let mut dangling = MockEngine::image("sha256:dd", "sha256:dd", 0);
            dangling.dangling = true;
            dangling.size_bytes = 50;
            s.images.push(dangling);
            let mut old = MockEngine::image("sha256:oo", "viejo:1", 0);
            old.created = NOW - 40 * DAY_SECS;
            old.size_bytes = 300;
            s.images.push(old);
            // Dos etiquetas de la misma imagen: cuenta una sola vez.
            let mut a = MockEngine::image("sha256:oo", "viejo:2", 0);
            a.created = NOW - 40 * DAY_SECS;
            a.size_bytes = 300;
            s.images.push(a);
            let mut fresh = MockEngine::image("sha256:ff", "nuevo:1", 0);
            fresh.created = NOW - DAY_SECS;
            s.images.push(fresh);
            // Imagen usada: nunca aparece.
            s.images.push(MockEngine::image("sha256:uu", "uso:1", 1));
            s.volumes.push(MockEngine::volume("libre", "t", &[]));
            s.volumes.push(MockEngine::volume("ocupado", "t", &["c2"]));
            s.networks
                .push(MockEngine::network("n1", "sobra", &[], false));
            s.networks
                .push(MockEngine::network("n2", "ocupada", &["c2"], false));
            s.networks
                .push(MockEngine::network("n3", "bridge", &[], true));
            s.usage = Some(SystemUsage {
                host: HostResources {
                    cpu_count: 1,
                    mem_total_bytes: 1,
                },
                disk: DiskUsage {
                    build_cache: DiskCategory {
                        total_bytes: Some(900),
                        reclaimable_bytes: Some(700),
                    },
                    ..DiskUsage::default()
                },
                container_disk: vec![ContainerDisk {
                    id: "c1".into(),
                    size_rw_bytes: 12,
                }],
                disk_known: true,
            });
        }
        e
    }

    fn cat(r: &CleanupReport, id: CleanupCategoryId) -> &CleanupCategory {
        r.categories.iter().find(|c| c.id == id).expect("categoría")
    }

    #[tokio::test]
    async fn informe_categorias_y_exclusiones() {
        let e = engine();
        let r = cleanup_report_at(&*e, 7, NOW).await.expect("informe");
        let stopped = cat(&r, CleanupCategoryId::StoppedContainers);
        assert_eq!(stopped.items.len(), 1);
        assert_eq!(stopped.items[0].name, "parado");
        assert_eq!(stopped.items[0].estimate, SizeEstimate::Exact);
        assert_eq!(stopped.reclaimable_bytes, Some(12));
        let dang = cat(&r, CleanupCategoryId::DanglingImages);
        assert_eq!(dang.items.len(), 1);
        assert!(dang.items[0].selected_by_default);
        // Solo las de más de 7 días; la usada y la reciente no salen.
        let unused = cat(&r, CleanupCategoryId::UnusedImages);
        let names: Vec<_> = unused.items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["viejo:1", "viejo:2"]);
        assert!(unused.items.iter().all(|i| !i.selected_by_default));
        assert!(
            unused
                .items
                .iter()
                .all(|i| i.estimate == SizeEstimate::UpperBound)
        );
        // Misma imagen con dos etiquetas: 300, no 600.
        assert_eq!(unused.reclaimable_bytes, Some(300));
        let vols = cat(&r, CleanupCategoryId::UnusedVolumes);
        assert_eq!(vols.items.len(), 1);
        assert_eq!(vols.items[0].name, "libre");
        assert_eq!(vols.items[0].risk, CleanupRisk::High);
        assert!(!vols.items[0].selected_by_default);
        let nets = cat(&r, CleanupCategoryId::UnusedNetworks);
        assert_eq!(nets.items.len(), 1);
        assert_eq!(nets.items[0].name, "sobra");
        let bc = cat(&r, CleanupCategoryId::BuildCache);
        assert!(!bc.executable && bc.items.is_empty());
        assert_eq!(bc.reclaimable_bytes, Some(700));
        // Total: 12 + 50 + 300 + 10 (volumen del mock) + 0; la caché de build no cuenta.
        assert_eq!(r.total_reclaimable_bytes, Some(12 + 50 + 300 + 10));
        assert_eq!(r.generated_at, "2027-01-15T08:00:00Z");
        // Ninguna llamada de escritura.
        assert!(
            e.calls()
                .iter()
                .all(|c| c.starts_with("list_") || c.starts_with("system_usage")),
            "{:?}",
            e.calls()
        );
    }

    #[tokio::test]
    async fn los_marcados_por_defecto_nunca_superan_el_tope_del_plan() {
        let e = engine();
        {
            let mut st = e.state();
            for i in 0..(MAX_ITEMS + 50) {
                let mut d =
                    MockEngine::image(&format!("sha256:{i:04}"), &format!("sha256:{i:04}"), 0);
                d.dangling = true;
                st.images.push(d);
            }
        }
        let r = cleanup_report_at(&*e, 7, NOW).await.expect("informe");
        assert!(r.defaults_truncated);
        let marked = r
            .categories
            .iter()
            .flat_map(|c| &c.items)
            .filter(|i| i.selected_by_default)
            .count();
        assert_eq!(marked, MAX_ITEMS);
        // Lo recomendado por defecto cabe en un plan.
        let sel = CleanupSelection {
            images: r
                .categories
                .iter()
                .flat_map(|c| &c.items)
                .filter(|i| i.selected_by_default && i.kind == ItemKind::Image)
                .map(|i| i.id.clone())
                .collect(),
            ..CleanupSelection::default()
        };
        assert!(sel.len() <= MAX_ITEMS);
        let plan = svc(&e)
            .plan(ActionRequest::Cleanup { selection: sel })
            .await;
        assert!(plan.is_ok(), "{plan:?}");
        // Sin exceso no hay truncado.
        let r = cleanup_report_at(&*engine(), 7, NOW)
            .await
            .expect("informe");
        assert!(!r.defaults_truncated);
    }

    #[tokio::test]
    async fn elementos_que_pasan_a_uso_se_omiten_con_aviso_sin_tumbar_el_plan() {
        let e = engine();
        let s = svc(&e);
        // Un contenedor en ejecución, una imagen usada, un volumen ocupado y una red conectada
        // junto a elementos válidos: el plan sale con los válidos y un aviso.
        let plan = s
            .plan(ActionRequest::Cleanup {
                selection: sel(
                    &["c1", "c2", "fantasma"],
                    &["viejo:1", "uso:1"],
                    &["libre", "ocupado"],
                    &["n1", "n2"],
                ),
            })
            .await
            .expect("plan");
        let names: Vec<_> = plan.affected.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["parado", "viejo:1", "libre", "sobra"]);
        assert!(
            plan.warnings.iter().any(|w| matches!(
                w,
                crate::actions::PlanWarning::Skipped { items } if items.len() == 5
            )),
            "{:?}",
            plan.warnings
        );
    }

    #[tokio::test]
    async fn red_por_id_exacto_y_nombre_ambiguo() {
        let e = engine();
        {
            let mut st = e.state();
            // Una red cuyo NOMBRE coincide con el id de otra: gana el id.
            st.networks
                .push(MockEngine::network("nX", "n1", &[], false));
            st.networks
                .push(MockEngine::network("dup1", "repe", &[], false));
            st.networks
                .push(MockEngine::network("dup2", "repe", &[], false));
        }
        let s = svc(&e);
        let p = s
            .plan(ActionRequest::Cleanup {
                selection: sel(&[], &[], &[], &["n1"]),
            })
            .await
            .expect("plan");
        assert_eq!(p.affected[0].id, "n1", "el id exacto gana al nombre");
        let amb = s
            .plan(ActionRequest::Cleanup {
                selection: sel(&[], &[], &[], &["repe"]),
            })
            .await;
        assert!(amb.is_err(), "nombre ambiguo");
        let amb = s
            .plan(ActionRequest::RemoveNetwork { id: "repe".into() })
            .await;
        assert!(amb.is_err());
        // Por id de una de las dos: no hay ambigüedad.
        assert!(
            s.plan(ActionRequest::RemoveNetwork { id: "dup2".into() })
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn sin_antiguedad_minima_entran_todas_las_no_usadas() {
        let e = engine();
        let r = cleanup_report_at(&*e, 0, NOW).await.expect("informe");
        assert_eq!(cat(&r, CleanupCategoryId::UnusedImages).items.len(), 3);
    }

    #[tokio::test]
    async fn sin_uso_de_disco_los_tamanos_son_desconocidos() {
        let e = engine();
        e.state().usage = None;
        e.state().volumes[0].size_bytes = None;
        let r = cleanup_report_at(&*e, 7, NOW).await.expect("informe");
        assert_eq!(
            cat(&r, CleanupCategoryId::BuildCache).reclaimable_bytes,
            None
        );
        let stopped = cat(&r, CleanupCategoryId::StoppedContainers);
        assert_eq!(stopped.items[0].estimate, SizeEstimate::Unknown);
        // Contenedor parado + volumen sin tamaño.
        assert_eq!(r.unknown_count, 2);
    }

    #[test]
    fn fechas_rfc3339() {
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339_utc(-1), "1969-12-31T23:59:59Z");
    }

    fn svc(e: &Arc<MockEngine>) -> ActionService {
        ActionService::with_clock(e.clone(), Arc::new(FakeClock::default()))
    }

    fn removes(e: &MockEngine) -> Vec<String> {
        e.calls()
            .into_iter()
            .filter(|c| c.starts_with("remove_"))
            .collect()
    }

    fn sel(c: &[&str], i: &[&str], v: &[&str], n: &[&str]) -> CleanupSelection {
        let f = |x: &[&str]| x.iter().map(|s| s.to_string()).collect();
        CleanupSelection {
            containers: f(c),
            images: f(i),
            volumes: f(v),
            networks: f(n),
        }
    }

    #[tokio::test]
    async fn plan_y_ejecucion_por_elemento_sin_prune() {
        let e = engine();
        let s = svc(&e);
        let plan = s
            .plan(ActionRequest::Cleanup {
                selection: sel(&["c1"], &["sha256:dd", "viejo:1"], &[], &["n1"]),
            })
            .await
            .expect("plan");
        // Sin volúmenes: confirmación simple (PruneImages exige humano).
        assert_eq!(plan.decision, PlanDecision::Confirm);
        assert_eq!(plan.affected.len(), 4);
        let out = s
            .execute(plan.ticket.as_deref().expect("ticket"), None)
            .await
            .expect("execute");
        assert_eq!(out.succeeded.len(), 4, "{:?}", out.failed);
        assert_eq!(
            removes(&e),
            [
                "remove_container:c1:force=false",
                "remove_image:sha256:dd",
                "remove_image:viejo:1",
                "remove_network:n1"
            ]
        );
        // Lo que no se marcó sigue ahí.
        assert!(e.state().volumes.iter().any(|v| v.name == "libre"));
    }

    #[tokio::test]
    async fn con_volumenes_exige_eliminar() {
        let e = engine();
        let s = svc(&e);
        let plan = s
            .plan(ActionRequest::Cleanup {
                selection: sel(&[], &[], &["libre"], &[]),
            })
            .await
            .expect("plan");
        assert_eq!(
            plan.decision,
            PlanDecision::ConfirmTyped {
                expected: "ELIMINAR".into()
            }
        );
        let t = plan.ticket.expect("ticket");
        assert!(matches!(
            s.execute(&t, Some("libre")).await,
            Err(ActionError::TypedMismatch)
        ));
        let out = s.execute(&t, Some("ELIMINAR")).await.expect("execute");
        assert_eq!(out.succeeded.len(), 1);
        assert_eq!(removes(&e), ["remove_volume:libre"]);
    }

    #[tokio::test]
    async fn rechaza_lo_que_esta_en_uso_o_no_es_elegible() {
        let e = engine();
        let s = svc(&e);
        for bad in [
            sel(&["c2"], &[], &[], &[]),
            sel(&[], &["uso:1"], &[], &[]),
            sel(&[], &[], &["ocupado"], &[]),
            sel(&[], &[], &[], &["n2"]),
            sel(&[], &[], &[], &["n3"]),
            sel(&[], &["../x"], &[], &[]),
            sel(&[], &[], &[], &[]),
        ] {
            let r = s
                .plan(ActionRequest::Cleanup {
                    selection: bad.clone(),
                })
                .await;
            assert!(r.is_err(), "{bad:?}");
        }
        assert!(removes(&e).is_empty());
    }

    #[tokio::test]
    async fn tope_de_500_elementos() {
        let e = engine();
        let s = svc(&e);
        let many: Vec<String> = (0..=MAX_ITEMS).map(|i| format!("v{i}")).collect();
        let r = s
            .plan(ActionRequest::Cleanup {
                selection: CleanupSelection {
                    volumes: many,
                    ..CleanupSelection::default()
                },
            })
            .await;
        assert!(matches!(r, Err(ActionError::Engine(_))));
    }

    #[tokio::test]
    async fn elemento_que_pasa_a_usarse_se_omite() {
        let e = engine();
        let s = svc(&e);
        let plan = s
            .plan(ActionRequest::Cleanup {
                selection: sel(&[], &["viejo:1"], &["libre"], &["n1"]),
            })
            .await
            .expect("plan");
        {
            // Entre el plan y la ejecución alguien usa la imagen, el volumen y la red.
            let mut st = e.state();
            for i in st.images.iter_mut().filter(|i| i.reference == "viejo:1") {
                i.containers = 1;
            }
            st.volumes[0].used_by = vec!["c2".into()];
            st.networks[0].connected = vec!["c2".into()];
        }
        let out = s
            .execute(plan.ticket.as_deref().expect("ticket"), Some("ELIMINAR"))
            .await
            .expect("execute");
        assert!(out.succeeded.is_empty());
        assert_eq!(out.failed.len(), 3);
        assert!(removes(&e).is_empty());
    }

    #[tokio::test]
    async fn cli_sin_tty_deniega_y_yes_no_salta_imagenes_ni_volumenes() {
        let e = engine();
        let s = svc(&e);
        let go = |selection| {
            let s = &s;
            async move {
                s.plan_with(
                    ActionRequest::Cleanup { selection },
                    Interactivity::NonInteractive,
                    true,
                )
                .await
                .expect("plan")
            }
        };
        // Solo contenedores y redes: --yes basta (Allow con ticket para ejecutar).
        let p = go(sel(&["c1"], &[], &[], &["n1"])).await;
        assert_eq!(p.decision, PlanDecision::Allow);
        assert!(p.ticket.is_some());
        // Con imágenes o volúmenes, sin TTY siempre Deny y sin ticket.
        for selection in [
            sel(&[], &["viejo:1"], &[], &[]),
            sel(&[], &[], &["libre"], &[]),
        ] {
            let p = go(selection).await;
            assert!(matches!(p.decision, PlanDecision::Deny { .. }));
            assert!(p.ticket.is_none());
        }
    }

    #[tokio::test]
    async fn prune_system_sigue_prohibido() {
        let e = engine();
        let p = svc(&e)
            .plan(ActionRequest::PruneSystem)
            .await
            .expect("plan");
        assert!(matches!(p.decision, PlanDecision::Deny { .. }));
        assert!(p.ticket.is_none());
    }
}
