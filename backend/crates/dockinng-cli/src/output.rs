//! Formato de salida: tablas puras (sin TTY: la misma salida en modo no interactivo) y JSON.

use std::io::{self, Write};

use engine_core::{Container, Image, Network, Volume};
use serde::Serialize;

/// Ancho máximo de las columnas nombre e imagen.
pub const MAX_NAME: usize = 32;
pub const MAX_IMAGE: usize = 40;

/// Recorta a `max` caracteres con `…` (cuenta caracteres, no bytes).
pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Tabla con la cabecera y las filas alineadas a la izquierda; la última columna no se rellena.
pub fn table(header: &[&str], rows: &[Vec<String>]) -> Vec<String> {
    let cols = header.len();
    let widths: Vec<usize> = (0..cols)
        .map(|i| {
            rows.iter()
                .map(|r| r[i].chars().count())
                .chain(std::iter::once(header[i].chars().count()))
                .max()
                .unwrap_or(0)
        })
        .collect();
    let fmt = |cells: &[String]| {
        let mut line = String::new();
        for (i, c) in cells.iter().enumerate() {
            if i + 1 == cols {
                line.push_str(c);
            } else {
                line.push_str(&format!("{:<w$}  ", c, w = widths[i]));
            }
        }
        line
    };
    let head: Vec<String> = header.iter().map(|s| s.to_string()).collect();
    std::iter::once(fmt(&head))
        .chain(rows.iter().map(|r| fmt(r)))
        .collect()
}

