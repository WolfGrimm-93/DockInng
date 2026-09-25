use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogStream {
    Stdout,
    Stderr,
    /// TTY: no hay separación entre stdout y stderr.
    Console,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogLine {
    pub stream: LogStream,
    /// RFC3339Nano del daemon.
    pub timestamp: Option<String>,
    /// Sin salto de línea final.
    pub message: String,
    pub truncated: bool,
}

/// Tope de `tail` que se acepta.
pub const MAX_LOG_TAIL: u32 = 10_000;
pub const DEFAULT_LOG_TAIL: u32 = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogsRequest {
    pub tail: Option<u32>,
    pub follow: bool,
    /// Epoch en segundos.
    pub since: Option<i32>,
}

impl LogsRequest {
    pub fn effective_tail(&self) -> u32 {
        self.tail.unwrap_or(DEFAULT_LOG_TAIL).min(MAX_LOG_TAIL)
    }
}
