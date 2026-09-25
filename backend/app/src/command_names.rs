// Lista única de comandos IPC. La usan `build.rs` (manifest de permisos `allow-<comando>`)
// y `lib.rs` (test que la compara con `generate_handler!`). Solo literales: se incluye con
// `include!`, no puede tener `use` ni items privados.
pub const COMMAND_NAMES: &[&str] = &[
    "connection_status",
    "reconnect",
    "list_containers",
    "inspect_container",
    "container_stats_snapshot",
    "list_images",
    "list_volumes",
    "list_networks",
    "system_usage",
    "gpu_status",
    "start_container",
    "stop_container",
    "restart_container",
    "plan_action",
    "execute_action",
    "cancel_action",
    "subscribe_engine_events",
    "subscribe_logs",
    "subscribe_stats",
    "unsubscribe",
    "reset_subscriptions",
];
