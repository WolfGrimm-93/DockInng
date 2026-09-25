use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Una fila por etiqueta (como la plantilla). Deduplicar por `id` al sumar tamaños.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Image {
    pub id: String,
    /// "repo:tag"; si está colgada, el id (lo que se pasa a remove).
    pub reference: String,
    pub repository: String,
    pub tag: String,
    pub size_bytes: u64,
    pub created: i64,
    /// Contenedores que la usan.
    pub containers: u32,
    pub dangling: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Volume {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    pub created_at: Option<String>,
    pub labels: HashMap<String, String>,
    pub compose_project: Option<String>,
    /// `None` = desconocido.
    pub size_bytes: Option<u64>,
    pub used_by: Vec<String>,
    pub anonymous: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Network {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
    pub subnets: Vec<String>,
    pub internal: bool,
    /// bridge, host, none: no se pueden borrar.
    pub system: bool,
    pub connected: Vec<String>,
    pub compose_project: Option<String>,
}
