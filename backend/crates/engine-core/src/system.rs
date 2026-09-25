//! Recursos del equipo, uso de disco de Docker y estado de la GPU. Son datos de solo lectura para la
//! franja de consumo de la tabla de contenedores; nada de esto modifica el motor.

use serde::{Deserialize, Serialize};

/// CPU y memoria del equipo donde corre el motor (`/info`: `NCPU`, `MemTotal`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostResources {
    pub cpu_count: u32,
    pub mem_total_bytes: u64,
}

/// Una categoría de `/system/df`. `None` = el motor no lo informó.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiskCategory {
    pub total_bytes: Option<u64>,
    pub reclaimable_bytes: Option<u64>,
}

/// Disco que usa Docker (no es el disco del equipo).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiskUsage {
    pub images: DiskCategory,
    pub containers: DiskCategory,
    pub volumes: DiskCategory,
    pub build_cache: DiskCategory,
}

/// Capa de escritura de un contenedor (lo que ha escrito además de su imagen).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContainerDisk {
    pub id: String,
    pub size_rw_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemUsage {
    pub host: HostResources,
    pub disk: DiskUsage,
    /// Una entrada por contenedor que informa `df`.
    pub container_disk: Vec<ContainerDisk>,
    /// `false` = `df` falló o expiró (o el daemon es demasiado antiguo): el disco es desconocido, no cero.
    pub disk_known: bool,
}

/// Una GPU del equipo (hoy solo NVIDIA, vía `nvidia-smi`). Docker no informa la GPU por contenedor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GpuInfo {
    pub index: u32,
    pub name: String,
    /// 0–100.
    pub utilization_percent: f32,
    pub mem_used_bytes: u64,
    pub mem_total_bytes: u64,
    pub temperature_c: Option<u32>,
}