/// `1.5 MB` (decimal, como Docker).
pub fn human_bytes(b: u64) -> String {
    const UNITS: [&str; 5] = ["B", "kB", "MB", "GB", "TB"];
    let mut v = b as f64;
    let mut i = 0;
    while v >= 1000.0 && i < UNITS.len() - 1 {
        v /= 1000.0;
        i += 1;
    }
    if i == 0 {
        format!("{b} B")
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}

pub fn format_containers(containers: &[Container]) -> Vec<String> {
    let rows: Vec<Vec<String>> = containers
        .iter()
        .map(|c| {
            vec![
                c.id.chars().take(12).collect(),
                truncate(c.names.first().map(String::as_str).unwrap_or("-"), MAX_NAME),
                truncate(&c.image, MAX_IMAGE),
                c.status.clone(),
            ]
        })
        .collect();
    table(&["ID", "NOMBRE", "IMAGEN", "ESTADO"], &rows)
}

pub fn format_images(images: &[Image]) -> Vec<String> {
    let rows: Vec<Vec<String>> = images
        .iter()
        .map(|i| {
            vec![
                i.id.trim_start_matches("sha256:")
                    .chars()
                    .take(12)
                    .collect(),
                truncate(&i.reference, MAX_IMAGE + 20),
                human_bytes(i.size_bytes),
                i.containers.to_string(),
            ]
        })
        .collect();
    table(&["ID", "REFERENCIA", "TAMAÑO", "USADA POR"], &rows)
}

pub fn format_volumes(volumes: &[Volume]) -> Vec<String> {
    let rows: Vec<Vec<String>> = volumes
        .iter()
        .map(|v| {
            vec![
                truncate(&v.name, MAX_IMAGE + 20),
                v.driver.clone(),
                v.size_bytes.map_or("?".into(), human_bytes),
                v.used_by.len().to_string(),
            ]
        })
        .collect();
    table(&["NOMBRE", "DRIVER", "TAMAÑO", "USADO POR"], &rows)
}

pub fn format_networks(networks: &[Network]) -> Vec<String> {
    let rows: Vec<Vec<String>> = networks
        .iter()
        .map(|n| {
            vec![
                n.id.chars().take(12).collect(),
                truncate(&n.name, MAX_NAME),
                n.driver.clone(),
                n.scope.clone(),
                n.connected.len().to_string(),
            ]
        })
        .collect();
    table(
        &["ID", "NOMBRE", "DRIVER", "ALCANCE", "CONTENEDORES"],
        &rows,
    )
}

/// Escribe líneas; si la salida se corta (`| head`) termina sin `panic`.
pub fn print_lines(lines: &[String]) {
    let mut out = io::stdout().lock();
    for l in lines {
        if writeln!(out, "{l}").is_err() {
            return;
        }
    }
}

/// JSON con sangría (listados y planes).
pub fn print_json<T: Serialize>(v: &T) -> Result<(), String> {
    let s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    print_lines(&[s]);
    Ok(())
}

/// Una línea JSON (NDJSON: progreso).
pub fn print_ndjson<T: Serialize>(v: &T) {
    if let Ok(s) = serde_json::to_string(v) {
        print_lines(&[s]);
    }
}

#[cfg(test)]
mod tests {
    use engine_core::ContainerState;

    use super::*;

    fn c(id: &str, name: &str, image: &str, status: &str) -> Container {
        Container {
            id: id.into(),
            names: if name.is_empty() {
                vec![]
            } else {
                vec![name.into()]
            },
            image: image.into(),
            image_id: String::new(),
            state: ContainerState::Running,
            status: status.into(),
            created: 0,
            compose_project: None,
            compose_service: None,
            ports: vec![],
            mounts: vec![],
            networks: vec![],
            endpoints: vec![],
        }
    }

    #[test]
    fn truncado_con_puntos_suspensivos_por_caracteres() {
        assert_eq!(truncate("corto", 10), "corto");
        assert_eq!(truncate("abcdefghij", 10), "abcdefghij");
        assert_eq!(truncate("abcdefghijk", 10), "abcdefghi…");
        assert_eq!(truncate("ñandú-ñandú", 5), "ñand…");
    }

    #[test]
    fn columnas_alineadas_aunque_la_imagen_sea_larga() {
        let largo = "clamav/clamav:stable@sha256:0e31ce089574268aefa0b543767d66b70240ab51ed49eec53e07f18d5629d817";
        let lines = format_containers(&[
            c("8d8ab4a11854aaaa", "proyecto-clamav-1", largo, "Up 5 hours"),
            c("b7e0", "", "nginx", "Exited"),
        ]);
        assert_eq!(lines.len(), 3);
        let pos: Vec<usize> = ["ESTADO", "Up 5 hours", "Exited"]
            .iter()
            .zip(&lines)
            .map(|(needle, l)| l.chars().count() - needle.chars().count())
            .collect();
        assert!(pos.iter().all(|p| *p == pos[0]), "{lines:#?}");
        assert!(lines[1].contains('…'));
        assert!(lines[1].starts_with("8d8ab4a11854  "));
        assert!(lines[2].contains(" -  "), "sin nombre se muestra '-'");
    }

    #[test]
    fn sin_contenedores_solo_cabecera() {
        let l = format_containers(&[]);
        assert_eq!(l.len(), 1);
        assert!(l[0].starts_with("ID") && l[0].ends_with("ESTADO"));
    }

    #[test]
    fn tamanos_legibles() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(999), "999 B");
        assert_eq!(human_bytes(1_500), "1.5 kB");
        assert_eq!(human_bytes(2_500_000), "2.5 MB");
        assert!(human_bytes(u64::MAX).ends_with("TB"));
    }

    #[test]
    fn tablas_de_recursos() {
        let img = Image {
            id: "sha256:0123456789abcdef".into(),
            reference: "app:1".into(),
            repository: "app".into(),
            tag: "1".into(),
            size_bytes: 1_200_000,
            created: 0,
            containers: 2,
            dangling: false,
        };
        let l = format_images(&[img]);
        assert_eq!(l.len(), 2);
        assert!(l[1].starts_with("0123456789ab  app:1"), "{l:?}");
        assert!(l[1].contains("1.2 MB"));
        let vol = Volume {
            name: "datos".into(),
            driver: "local".into(),
            mountpoint: String::new(),
            created_at: None,
            labels: Default::default(),
            compose_project: None,
            size_bytes: None,
            used_by: vec![],
            anonymous: false,
        };
        assert!(format_volumes(&[vol])[1].contains("  ?  "));
        let net = Network {
            id: "abcdef0123456789".into(),
            name: "red".into(),
            driver: "bridge".into(),
            scope: "local".into(),
            subnets: vec![],
            internal: false,
            system: false,
            connected: vec!["a".into()],
            compose_project: None,
        };
        assert!(format_networks(&[net])[1].starts_with("abcdef012345  red"));
    }
}
