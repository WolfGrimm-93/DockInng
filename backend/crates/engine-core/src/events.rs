use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineEventKind {
    Container,
    Image,
    Volume,
    Network,
    Daemon,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineEvent {
    pub kind: EngineEventKind,
    pub action: String,
    pub id: String,
    pub name: Option<String>,
    // JS: >2^53 (pierde precisión como number); solo sirve para ordenar/mostrar.
    pub time_nano: i64,
    /// Solo una lista blanca de atributos.
    pub attributes: BTreeMap<String, String>,
}
