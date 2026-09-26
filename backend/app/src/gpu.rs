//! Lectura de la GPU del equipo con `nvidia-smi` (solo NVIDIA). Es una lectura del propio equipo, no del motor:
//! por eso solo se consulta cuando el motor es el local (mismo equipo). Docker no informa la GPU por contenedor.
//! Cualquier fallo (no hay `nvidia-smi`, timeout, salida rara) devuelve "sin GPU", nunca un error.

use std::future::Future;
use std::time::{Duration, Instant};

use engine_core::GpuInfo;
use tokio::process::Command;
use tokio::sync::Mutex;

/// El frontend pregunta cada ~4 s; `nvidia-smi` es caro (lanza un proceso y toca el driver),
/// así que se reutiliza el último resultado durante este tiempo.
pub const CACHE_TTL: Duration = Duration::from_secs(15);

/// Caché del último resultado (también el vacío: sin GPU no se relanza el proceso cada 4 s).
/// El candado se mantiene durante la consulta: llamadas simultáneas comparten una sola.
pub struct GpuCache {
    slot: Mutex<Option<(Instant, Vec<GpuInfo>)>>,
}

impl GpuCache {
    pub const fn new() -> Self {
        Self {
            slot: Mutex::const_new(None),
        }
    }

    pub async fn get<F: Future<Output = Vec<GpuInfo>>>(
        &self,
        ttl: Duration,
        fetch: impl FnOnce() -> F,
    ) -> Vec<GpuInfo> {
        let mut g = self.slot.lock().await;
        if let Some((at, v)) = g.as_ref()
            && at.elapsed() < ttl
        {
            return v.clone();
        }
        let v = fetch().await;
        *g = Some((Instant::now(), v.clone()));
        v
    }
}

impl Default for GpuCache {
    fn default() -> Self {
        Self::new()
    }
}

static CACHE: GpuCache = GpuCache::new();

const TIMEOUT: Duration = Duration::from_secs(3);
const MIB: u64 = 1024 * 1024;

/// Argumentos fijos (nada llega desde la UI): `csv,noheader,nounits`.
const ARGS: [&str; 2] = [
    "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
    "--format=csv,noheader,nounits",
];

/// Motor local = sin `DOCKER_HOST` o con socket unix. En remoto la GPU del equipo no es la del motor.
pub fn engine_is_local() -> bool {
    match std::env::var("DOCKER_HOST") {
        Err(_) => true,
        Ok(h) => h.is_empty() || h.starts_with("unix://"),
    }
}

/// GPU del equipo, con caché de `CACHE_TTL`.
pub async fn probe() -> Vec<GpuInfo> {
    if !engine_is_local() {
        return Vec::new();
    }
    CACHE.get(CACHE_TTL, query_smi).await
}

async fn query_smi() -> Vec<GpuInfo> {
    let run = Command::new("nvidia-smi")
        .args(ARGS)
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(TIMEOUT, run).await {
        Ok(Ok(out)) if out.status.success() => parse(&String::from_utf8_lossy(&out.stdout)),
        _ => Vec::new(),
    }
}

/// `0, NVIDIA GeForce RTX 3090, 3, 1024, 24576, 45` (memoria en MiB). Un valor `[N/A]` no invalida la línea.
pub fn parse(out: &str) -> Vec<GpuInfo> {
    out.lines().filter_map(parse_line).collect()
}

fn parse_line(line: &str) -> Option<GpuInfo> {
    let parts: Vec<&str> = line.split(", ").map(str::trim).collect();
    if parts.len() < 6 {
        return None;
    }
    let n = parts.len();
    let num = |s: &str| s.parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0);
    Some(GpuInfo {
        index: parts[0].parse().ok()?,
        // El nombre puede contener ", ": son todos los campos entre el índice y los 4 numéricos finales.
        name: parts[1..n - 4].join(", "),
        utilization_percent: num(parts[n - 4]).map_or(0.0, |v| v.min(100.0)) as f32,
        mem_used_bytes: num(parts[n - 3]).map_or(0, |v| v as u64 * MIB),
        mem_total_bytes: num(parts[n - 2]).map_or(0, |v| v as u64 * MIB),
        temperature_c: num(parts[n - 1]).map(|v| v as u32),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn la_cache_evita_relanzar_nvidia_smi() {
        use std::sync::atomic::{AtomicU32, Ordering};
        let cache = GpuCache::new();
        let calls = AtomicU32::new(0);
        let fetch = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Vec::new()
        };
        for _ in 0..5 {
            cache.get(Duration::from_millis(80), fetch).await;
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "un resultado vacío también se cachea"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        cache.get(Duration::from_millis(80), fetch).await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "pasado el TTL se vuelve a consultar"
        );
    }

    #[tokio::test]
    async fn consultas_simultaneas_comparten_una_sola() {
        use std::sync::atomic::{AtomicU32, Ordering};
        let cache = GpuCache::new();
        let calls = AtomicU32::new(0);
        let fetch = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(30)).await;
            Vec::new()
        };
        tokio::join!(
            cache.get(Duration::from_secs(5), fetch),
            cache.get(Duration::from_secs(5), fetch),
            cache.get(Duration::from_secs(5), fetch)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn parsea_una_gpu_normal() {
        let g = parse("0, NVIDIA GeForce RTX 3090, 3, 1024, 24576, 45\n");
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].index, 0);
        assert_eq!(g[0].name, "NVIDIA GeForce RTX 3090");
        assert_eq!(g[0].utilization_percent, 3.0);
        assert_eq!(g[0].mem_used_bytes, 1024 * MIB);
        assert_eq!(g[0].mem_total_bytes, 24576 * MIB);
        assert_eq!(g[0].temperature_c, Some(45));
    }

    #[test]
    fn valores_na_no_invalidan_la_linea_ni_se_inventan() {
        let g = parse("1, Tesla T4, [N/A], [N/A], 15360, [N/A]");
        assert_eq!(g[0].utilization_percent, 0.0);
        assert_eq!(g[0].mem_used_bytes, 0);
        assert_eq!(g[0].mem_total_bytes, 15360 * MIB);
        assert_eq!(g[0].temperature_c, None);
    }

    #[test]
    fn nombre_con_coma_y_varias_gpus() {
        let g = parse("0, Foo, Bar Ultra, 50, 10, 100, 60\n1, Otra, 7, 2, 4, 30\n");
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].name, "Foo, Bar Ultra");
        assert_eq!(g[1].name, "Otra");
    }

    #[test]
    fn basura_y_lineas_incompletas_se_ignoran() {
        assert!(parse("").is_empty());
        assert!(parse("No devices were found").is_empty());
        assert!(parse("x, y, 1, 2, 3, 4").is_empty()); // índice no numérico
        assert_eq!(parse("0, G, 250, 1, 1, 1")[0].utilization_percent, 100.0); // se acota
    }

    /// Contra el `nvidia-smi` REAL si el equipo lo tiene (en uno sin GPU devuelve vacío y también pasa): los valores deben ser coherentes.
    #[tokio::test]
    async fn probe_real_devuelve_valores_coherentes() {
        for g in probe().await {
            assert!(!g.name.is_empty());
            assert!((0.0..=100.0).contains(&g.utilization_percent));
            assert!(
                g.mem_used_bytes <= g.mem_total_bytes,
                "VRAM usada > total: {g:?}"
            );
        }
    }
}
