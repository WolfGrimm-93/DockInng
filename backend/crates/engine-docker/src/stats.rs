//! Cálculo de CPU%, memoria y tasas a partir de las muestras del daemon.

use std::collections::HashMap;
use std::time::Instant;

use bollard::models::{ContainerCpuStats, ContainerStatsResponse};
use engine_core::ContainerStats;

/// Estado entre muestras de un mismo stream: CPU previa y contadores de red para las tasas.
#[derive(Default)]
pub struct StatsTracker {
    prev_cpu: Option<CpuSample>,
    prev_net: Option<(Instant, u64, u64)>,
}

#[derive(Clone, Copy)]
struct CpuSample {
    total: u64,
    system: u64,
}

fn cpu_sample(c: &ContainerCpuStats) -> Option<CpuSample> {
    let total = c.cpu_usage.as_ref()?.total_usage?;
    let system = c.system_cpu_usage?;
    Some(CpuSample { total, system })
}

fn online_cpus(c: &ContainerCpuStats) -> f64 {
    if let Some(n) = c.online_cpus.filter(|n| *n > 0) {
        return f64::from(n);
    }
    let per = c
        .cpu_usage
        .as_ref()
        .and_then(|u| u.percpu_usage.as_ref())
        .map(Vec::len)
        .unwrap_or(0);
    if per > 0 { per as f64 } else { 1.0 }
}

/// `cpu_delta / system_delta * online * 100`; 0.0 si no hay delta válido.
pub fn cpu_percent(prev: Option<(u64, u64)>, cur: (u64, u64), online: f64) -> f64 {
    let Some((pt, ps)) = prev else { return 0.0 };
    let (ct, cs) = cur;
    if cs <= ps || ct < pt {
        return 0.0;
    }
    let v = (ct - pt) as f64 / (cs - ps) as f64 * online * 100.0;
    if v.is_finite() { v } else { 0.0 }
}

/// Memoria usada como la CLI de Docker: `usage - cache` (cgroup v2 `inactive_file`,
/// v1 `total_inactive_file`); si la caché supera el uso no se resta.
pub fn mem_used(usage: u64, stats: Option<&HashMap<String, u64>>) -> u64 {
    let cache = stats
        .and_then(|s| {
            s.get("inactive_file")
                .or_else(|| s.get("total_inactive_file"))
        })
        .copied()
        .unwrap_or(0);
    if cache > usage { usage } else { usage - cache }
}

