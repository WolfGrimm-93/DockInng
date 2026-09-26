//! `cleanup plan|apply`. El plan es de solo lectura; `apply` NUNCA es un prune: ejecuta la
//! selección elemento a elemento por el flujo plan -> confirmación -> ticket.

use engine_core::{
    ActionRequest, CleanupCategoryId, CleanupReport, CleanupSelection, ItemKind, SizeEstimate,
    cleanup_report,
};

use crate::apply::apply;
use crate::cli::Confirm;
use crate::confirm::Stdin;
use crate::ctx::Ctx;
use crate::output::{human_bytes, print_json, print_lines, table};

fn category_label(id: CleanupCategoryId) -> &'static str {
    match id {
        CleanupCategoryId::StoppedContainers => "Contenedores detenidos",
        CleanupCategoryId::DanglingImages => "Imágenes colgadas",
        CleanupCategoryId::UnusedImages => "Imágenes sin usar",
        CleanupCategoryId::UnusedVolumes => "Volúmenes sin usar (pueden tener datos)",
        CleanupCategoryId::UnusedNetworks => "Redes sin usar",
        CleanupCategoryId::BuildCache => "Caché de build (solo informe)",
    }
}

/// Informe legible (función pura).
pub fn format_report(r: &CleanupReport) -> Vec<String> {
    let mut out = Vec::new();
    for c in &r.categories {
        let total = c.reclaimable_bytes.map_or("?".to_string(), human_bytes);
        out.push(format!(
            "{} — {} elemento(s), {}",
            category_label(c.id),
            c.items.len(),
            total
        ));
        if !c.executable {
            out.push("  (no se puede borrar por elemento: solo informativo)".into());
        }
        let rows: Vec<Vec<String>> = c
            .items
            .iter()
            .map(|i| {
                let size = match (i.size_bytes, i.estimate) {
                    (Some(b), SizeEstimate::UpperBound) => format!("≤ {}", human_bytes(b)),
                    (Some(b), _) => human_bytes(b),
                    (None, _) => "?".into(),
                };
                vec![
                    if i.selected_by_default { "*" } else { " " }.to_string(),
                    i.name.clone(),
                    size,
                    i.reason.clone(),
                ]
            })
            .collect();
        if !rows.is_empty() {
            out.extend(
                table(&["", "NOMBRE", "TAMAÑO", "MOTIVO"], &rows)
                    .into_iter()
                    .map(|l| format!("  {l}")),
            );
        }
    }
    out.push(format!(
        "Recuperable (categorías ejecutables): {}{}",
        r.total_reclaimable_bytes.map_or("?".into(), human_bytes),
        if r.unknown_count > 0 {
            format!(" (+ {} elemento(s) de tamaño desconocido)", r.unknown_count)
        } else {
            String::new()
        }
    ));
    out.push(
        "* = marcado por defecto (`cleanup apply --defaults`); los volúmenes nunca lo están".into(),
    );
    out
}

pub async fn plan(ctx: &Ctx, min_age_days: u32) -> Result<(), String> {
    let r = cleanup_report(ctx.engine.as_ref(), min_age_days)
        .await
        .map_err(|e| e.to_string())?;
    if ctx.json {
        return print_json(&r);
    }
    print_lines(&format_report(&r));
    Ok(())
}

pub struct ApplyArgs {
    pub defaults: bool,
    pub min_age_days: u32,
    pub containers: Vec<String>,
    pub images: Vec<String>,
    pub volumes: Vec<String>,
    pub networks: Vec<String>,
}

/// Selección de la persona + lo recomendado del informe si pidió `--defaults`.
pub fn build_selection(a: &ApplyArgs, report: Option<&CleanupReport>) -> CleanupSelection {
    let mut sel = CleanupSelection {
        containers: a.containers.clone(),
        images: a.images.clone(),
        volumes: a.volumes.clone(),
        networks: a.networks.clone(),
    };
    if let Some(r) = report {
        for item in r.categories.iter().flat_map(|c| &c.items) {
            // Los volúmenes NUNCA entran por defecto (contienen datos).
            if !item.selected_by_default || item.kind == ItemKind::Volume {
                continue;
            }
            let list = match item.kind {
                ItemKind::Container => &mut sel.containers,
                ItemKind::Image => &mut sel.images,
                ItemKind::Network => &mut sel.networks,
                ItemKind::Volume | ItemKind::Stack => continue,
            };
            if !list.contains(&item.id) {
                list.push(item.id.clone());
            }
        }
    }
    sel
}

pub async fn apply_cmd(ctx: &Ctx, a: ApplyArgs, confirm: Confirm) -> Result<(), String> {
    let report = if a.defaults {
        Some(
            cleanup_report(ctx.engine.as_ref(), a.min_age_days)
                .await
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };
    let selection = build_selection(&a, report.as_ref());
    if selection.is_empty() {
        return Err(
            "indica qué limpiar: --defaults o --container/--image/--volume/--network".into(),
        );
    }
    apply(
        ctx,
        &ctx.actions(),
        ActionRequest::Cleanup { selection },
        confirm.yes,
        "¿Eliminar los elementos listados?",
        &mut Stdin,
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use engine_core::ContainerState;
    use engine_core::testing::MockEngine;

    use super::*;

    async fn report() -> CleanupReport {
        let e = Arc::new(MockEngine::new());
        {
            let mut s = e.state();
            s.containers.push(MockEngine::container(
                "c1",
                "parado",
                ContainerState::Exited,
                "t",
            ));
            s.volumes.push(MockEngine::volume("datos", "t", &[]));
            let mut d = MockEngine::image("sha256:dd", "sha256:dd", 0);
            d.dangling = true;
            s.images.push(d);
            s.networks
                .push(MockEngine::network("n1", "sobra", &[], false));
        }
        cleanup_report(&*e, 0).await.unwrap()
    }

    fn args(defaults: bool) -> ApplyArgs {
        ApplyArgs {
            defaults,
            min_age_days: 0,
            containers: vec![],
            images: vec![],
            volumes: vec![],
            networks: vec![],
        }
    }

    #[tokio::test]
    async fn defaults_marcan_lo_recomendado_y_nunca_volumenes() {
        let r = report().await;
        let sel = build_selection(&args(true), Some(&r));
        assert_eq!(sel.containers, ["c1"]);
        assert_eq!(sel.images, ["sha256:dd"]);
        assert_eq!(sel.networks, ["n1"]);
        assert!(sel.volumes.is_empty(), "los volúmenes no van por defecto");
    }

    #[tokio::test]
    async fn seleccion_explicita_de_volumenes_se_respeta_sin_duplicar() {
        let r = report().await;
        let mut a = args(true);
        a.volumes = vec!["datos".into()];
        a.containers = vec!["c1".into()];
        let sel = build_selection(&a, Some(&r));
        assert_eq!(sel.volumes, ["datos"]);
        assert_eq!(sel.containers, ["c1"]);
    }

    #[test]
    fn sin_nada_marcado_la_seleccion_esta_vacia() {
        assert!(build_selection(&args(false), None).is_empty());
    }

    #[tokio::test]
    async fn informe_legible() {
        let l = format_report(&report().await).join("\n");
        assert!(l.contains("Contenedores detenidos — 1 elemento(s)"), "{l}");
        assert!(l.contains("Volúmenes sin usar"));
        assert!(l.contains("solo informativo"));
        assert!(l.contains("Recuperable"));
    }
}