impl StatsTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Convierte una muestra cruda. La primera usa `precpu_stats` del daemon si sirve.
    pub fn sample(&mut self, r: &ContainerStatsResponse, now: Instant) -> ContainerStats {
        let cur_cpu = r.cpu_stats.as_ref().and_then(cpu_sample);
        let prev = self.prev_cpu.or_else(|| {
            r.precpu_stats
                .as_ref()
                .and_then(cpu_sample)
                .filter(|p| p.system > 0)
        });
        let online = r.cpu_stats.as_ref().map(online_cpus).unwrap_or(1.0);
        let cpu = match cur_cpu {
            Some(c) => cpu_percent(
                prev.map(|p| (p.total, p.system)),
                (c.total, c.system),
                online,
            ),
            None => 0.0,
        };
        self.prev_cpu = cur_cpu.or(self.prev_cpu);

        let mem = r.memory_stats.as_ref();
        let usage = mem.and_then(|m| m.usage).unwrap_or(0);
        let limit = mem.and_then(|m| m.limit).unwrap_or(0);
        let used = mem_used(usage, mem.and_then(|m| m.stats.as_ref()));
        let mem_percent = if limit > 0 {
            used as f64 / limit as f64 * 100.0
        } else {
            0.0
        };

        let (rx, tx) = r
            .networks
            .as_ref()
            .map(|n| {
                n.values().fold((0u64, 0u64), |(a, b), i| {
                    (
                        a.saturating_add(i.rx_bytes.unwrap_or(0)),
                        b.saturating_add(i.tx_bytes.unwrap_or(0)),
                    )
                })
            })
            .unwrap_or((0, 0));
        // Tasa = delta / Δt con reloj monotónico; contador que retrocede => 0.
        let (rx_s, tx_s) = match self.prev_net {
            Some((t, prx, ptx)) => {
                let dt = now.duration_since(t).as_secs_f64();
                if dt > 0.0 {
                    (
                        rx.saturating_sub(prx) as f64 / dt,
                        tx.saturating_sub(ptx) as f64 / dt,
                    )
                } else {
                    (0.0, 0.0)
                }
            }
            None => (0.0, 0.0),
        };
        self.prev_net = Some((now, rx, tx));

        let (mut br, mut bw) = (0u64, 0u64);
        if let Some(entries) = r
            .blkio_stats
            .as_ref()
            .and_then(|b| b.io_service_bytes_recursive.as_ref())
        {
            for e in entries {
                let v = e.value.unwrap_or(0);
                match e.op.as_deref().map(str::to_ascii_lowercase).as_deref() {
                    Some("read") => br = br.saturating_add(v),
                    Some("write") => bw = bw.saturating_add(v),
                    _ => {}
                }
            }
        }

        ContainerStats {
            read_at: r.read.clone().unwrap_or_default(),
            cpu_percent: cpu,
            mem_used_bytes: used,
            mem_limit_bytes: limit,
            mem_percent,
            net_rx_bytes: rx,
            net_tx_bytes: tx,
            net_rx_bytes_per_sec: rx_s,
            net_tx_bytes_per_sec: tx_s,
            block_read_bytes: br,
            block_write_bytes: bw,
            pids: r.pids_stats.as_ref().and_then(|p| p.current).unwrap_or(0),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn sample_json(
        total: u64,
        system: u64,
        pre_total: u64,
        pre_system: u64,
        mem_stats: &str,
    ) -> ContainerStatsResponse {
        serde_json::from_str(&format!(
            r#"{{
            "read":"2026-09-24T14:00:00Z","preread":"2026-09-24T13:59:59Z",
            "cpu_stats":{{"cpu_usage":{{"total_usage":{total}}},"system_cpu_usage":{system},"online_cpus":24}},
            "precpu_stats":{{"cpu_usage":{{"total_usage":{pre_total}}},"system_cpu_usage":{pre_system},"online_cpus":24}},
            "memory_stats":{{"usage":1000,"limit":10000,"stats":{mem_stats}}},
            "networks":{{"eth0":{{"rx_bytes":100,"tx_bytes":50}},"eth1":{{"rx_bytes":10,"tx_bytes":5}}}},
            "blkio_stats":{{"io_service_bytes_recursive":[{{"op":"read","value":7}},{{"op":"Write","value":9}},{{"op":"Total","value":16}}]}},
            "pids_stats":{{"current":3}}
        }}"#
        ))
        .expect("json")
    }

    #[test]
    fn cpu_con_precpu_en_la_primera_muestra() {
        // 1 s de 24 CPUs; el contenedor usó medio núcleo => 50%.
        let r = sample_json(500_000_000, 24_200_000_000 + 1_000, 0, 1_000, "{}");
        let mut t = StatsTracker::new();
        let s = t.sample(&r, Instant::now());
        let esperado = 500_000_000f64 / 24_200_000_000f64 * 24.0 * 100.0;
        assert!((s.cpu_percent - esperado).abs() < 1e-9, "{}", s.cpu_percent);
        assert_eq!(s.pids, 3);
        assert_eq!((s.block_read_bytes, s.block_write_bytes), (7, 9));
        assert_eq!((s.net_rx_bytes, s.net_tx_bytes), (110, 55));
    }

    #[test]
    fn primera_muestra_sin_precpu_es_cero() {
        let r = sample_json(500, 1000, 0, 0, "{}");
        assert_eq!(
            StatsTracker::new().sample(&r, Instant::now()).cpu_percent,
            0.0
        );
    }

    #[test]
    fn contadores_que_retroceden_y_division_por_cero() {
        assert_eq!(cpu_percent(Some((100, 100)), (50, 200), 4.0), 0.0);
        assert_eq!(cpu_percent(Some((100, 100)), (150, 100), 4.0), 0.0);
        assert_eq!(cpu_percent(None, (150, 100), 4.0), 0.0);
        assert!((cpu_percent(Some((0, 0)), (10, 100), 2.0) - 20.0).abs() < 1e-9);
    }

    #[test]
    fn segunda_muestra_usa_la_previa_propia_y_calcula_tasas() {
        let mut t = StatsTracker::new();
        let t0 = Instant::now();
        t.sample(&sample_json(1_000, 10_000, 0, 0, "{}"), t0);
        let r2: ContainerStatsResponse = serde_json::from_str(
            r#"{"cpu_stats":{"cpu_usage":{"total_usage":1500},"system_cpu_usage":11000,"online_cpus":2},
                "networks":{"eth0":{"rx_bytes":1110,"tx_bytes":50}}}"#,
        )
        .expect("json");
        let s = t.sample(&r2, t0 + Duration::from_secs(2));
        assert!((s.cpu_percent - 500.0 / 1000.0 * 2.0 * 100.0).abs() < 1e-9);
        assert!((s.net_rx_bytes_per_sec - (1110.0 - 110.0) / 2.0).abs() < 1e-9);
        assert_eq!(s.net_tx_bytes_per_sec, 0.0);
    }

    #[test]
    fn online_cpus_ausente_usa_percpu_o_uno() {
        let c: ContainerCpuStats =
            serde_json::from_str(r#"{"cpu_usage":{"percpu_usage":[1,2,3]}}"#).expect("json");
        assert_eq!(online_cpus(&c), 3.0);
        let c: ContainerCpuStats = serde_json::from_str("{}").expect("json");
        assert_eq!(online_cpus(&c), 1.0);
    }

    #[test]
    fn memoria_v2_v1_y_cache_mayor_que_uso() {
        let v2: HashMap<String, u64> = [("inactive_file".to_string(), 300)].into();
        assert_eq!(mem_used(1000, Some(&v2)), 700);
        let v1: HashMap<String, u64> = [("total_inactive_file".to_string(), 400)].into();
        assert_eq!(mem_used(1000, Some(&v1)), 600);
        let big: HashMap<String, u64> = [("inactive_file".to_string(), 5000)].into();
        assert_eq!(mem_used(1000, Some(&big)), 1000);
        assert_eq!(mem_used(1000, None), 1000);
        let r = sample_json(0, 0, 0, 0, r#"{"inactive_file":200}"#);
        let s = StatsTracker::new().sample(&r, Instant::now());
        assert_eq!(s.mem_used_bytes, 800);
        assert!((s.mem_percent - 8.0).abs() < 1e-9);
    }

    #[test]
    fn limite_cero_no_divide() {
        let r: ContainerStatsResponse =
            serde_json::from_str(r#"{"memory_stats":{"usage":10,"limit":0}}"#).expect("json");
        assert_eq!(
            StatsTracker::new().sample(&r, Instant::now()).mem_percent,
            0.0
        );
    }
}
