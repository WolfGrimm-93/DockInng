//! Contrato IPC generado desde Rust (solo tests).
//!
//! Produce `contract/fixtures.json` con la FORMA REAL que serializa Rust:
//! - cada valor se construye pasando un literal por el tipo Rust real (`from_value::<T>` y
//!   `to_value`), de modo que el JSON final es exactamente lo que Rust envía (campos
//!   opcionales, `skip_serializing_if`, `tag`, `flatten`...) y un literal que Rust no acepta
//!   hace fallar el test;
//! - los tipos que solo se serializan (feeds, `StatsSnapshotItem`, mensajes del shell) se
//!   construyen directamente;
//! - cada enum se enumera con un `match` SIN comodín: añadir una variante no compila hasta que
//!   se añade su fixture;
//! - los argumentos de cada comando se comparan con la firma real leída del código fuente de
//!   los módulos `commands*` (nombres en camelCase), y el conjunto de comandos con `COMMAND_NAMES`.
//!
//! El test `contract_fixtures_estan_al_dia` falla si el archivo está desactualizado, salvo con
//! `UPDATE_CONTRACT=1`, que lo reescribe. El frontend genera de aquí sus tipos y tests.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use engine_core::actions::{ActionPlan, ActionRequest, PlanDecision, PlanWarning};
use engine_core::build::{BuildFeed, BuildWarning};
use engine_core::connection::{ConnectionCause, ConnectionStatus};
use engine_core::connections::ConnSpec;
use engine_core::create::CreateWarning;
use engine_core::logs::{LogLine, LogStream};
use engine_core::stacks::{StackOp, StackOpFeed, StackRisk};
use engine_core::stats::ContainerStats;
use engine_core::{ApiError, ApiErrorCode, EngineEvent, EngineEventKind, GroupOp};

use crate::commands::StatsSnapshotItem;
use crate::exec_sessions::{ExecEndReason, ExecFeed};
use crate::pull_feed::{PullFeed, PullOutcome};
use crate::shell::{AppFeed, BusySummary, TrayStatus};
use crate::streams::{EndReason, EngineFeed, LogFeed, StatsFeed};

include!("command_names.rs");

/// Versión del formato del archivo (subir si cambia su estructura, no su contenido).
const FORMAT_VERSION: u32 = 1;

const FIXTURES_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/contract/fixtures.json");

const SUB_ID: &str = "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3c";
const TICKET: &str = "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d";
const CID: &str = "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30";

/// Pasa un literal por el tipo Rust real y devuelve su serialización canónica.
fn typed<T: Serialize + DeserializeOwned>(v: Value) -> Value {
    let t: T = serde_json::from_value(v.clone()).unwrap_or_else(|e| {
        panic!(
            "el literal no encaja en {}: {e}\n{v}",
            std::any::type_name::<T>()
        )
    });
    serde_json::to_value(t).expect("serializa")
}

/// Igual para listas.
fn typed_vec<T: Serialize + DeserializeOwned>(items: Vec<Value>) -> Value {
    Value::Array(items.into_iter().map(typed::<T>).collect())
}

/// Serializa un valor construido directamente.
fn ser<T: Serialize>(t: &T) -> Value {
    serde_json::to_value(t).expect("serializa")
}

/// Enum de solo variantes unitarias: lista de valores con `match` sin comodín.
macro_rules! unit_enum {
    ($ty:path : $($v:ident),+ $(,)?) => {{
        #[allow(dead_code)]
        fn guard(x: $ty) {
            #[allow(unused_imports)]
            use $ty as E;
            match x { $(E::$v => {}),+ }
        }
        #[allow(unused_imports)]
        use $ty as E;
        let values: Vec<$ty> = vec![$(E::$v),+];
        values
    }};
}

/// Enum con datos: cada literal debe deserializar EXACTAMENTE en la variante indicada, y el
/// `match` sin comodín obliga a listar todas.
macro_rules! data_enum {
    ($ty:ty : $($pat:pat => $lit:expr),+ $(,)?) => {{
        #[allow(dead_code)]
        fn guard(x: &$ty) {
            match x { $($pat => {}),+ }
        }
        let items: Vec<Value> = vec![$({
            let v = typed::<$ty>($lit);
            let parsed: $ty = serde_json::from_value(v.clone()).expect("ida y vuelta");
            assert!(matches!(&parsed, $pat), "el literal no es la variante {}", stringify!($pat));
            v
        }),+];
        items
    }};
}

fn names<T: Serialize>(values: &[T]) -> Value {
    Value::Array(values.iter().map(ser).collect())
}

/// Marca de un argumento que en la webview es un `Channel<T>` (no serializable a JSON).
fn channel(feed: &str) -> Value {
    json!({ "$channel": feed })
}

fn container() -> Value {
    json!({
        "id": CID, "names": ["web"], "image": "nginx:1.27", "image_id": "sha256:aa11",
        "state": "running", "status": "Up 3 hours", "created": 1727300000,
        "compose_project": "shop", "compose_service": "web",
        "ports": [
            {"ip": "0.0.0.0", "private_port": 80, "public_port": 8080, "protocol": "tcp"},
            {"ip": null, "private_port": 443, "public_port": null, "protocol": "tcp"}
        ],
        "mounts": [
            {"kind": "volume", "name": "data", "source": "/var/lib/docker/volumes/data/_data",
             "destination": "/data", "read_write": true},
            {"kind": "bind", "name": null, "source": "/srv/conf", "destination": "/etc/conf",
             "read_write": false}
        ],
        "networks": ["shop_default"],
        "endpoints": [{"name": "shop_default", "ip_address": "172.18.0.2", "ipv6_address": null,
                       "gateway": "172.18.0.1", "mac_address": "02:42:ac:12:00:02",
                       "aliases": ["web"]}]
    })
}

fn container_bare() -> Value {
    json!({
        "id": "b2", "names": ["job"], "image": "alpine", "image_id": "sha256:bb22",
        "state": "exited", "status": "Exited (1) 2 minutes ago", "created": 0,
        "compose_project": null, "compose_service": null,
        "ports": [], "mounts": [], "networks": []
    })
}

fn volume() -> Value {
    json!({"name": "data", "driver": "local", "mountpoint": "/var/lib/docker/volumes/data/_data",
           "created_at": "2025-01-02T03:04:05Z", "labels": {"com.docker.compose.project": "shop"},
           "compose_project": "shop", "size_bytes": 4096, "used_by": ["web"], "anonymous": false})
}

fn network() -> Value {
    json!({"id": "n1", "name": "shop_default", "driver": "bridge", "scope": "local",
           "subnets": ["172.18.0.0/16"], "internal": false, "system": false,
           "connected": ["web"], "compose_project": "shop"})
}

fn engine_info() -> Value {
    json!({"version": "27.3.1", "api_version": "1.47", "os": "linux", "arch": "amd64"})
}

fn api_error() -> Value {
    json!({"code": "conflict", "message": "recurso en uso", "cause": null})
}

fn stack_summary() -> Value {
    json!({
        "name": "shop", "origin": "managed", "path": "/home/u/.local/share/dockinng/stacks/shop",
        "config_files": ["compose.yaml"], "working_dir": null, "editable": true,
        "status": "partial", "containers": 2, "running": 1,
        "services": [{"name": "web", "image": "nginx:1.27", "state": "running",
                      "replicas": "1/1", "running": 1, "total": 1}]
    })
}

fn stack_files() -> Value {
    json!({"name": "shop", "origin": "managed", "yaml": "services: {}\n", "env": "A=1\n",
           "path": "/x/compose.yaml", "env_path": "/x/.env", "editable": true,
           "config_files": ["/x/compose.yaml"], "revision": "sha256:cc33"})
}

fn conn_spec_ssh() -> Value {
    json!({"kind": "ssh", "name": "srv", "host": "10.0.0.5", "port": 22, "user": "deploy",
           "mode": "explicit", "identity": {"type": "agent"}})
}

fn profile() -> Value {
    json!({"id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3e", "kind": "ssh", "name": "srv",
           "host": "10.0.0.5", "port": 22, "user": "deploy", "mode": "alias",
           "identity": {"type": "file", "path": "/home/u/.ssh/id_ed25519"},
           "remote": true, "host_key_fp": "SHA256:abc", "simulated": false})
}

fn groups_snapshot() -> Value {
    json!({"groups": [{"id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b40", "name": "Web", "hue": 210}],
           "assignments": [{"connection_id": "local", "container_name": "web",
                            "group_id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b40"}],
           "stack_hues": {"shop": 120}, "legacy_imported": true})
}

fn create_spec() -> Value {
    json!({"image": "nginx:1.27", "name": "web",
           "ports": [{"host_ip": "127.0.0.1", "host_port": 8080, "container_port": 80,
                      "protocol": "tcp"}],
           "volumes": [{"source": "data", "target": "/data", "read_only": false}],
           "env": [{"key": "MODE", "value": "prod"}], "network": null,
           "restart": "unless-stopped", "restart_max_retries": null, "command": null,
           "labels": {"team": "a"}})
}

fn build_spec() -> Value {
    json!({"context_dir": "/home/u/app", "dockerfile": "Dockerfile", "tag": "app:dev",
           "build_args": [["VERSION", "1"]], "target": null, "no_cache": false, "pull": true})
}

fn stats() -> ContainerStats {
    serde_json::from_value(json!({
        "read_at": "2025-01-02T03:04:05Z", "cpu_percent": 12.5, "mem_used_bytes": 1048576,
        "mem_limit_bytes": 2097152, "mem_percent": 50.0, "net_rx_bytes": 10, "net_tx_bytes": 20,
        "net_rx_bytes_per_sec": 1.5, "net_tx_bytes_per_sec": 2.5, "block_read_bytes": 3,
        "block_write_bytes": 4, "pids": 7
    }))
    .expect("estadísticas")
}

fn conn_status_connected() -> Value {
    typed::<ConnectionStatus>(json!({
        "state": "connected", "endpoint": "unix:///var/run/docker.sock",
        "server": engine_info()
    }))
}

fn conn_status_failed() -> Value {
    typed::<ConnectionStatus>(json!({
        "state": "failed", "endpoint": "unix:///var/run/docker.sock", "cause": "socket_missing",
        "message": "no existe el socket",
        "steps": [{"id": "socket", "status": "fail", "detail": "ausente"},
                  {"id": "permissions", "status": "skipped", "detail": ""}]
    }))
}

// --- enums ---

fn enums() -> Map<String, Value> {
    use engine_core::actions::{ItemKind, PlanDenyReason};
    use engine_core::build::{BuildOutcome, BuildStream};
    use engine_core::cleanup::{CleanupCategoryId, CleanupRisk, SizeEstimate};
    use engine_core::connection::{DiagStepId, StepStatus};
    use engine_core::connections::{HostKeyState, SshMode};
    use engine_core::create::{PortProtocol, RestartPolicy};
    use engine_core::model::{ContainerState, MountKind};
    use engine_core::pull::LayerPhase;
    use engine_core::stacks::{
        ComposeFlavor, IssueKind, ProgressKind, ProgressStatus, ServicePhase, StackOrigin,
        StackStatus,
    };

    let mut m = Map::new();
    let mut put = |name: &str, v: Value| {
        m.insert(name.to_string(), v);
    };
    put("ApiErrorCode", names(&api_error_codes()));
    put("ConnectionCause", names(&connection_causes()));
    put(
        "ContainerState",
        names(
            &unit_enum!(ContainerState: Created, Running, Paused, Restarting, Removing,
            Stopping, Exited, Dead, Unknown),
        ),
    );
    put(
        "MountKind",
        names(&unit_enum!(MountKind: Volume, Bind, Tmpfs, Other)),
    );
    put(
        "ItemKind",
        names(&unit_enum!(ItemKind: Container, Image, Volume, Network, Stack)),
    );
    put(
        "PlanDenyReason",
        names(&unit_enum!(PlanDenyReason: Forbidden, NeedsConfirmationNonInteractive)),
    );
    put(
        "StepStatus",
        names(&unit_enum!(StepStatus: Ok, Fail, Skipped)),
    );
    put(
        "DiagStepId",
        names(&unit_enum!(DiagStepId: Socket, Permissions, Daemon)),
    );
    put(
        "EngineEventKind",
        names(&unit_enum!(EngineEventKind: Container, Image, Volume, Network, Daemon, Other)),
    );
    put(
        "LogStream",
        names(&unit_enum!(LogStream: Stdout, Stderr, Console)),
    );
    put(
        "StackOrigin",
        names(&unit_enum!(StackOrigin: Managed, Linked, Discovered)),
    );
    put(
        "StackStatus",
        names(&unit_enum!(StackStatus: Running, Partial, Stopped, Declared)),
    );
    put(
        "ComposeFlavor",
        names(&unit_enum!(ComposeFlavor: Plugin, Standalone, Missing)),
    );
    put(
        "IssueKind",
        names(&unit_enum!(IssueKind: Syntax, Schema, Interpolation, Other)),
    );
    put(
        "ProgressKind",
        names(&unit_enum!(ProgressKind: Network, Container, Volume, Image, Service, Other)),
    );
    put(
        "ProgressStatus",
        names(&unit_enum!(ProgressStatus: Working, Done, Warning, Error)),
    );
    put(
        "ServicePhase",
        names(&unit_enum!(ServicePhase: Waiting, Pulling, Creating, Started)),
    );
    put("StackOutcome", names(&stack_outcomes()));
    put(
        "LayerPhase",
        names(&unit_enum!(LayerPhase: Waiting, Downloading, Downloaded, Extracting, Complete)),
    );
    put(
        "BuildStream",
        names(&unit_enum!(BuildStream: Stdout, Stderr)),
    );
    put(
        "BuildOutcome",
        names(&unit_enum!(BuildOutcome: Ok, Failed, Canceled)),
    );
    put(
        "CleanupCategoryId",
        names(
            &unit_enum!(CleanupCategoryId: StoppedContainers, DanglingImages, UnusedImages,
            UnusedVolumes, UnusedNetworks, BuildCache),
        ),
    );
    put(
        "SizeEstimate",
        names(&unit_enum!(SizeEstimate: Exact, UpperBound, Unknown)),
    );
    put(
        "CleanupRisk",
        names(&unit_enum!(CleanupRisk: Low, Medium, High)),
    );
    put("SshMode", names(&unit_enum!(SshMode: Explicit, Alias)));
    put(
        "HostKeyState",
        names(&unit_enum!(HostKeyState: Unknown, Trusted, Changed)),
    );
    put("PortProtocol", names(&unit_enum!(PortProtocol: Tcp, Udp)));
    put(
        "RestartPolicy",
        names(&unit_enum!(RestartPolicy: No, Always, UnlessStopped, OnFailure)),
    );
    put("EndReason", names(&end_reasons()));
    put("ExecEndReason", names(&exec_end_reasons()));
    put("PullOutcome", names(&pull_outcomes()));
    m
}

fn api_error_codes() -> Vec<ApiErrorCode> {
    unit_enum!(ApiErrorCode: Connection, NotFound, Conflict, InvalidInput, Engine, Timeout,
        PolicyDenied, TicketInvalid, TicketExpired, TypedMismatch, StateChanged, NotImplemented,
        Internal, ComposeMissing, ComposeFailed, InvalidCompose, ImageMissing, AuthRequired,
        RegistryUnreachable, NoShell)
}

fn connection_causes() -> Vec<ConnectionCause> {
    unit_enum!(ConnectionCause: SocketMissing, PermissionDenied, DaemonDown, Other,
        HostKeyUnknown, HostKeyChanged, AuthFailed, Unreachable, RemoteDockerMissing, TlsInvalid)
}

fn end_reasons() -> Vec<EndReason> {
    unit_enum!(EndReason: Eof, ContainerStopped, Error, Internal)
}

fn exec_end_reasons() -> Vec<ExecEndReason> {
    unit_enum!(ExecEndReason: ProcessExited, ContainerStopped, Closed, NoShell, Error, Internal)
}

fn pull_outcomes() -> Vec<PullOutcome> {
    unit_enum!(PullOutcome: Done, Error)
}

fn stack_outcomes() -> Vec<engine_core::stacks::StackOutcome> {
    use engine_core::stacks::StackOutcome;
    unit_enum!(StackOutcome: Success, Failed, Canceled, Timeout)
}

// --- enums con datos ---

fn types() -> Map<String, Value> {
    use engine_core::connections::SshIdentity;
    let mut m = Map::new();
    let mut put = |name: &str, v: Vec<Value>| {
        m.insert(name.to_string(), Value::Array(v));
    };
    put(
        "ActionRequest",
        data_enum!(ActionRequest:
            ActionRequest::RemoveContainers { .. } => json!({"type": "remove_containers", "ids": [CID]}),
            ActionRequest::RemoveImage { .. } => json!({"type": "remove_image", "reference": "nginx:1.27"}),
            ActionRequest::PruneImages => json!({"type": "prune_images"}),
            ActionRequest::RemoveVolume { .. } => json!({"type": "remove_volume", "name": "data"}),
            ActionRequest::PruneVolumes => json!({"type": "prune_volumes"}),
            ActionRequest::RemoveNetwork { .. } => json!({"type": "remove_network", "id": "n1"}),
            ActionRequest::StackDown { .. } => json!({"type": "stack_down", "project": "shop"}),
            ActionRequest::StackDelete { .. } => json!({"type": "stack_delete", "name": "shop"}),
            ActionRequest::Cleanup { .. } => json!({"type": "cleanup", "selection":
                {"containers": ["b2"], "images": [], "volumes": ["data"], "networks": []}}),
            ActionRequest::PruneSystem => json!({"type": "prune_system"}),
        ),
    );
    put(
        "PlanDecision",
        data_enum!(PlanDecision:
            PlanDecision::Allow => json!({"type": "allow"}),
            PlanDecision::Confirm => json!({"type": "confirm"}),
            PlanDecision::ConfirmTyped { .. } => json!({"type": "confirm_typed", "expected": "ELIMINAR"}),
            PlanDecision::Deny { .. } => json!({"type": "deny", "reason": "forbidden"}),
        ),
    );
    put(
        "PlanWarning",
        data_enum!(PlanWarning:
            PlanWarning::RunningForce { .. } => json!({"type": "running_force", "count": 2}),
            PlanWarning::VolumesKept { .. } => json!({"type": "volumes_kept", "items": ["data"]}),
            PlanWarning::BindMountsKept { .. } => json!({"type": "bind_mounts_kept", "items": ["/srv"]}),
            PlanWarning::InUse { .. } => json!({"type": "in_use", "count": 1}),
            PlanWarning::Skipped { .. } => json!({"type": "skipped", "items": ["x"]}),
        ),
    );
    put(
        "CreateWarning",
        data_enum!(CreateWarning:
            CreateWarning::SensitiveBind { .. } => json!({"type": "sensitive_bind", "source": "/etc", "reason": "sistema"}),
            CreateWarning::DockerSocket => json!({"type": "docker_socket"}),
            CreateWarning::HostNetwork => json!({"type": "host_network"}),
            CreateWarning::PortInUse { .. } => json!({"type": "port_in_use", "port": 8080, "by": "otro"}),
            CreateWarning::PublishedAllInterfaces { .. } => json!({"type": "published_all_interfaces", "port": 80}),
            CreateWarning::RemoteBind { .. } => json!({"type": "remote_bind", "source": "/srv"}),
        ),
    );
    put(
        "BuildWarning",
        data_enum!(BuildWarning:
            BuildWarning::SensitiveContext { .. } => json!({"type": "sensitive_context", "path": "/home/u"}),
            BuildWarning::SecretLikeArg { .. } => json!({"type": "secret_like_arg", "name": "TOKEN"}),
        ),
    );
    put(
        "StackRisk",
        data_enum!(StackRisk:
            StackRisk::Privileged => json!({"type": "privileged"}),
            StackRisk::HostNetwork => json!({"type": "host_network"}),
            StackRisk::DockerSock => json!({"type": "docker_sock"}),
            StackRisk::SensitiveBind { .. } => json!({"type": "sensitive_bind", "path": "/etc"}),
            StackRisk::PidHost => json!({"type": "pid_host"}),
            StackRisk::CapAddSysAdmin => json!({"type": "cap_add_sys_admin"}),
            StackRisk::RemoteBind { .. } => json!({"type": "remote_bind", "path": "/srv"}),
        ),
    );
    put(
        "StackOp",
        data_enum!(StackOp:
            StackOp::Up { .. } => json!({"type": "up", "services": null}),
            StackOp::Restart { .. } => json!({"type": "restart", "services": ["web"]}),
            StackOp::Stop { .. } => json!({"type": "stop", "services": null}),
            StackOp::Start { .. } => json!({"type": "start", "services": null}),
            StackOp::Pull { .. } => json!({"type": "pull", "services": ["web", "db"]}),
        ),
    );
    put(
        "GroupOp",
        data_enum!(GroupOp:
            GroupOp::CreateGroup { .. } => json!({"type": "create_group", "name": "Web", "hue": 210}),
            GroupOp::RenameGroup { .. } => json!({"type": "rename_group", "id": TICKET, "name": "Web2"}),
            GroupOp::SetGroupHue { .. } => json!({"type": "set_group_hue", "id": TICKET, "hue": 30}),
            GroupOp::DeleteGroup { .. } => json!({"type": "delete_group", "id": TICKET}),
            GroupOp::Assign { .. } => json!({"type": "assign", "connection_id": "local",
                "names": ["web"], "group_id": null}),
            GroupOp::SetStackHue { .. } => json!({"type": "set_stack_hue", "project": "shop", "hue": null}),
            GroupOp::PruneAssignments { .. } => json!({"type": "prune_assignments", "connection_id": "local",
                "live_names": ["web"]}),
        ),
    );
    put(
        "ConnSpec",
        data_enum!(ConnSpec:
            ConnSpec::Ssh { .. } => conn_spec_ssh(),
            ConnSpec::Tls { .. } => json!({"kind": "tls", "name": "tls", "host": "docker.lan",
                "port": 2376, "ca_path": "/c/ca.pem", "cert_path": "/c/cert.pem",
                "key_path": "/c/key.pem"}),
        ),
    );
    put(
        "SshIdentity",
        data_enum!(SshIdentity:
            SshIdentity::Agent => json!({"type": "agent"}),
            SshIdentity::File { .. } => json!({"type": "file", "path": "/home/u/.ssh/id"}),
        ),
    );
    put(
        "ConnectionStatus",
        data_enum!(ConnectionStatus:
            ConnectionStatus::Connected { .. } => json!({"state": "connected", "endpoint": "unix:///var/run/docker.sock", "server": engine_info()}),
            ConnectionStatus::Failed { .. } => json!({"state": "failed", "endpoint": "ssh://deploy@10.0.0.5", "cause": "host_key_changed", "message": "la clave cambió", "steps": []}),
        ),
    );
    m
}

// --- errores ---

fn api_errors() -> Value {
    let mut by_code = Map::new();
    for code in api_error_codes() {
        let e = ApiError::new(code, format!("mensaje de {code:?}"));
        by_code.insert(ser(&code).as_str().expect("código").to_string(), ser(&e));
    }
    let mut by_cause = Map::new();
    for cause in connection_causes() {
        let mut e = ApiError::new(ApiErrorCode::Connection, "sin conexión");
        e.cause = Some(cause);
        by_cause.insert(ser(&cause).as_str().expect("causa").to_string(), ser(&e));
    }
    // `quiesced` solo se serializa cuando es verdadero (`skip_serializing_if`).
    let mut quiesced = ApiError::new(ApiErrorCode::Conflict, "cambio de conexión en curso");
    quiesced.quiesced = true;
    json!({
        "by_code": by_code,
        "by_cause": by_cause,
        "quiesced": ser(&quiesced),
    })
}

// --- feeds ---

fn engine_event(kind: EngineEventKind, action: &str) -> EngineEvent {
    EngineEvent {
        kind,
        action: action.into(),
        id: CID.into(),
        name: Some("web".into()),
        time_nano: 1_727_300_000_000_000_000,
        attributes: BTreeMap::from([("exitCode".to_string(), "1".to_string())]),
    }
}

fn feeds() -> Value {
    let api = || -> ApiError { serde_json::from_value(api_error()).expect("error") };
    let status_ok: ConnectionStatus = serde_json::from_value(conn_status_connected()).unwrap();
    let status_bad: ConnectionStatus = serde_json::from_value(conn_status_failed()).unwrap();

    let mut engine: Vec<EngineFeed> = vec![
        EngineFeed::Events {
            items: vec![
                engine_event(EngineEventKind::Container, "die"),
                engine_event(EngineEventKind::Image, "pull"),
            ],
            resync: false,
        },
        EngineFeed::Events {
            items: vec![],
            resync: true,
        },
        EngineFeed::Connection { status: status_ok },
        EngineFeed::Connection { status: status_bad },
    ];
    for reason in end_reasons() {
        engine.push(EngineFeed::Ended { reason });
    }
    // Exhaustividad: un caso por variante.
    for f in &engine {
        match f {
            EngineFeed::Events { .. }
            | EngineFeed::Connection { .. }
            | EngineFeed::Ended { .. } => {}
        }
    }

    let line = |stream, msg: &str, ts: Option<&str>| LogLine {
        stream,
        timestamp: ts.map(String::from),
        message: msg.into(),
        truncated: false,
    };
    let mut logs = vec![LogFeed::Lines {
        lines: vec![
            line(LogStream::Stdout, "listo", Some("2025-01-02T03:04:05Z")),
            line(LogStream::Stderr, "aviso", None),
            line(LogStream::Console, "tty", None),
        ],
        dropped: 3,
    }];
    for reason in end_reasons() {
        logs.push(LogFeed::Ended {
            reason,
            error: (reason == EndReason::Error).then(api),
        });
    }
    for f in &logs {
        match f {
            LogFeed::Lines { .. } | LogFeed::Ended { .. } => {}
        }
    }

    let mut stats_feed = vec![StatsFeed::Sample { stats: stats() }];
    for reason in end_reasons() {
        stats_feed.push(StatsFeed::Ended {
            reason,
            error: (reason == EndReason::Error).then(api),
        });
    }
    for f in &stats_feed {
        match f {
            StatsFeed::Sample { .. } | StatsFeed::Ended { .. } => {}
        }
    }

    let mut exec = vec![
        ExecFeed::Opened {
            shell: "/bin/sh".into(),
            risk: serde_json::from_value(json!({"privileged": true, "docker_socket": false,
                "host_pid": false, "host_network": true}))
            .unwrap(),
        },
        ExecFeed::Output {
            data: "aG9sYQ==".into(),
        },
    ];
    for reason in exec_end_reasons() {
        exec.push(ExecFeed::Ended {
            reason,
            exit_code: (reason == ExecEndReason::ProcessExited).then_some(0),
            error: (reason == ExecEndReason::Error).then(api),
        });
    }
    for f in &exec {
        match f {
            ExecFeed::Opened { .. } | ExecFeed::Output { .. } | ExecFeed::Ended { .. } => {}
        }
    }

    let layer = |phase: &str| -> engine_core::LayerProgress {
        serde_json::from_value(json!({"id": "l1", "phase": phase, "total": 100, "done": 50}))
            .expect("capa")
    };
    let mut pull = vec![
        PullFeed::Started {
            reference: "nginx:latest".into(),
        },
        PullFeed::Progress {
            layers: vec![layer("downloading"), layer("complete")],
            done_bytes: 100,
            total_bytes: 200,
        },
    ];
    for outcome in pull_outcomes() {
        pull.push(PullFeed::Ended {
            outcome,
            up_to_date: outcome == PullOutcome::Done,
            digest: (outcome == PullOutcome::Done).then(|| "sha256:dd44".to_string()),
            error: (outcome == PullOutcome::Error).then(api),
        });
    }
    for f in &pull {
        match f {
            PullFeed::Started { .. } | PullFeed::Progress { .. } | PullFeed::Ended { .. } => {}
        }
    }

    let progress_item: engine_core::stacks::ProgressItem = serde_json::from_value(json!({
        "id": "Container shop-web-1", "kind": "container", "name": "shop-web-1",
        "status": "working", "text": "Starting", "details": null, "current": null,
        "total": null, "percent": null, "parent_id": null
    }))
    .expect("progreso");
    let progress_item_full: engine_core::stacks::ProgressItem = serde_json::from_value(json!({
        "id": "layer1", "kind": "image", "name": "nginx", "status": "done", "text": "Pulled",
        "details": "ok", "current": 5, "total": 10, "percent": 50.0, "parent_id": "Image nginx"
    }))
    .expect("progreso");
    let service_progress: engine_core::stacks::ServiceProgress =
        serde_json::from_value(json!({"name": "web", "percent": 80, "phase": "pulling"}))
            .expect("servicio");
    let issue: engine_core::stacks::ValidationIssue = serde_json::from_value(
        json!({"line": 3, "column": null, "kind": "schema", "message": "campo desconocido"}),
    )
    .expect("issue");
    let mut stack_op = vec![
        StackOpFeed::Started {
            op: "up".into(),
            stack: "shop".into(),
            compose_version: "2.29.7".into(),
        },
        StackOpFeed::Progress {
            items: vec![progress_item, progress_item_full],
            services: vec![service_progress],
        },
        StackOpFeed::Log {
            text: "Container shop-web-1 Started".into(),
        },
    ];
    for outcome in stack_outcomes() {
        let failed = outcome == engine_core::stacks::StackOutcome::Failed;
        stack_op.push(StackOpFeed::Ended {
            outcome,
            exit_code: Some(i32::from(failed)),
            error: failed.then(api),
            issues: if failed { vec![issue.clone()] } else { vec![] },
        });
    }
    for f in &stack_op {
        match f {
            StackOpFeed::Started { .. }
            | StackOpFeed::Progress { .. }
            | StackOpFeed::Log { .. }
            | StackOpFeed::Ended { .. } => {}
        }
    }

    let mut build: Vec<Value> = data_enum!(BuildFeed:
        BuildFeed::Line { .. } => json!({"type": "line", "text": "Step 1/3", "stream": "stdout"}),
        BuildFeed::Lines { .. } => json!({"type": "lines", "lines": [
            {"text": "a", "stream": "stdout"}, {"text": "b", "stream": "stderr"}]}),
        BuildFeed::Step { .. } => json!({"type": "step", "n": 1, "total": 3}),
        BuildFeed::Ended { .. } => json!({"type": "ended", "outcome": "ok",
            "image_id": "sha256:ee55", "error": null}),
    );
    build.push(typed::<BuildFeed>(
        json!({"type": "ended", "outcome": "failed",
        "image_id": null, "error": api_error()}),
    ));
    build.push(typed::<BuildFeed>(
        json!({"type": "ended", "outcome": "canceled",
        "image_id": null, "error": null}),
    ));

    let app = vec![
        AppFeed::QuitRequested {
            summary: BusySummary {
                stacks: 1,
                pulls: 0,
                builds: 1,
                terminals: 2,
            },
        },
        AppFeed::WindowVisibility { visible: false },
        AppFeed::WindowVisibility { visible: true },
    ];
    for f in &app {
        match f {
            AppFeed::QuitRequested { .. } | AppFeed::WindowVisibility { .. } => {}
        }
    }

    json!({
        "EngineFeed": ser(&engine),
        "LogFeed": ser(&logs),
        "StatsFeed": ser(&stats_feed),
        "ExecFeed": ser(&exec),
        "PullFeed": ser(&pull),
        "StackOpFeed": ser(&stack_op),
        "BuildFeed": build,
        "AppFeed": ser(&app),
    })
}

// --- comandos ---

struct Commands(BTreeMap<String, Value>);

impl Commands {
    /// `args`: los argumentos tal y como los envía la webview (camelCase; `Channel` marcado con
    /// `{"$channel": "<Feed>"}`). `result_type`: tipo del resultado con nombres de Rust
    /// (`T[]` = lista, `T | null` = opcional). `result`: valor real (`null` para `()`).
    fn add(&mut self, name: &str, args: Value, result_type: &str, result: Value) {
        assert!(args.is_object(), "{name}: args debe ser un objeto");
        let prev = self.0.insert(
            name.to_string(),
            json!({"args": args, "result_type": result_type, "result": result}),
        );
        assert!(prev.is_none(), "comando repetido: {name}");
    }
}

fn commands() -> Value {
    let mut c = Commands(BTreeMap::new());
    let unit = Value::Null;

    // --- conexión y lecturas ---
    c.add(
        "connection_status",
        json!({}),
        "ConnectionStatus",
        conn_status_connected(),
    );
    c.add(
        "reconnect",
        json!({}),
        "ConnectionStatus",
        conn_status_failed(),
    );
    c.add(
        "list_containers",
        json!({"all": true}),
        "Container[]",
        typed_vec::<engine_core::Container>(vec![container(), container_bare()]),
    );
    let detail = typed::<engine_core::ContainerDetail>(json!({
        "summary": container(), "created_at": "2025-01-02T03:04:05Z", "ip_address": "172.18.0.2",
        "started_at": "2025-01-02T03:04:06Z", "finished_at": null, "exit_code": null,
        "pid": 4242, "oom_killed": false, "restart_count": 1, "error": null, "tty": false,
        "restart_policy": "unless-stopped", "memory_limit_bytes": 536870912, "cpu_limit": 1.5,
        "networks": [{"name": "shop_default", "ip_address": "172.18.0.2", "ipv6_address": null,
                      "gateway": "172.18.0.1", "mac_address": null, "aliases": []}],
        "raw": {"Id": CID, "State": {"Status": "running"}}
    }));
    c.add(
        "inspect_container",
        json!({"id": CID}),
        "ContainerDetail",
        detail,
    );
    let snapshot = vec![
        StatsSnapshotItem {
            id: CID.into(),
            stats: Some(stats()),
            error: None,
        },
        StatsSnapshotItem {
            id: "b2".into(),
            stats: None,
            error: Some(serde_json::from_value(api_error()).unwrap()),
        },
    ];
    c.add(
        "container_stats_snapshot",
        json!({"ids": [CID, "b2"]}),
        "StatsSnapshotItem[]",
        ser(&snapshot),
    );
    c.add(
        "list_images",
        json!({}),
        "Image[]",
        typed_vec::<engine_core::Image>(vec![
            json!({"id": "sha256:aa11", "reference": "nginx:1.27", "repository": "nginx",
                   "tag": "1.27", "size_bytes": 190000000, "created": 1727300000,
                   "containers": 1, "dangling": false}),
            json!({"id": "sha256:bb22", "reference": "<none>:<none>", "repository": "<none>",
                   "tag": "<none>", "size_bytes": 5000, "created": 0, "containers": 0,
                   "dangling": true}),
        ]),
    );
    c.add(
        "list_volumes",
        json!({}),
        "Volume[]",
        typed_vec::<engine_core::Volume>(vec![volume()]),
    );
    c.add(
        "list_networks",
        json!({}),
        "Network[]",
        typed_vec::<engine_core::Network>(vec![network()]),
    );
    c.add(
        "system_usage",
        json!({}),
        "SystemUsage",
        typed::<engine_core::SystemUsage>(json!({
            "host": {"cpu_count": 8, "mem_total_bytes": 17179869184u64},
            "disk": {"images": {"total_bytes": 1000, "reclaimable_bytes": 500},
                     "containers": {"total_bytes": null, "reclaimable_bytes": null},
                     "volumes": {"total_bytes": 10, "reclaimable_bytes": 0},
                     "build_cache": {"total_bytes": 0, "reclaimable_bytes": 0}},
            "container_disk": [{"id": CID, "size_rw_bytes": 2048}],
            "disk_known": true
        })),
    );
    c.add(
        "gpu_status",
        json!({}),
        "GpuInfo[]",
        typed_vec::<engine_core::GpuInfo>(vec![
            json!({"index": 0, "name": "NVIDIA RTX", "utilization_percent": 37.5,
                   "mem_used_bytes": 1024, "mem_total_bytes": 8192, "temperature_c": 60}),
            json!({"index": 1, "name": "NVIDIA T4", "utilization_percent": 0.0,
                   "mem_used_bytes": 0, "mem_total_bytes": 4096, "temperature_c": null}),
        ]),
    );
    for name in ["start_container", "stop_container", "restart_container"] {
        c.add(name, json!({"id": CID}), "void", unit.clone());
    }

    // --- acciones con plan ---
    let plan = typed::<ActionPlan>(json!({
        "decision": {"type": "confirm_typed", "expected": "ELIMINAR"}, "ticket": TICKET,
        "expires_in_secs": 60,
        "affected": [
            {"kind": "container", "id": CID, "name": "web", "state": "running",
             "size_bytes": 2048, "detail": "imagen nginx"},
            {"kind": "volume", "id": "data", "name": "data", "state": null,
             "size_bytes": null, "detail": null}
        ],
        "warnings": [{"type": "running_force", "count": 1},
                     {"type": "volumes_kept", "items": ["data"]}],
        "total_size_bytes": 2048
    }));
    c.add(
        "plan_action",
        json!({"request": {"type": "remove_containers", "ids": [CID]}}),
        "ActionPlan",
        plan,
    );
    c.add(
        "execute_action",
        json!({"ticket": TICKET, "typed": "ELIMINAR"}),
        "ActionOutcome",
        typed::<engine_core::ActionOutcome>(json!({
            "succeeded": [{"kind": "container", "id": CID, "name": "web"}],
            "failed": [{"item": {"kind": "volume", "id": "data", "name": "data"},
                        "error": api_error()}],
            "freed_bytes": 4096
        })),
    );
    c.add(
        "cancel_action",
        json!({"ticket": TICKET}),
        "void",
        unit.clone(),
    );

    // --- suscripciones ---
    let sub = || json!(SUB_ID);
    c.add(
        "subscribe_engine_events",
        json!({"onEvent": channel("EngineFeed")}),
        "string",
        sub(),
    );
    c.add(
        "subscribe_logs",
        json!({"id": CID, "tail": 200, "follow": true, "onEvent": channel("LogFeed")}),
        "string",
        sub(),
    );
    c.add(
        "subscribe_stats",
        json!({"id": CID, "onEvent": channel("StatsFeed")}),
        "string",
        sub(),
    );
    c.add(
        "unsubscribe",
        json!({"subscriptionId": SUB_ID}),
        "void",
        unit.clone(),
    );
    c.add("reset_subscriptions", json!({}), "void", unit.clone());

    // --- stacks ---
    c.add(
        "compose_info",
        json!({"recheck": false}),
        "ComposeInfo",
        typed::<engine_core::stacks::ComposeInfo>(json!({
            "available": true, "flavor": "plugin", "version": "2.29.7", "supported": true,
            "docker_cli": true
        })),
    );
    c.add(
        "list_stacks",
        json!({}),
        "StackSummary[]",
        typed_vec::<engine_core::stacks::StackSummary>(vec![stack_summary()]),
    );
    let files = typed::<engine_core::stacks::StackFiles>(stack_files());
    c.add(
        "stack_read",
        json!({"name": "shop"}),
        "StackFiles",
        files.clone(),
    );
    c.add(
        "stack_save",
        json!({"name": "shop", "yaml": "services: {}\n", "env": "A=1\n",
               "expectedRevision": "sha256:cc33"}),
        "StackFiles",
        files,
    );
    c.add(
        "stack_validate",
        json!({"name": "shop", "yaml": "services: {}\n", "env": ""}),
        "StackValidation",
        typed::<engine_core::stacks::StackValidation>(json!({
            "ok": false,
            "issues": [{"line": 2, "column": 4, "kind": "syntax", "message": "sangría"}],
            "services": ["web"],
            "risks": [{"type": "privileged"}, {"type": "sensitive_bind", "path": "/etc"}]
        })),
    );
    let summary = typed::<engine_core::stacks::StackSummary>(stack_summary());
    c.add(
        "stack_create",
        json!({"name": "shop", "yaml": "services: {}\n", "env": ""}),
        "StackSummary",
        summary.clone(),
    );
    c.add(
        "stack_link",
        json!({"path": "/home/u/shop/compose.yaml"}),
        "StackSummary",
        summary,
    );
    c.add(
        "stack_unlink",
        json!({"name": "shop"}),
        "void",
        unit.clone(),
    );
    c.add(
        "run_stack_op",
        json!({"name": "shop", "op": {"type": "up", "services": null},
               "onEvent": channel("StackOpFeed")}),
        "string",
        sub(),
    );
    c.add(
        "cancel_stack_op",
        json!({"subscriptionId": SUB_ID}),
        "void",
        unit.clone(),
    );

    // --- exec, pull, crear ---
    c.add(
        "subscribe_exec",
        json!({"id": CID, "cols": 80, "rows": 24, "onEvent": channel("ExecFeed")}),
        "string",
        sub(),
    );
    c.add(
        "exec_write",
        json!({"subscriptionId": SUB_ID, "data": "bHMK"}),
        "void",
        unit.clone(),
    );
    c.add(
        "exec_resize",
        json!({"subscriptionId": SUB_ID, "cols": 100, "rows": 30}),
        "void",
        unit.clone(),
    );
    c.add(
        "exec_close",
        json!({"subscriptionId": SUB_ID}),
        "void",
        unit.clone(),
    );
    c.add(
        "subscribe_pull",
        json!({"reference": "nginx:latest", "onEvent": channel("PullFeed")}),
        "string",
        sub(),
    );
    let spec = typed::<engine_core::CreateContainerSpec>(create_spec());
    c.add(
        "plan_create_container",
        json!({"spec": spec}),
        "CreatePlan",
        typed::<engine_core::CreatePlan>(json!({
            "ok": false,
            "field_errors": [{"field": "name", "message": "ya existe"}],
            "warnings": [{"type": "docker_socket"},
                         {"type": "port_in_use", "port": 8080, "by": "x"}],
            "decision": {"type": "confirm"}, "ticket": TICKET, "expires_in_secs": 120,
            "normalized": create_spec()
        })),
    );
    c.add(
        "create_container",
        json!({"spec": spec, "start": true, "ticket": TICKET}),
        "CreateResult",
        typed::<engine_core::CreateResult>(json!({
            "id": CID, "name": "web", "started": false, "warnings": ["aviso"],
            "start_error": api_error()
        })),
    );
    c.add(
        "create_volume",
        json!({"spec": typed::<engine_core::CreateVolumeSpec>(
            json!({"name": "data", "labels": {"a": "b"}}))}),
        "Volume",
        typed::<engine_core::Volume>(volume()),
    );
    c.add(
        "create_network",
        json!({"spec": typed::<engine_core::CreateNetworkSpec>(
            json!({"name": "lan", "internal": false, "subnet": "10.9.0.0/24",
                   "gateway": null, "labels": {}}))}),
        "Network",
        typed::<engine_core::Network>(network()),
    );

    // --- persistencia ---
    let snap = typed::<engine_core::GroupsSnapshot>(groups_snapshot());
    c.add("groups_load", json!({}), "GroupsSnapshot", snap.clone());
    c.add(
        "groups_mutate",
        json!({"op": {"type": "create_group", "name": "Web", "hue": 210}}),
        "GroupsSnapshot",
        snap,
    );
    c.add(
        "groups_import_legacy",
        json!({"payload": typed::<engine_core::LegacyGroups>(json!({
            "v": 1, "groups": [{"id": "g1", "name": "Web", "hue": 210}],
            "assign": {"local\u{0}web": "g1"}, "stackHue": {"shop": 120}}))}),
        "LegacyImportReport",
        typed::<engine_core::LegacyImportReport>(json!({
            "already_imported": false, "imported_groups": 1, "imported_assignments": 1,
            "dropped_assignments": 0, "snapshot": groups_snapshot()
        })),
    );
    c.add(
        "prefs_get",
        json!({"key": "polling"}),
        "json | null",
        json!({"ms": 5000}),
    );
    c.add(
        "prefs_set",
        json!({"key": "notify_events", "value": {"die": true, "oom": false}}),
        "void",
        unit.clone(),
    );

    // --- conexiones remotas ---
    let spec_ssh = typed::<ConnSpec>(conn_spec_ssh());
    let probe = typed::<engine_core::HostKeyProbe>(json!({
        "key_type": "ssh-ed25519", "fingerprint_sha256": "SHA256:abc", "state": "unknown"
    }));
    c.add(
        "connection_list",
        json!({}),
        "ConnectionProfile[]",
        typed_vec::<engine_core::ConnectionProfile>(vec![profile()]),
    );
    c.add(
        "connection_probe_host_key",
        json!({"spec": spec_ssh}),
        "HostKeyProbe",
        probe.clone(),
    );
    c.add(
        "connection_trust_host_key",
        json!({"spec": spec_ssh, "fingerprint": "SHA256:abc"}),
        "HostKeyProbe",
        probe,
    );
    c.add(
        "groups_export",
        json!({}),
        "string | null",
        json!("/home/usuario/dockinng-grupos.json"),
    );
    c.add(
        "connection_forget_host_key",
        json!({"spec": spec_ssh, "confirmedHost": "srv.example"}),
        "void",
        Value::Null,
    );
    c.add(
        "connection_test",
        json!({"spec": spec_ssh}),
        "ConnTestResult",
        typed::<engine_core::ConnTestResult>(json!({
            "ok": false, "server": null, "error": api_error(), "cause": "auth_failed"
        })),
    );
    c.add(
        "connection_save",
        json!({"spec": spec_ssh, "id": null}),
        "ConnectionProfile",
        typed::<engine_core::ConnectionProfile>(profile()),
    );
    c.add(
        "connection_delete",
        json!({"id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3e", "confirmed": true}),
        "void",
        unit.clone(),
    );
    c.add(
        "connection_select",
        json!({"id": "local"}),
        "ConnectionStatus",
        conn_status_connected(),
    );

    // --- registros ---
    let registry = typed::<engine_core::RegistrySummary>(
        json!({"id": TICKET, "server": "ghcr.io", "username": "ana"}),
    );
    c.add(
        "registry_list",
        json!({}),
        "RegistrySummary[]",
        Value::Array(vec![registry.clone()]),
    );
    c.add(
        "registry_save",
        json!({"server": "ghcr.io", "username": "ana", "secret": "token-de-prueba"}),
        "RegistrySummary",
        registry,
    );
    c.add(
        "registry_delete",
        json!({"id": TICKET, "confirmed": true}),
        "void",
        unit.clone(),
    );
    c.add("registry_test", json!({"id": TICKET}), "void", unit.clone());

    // --- herramientas ---
    let bspec = typed::<engine_core::BuildSpec>(build_spec());
    c.add(
        "build_plan",
        json!({"spec": bspec}),
        "BuildPlan",
        typed::<engine_core::BuildPlan>(json!({
            "warnings": [{"type": "sensitive_context", "path": "/home/u"}],
            "decision": {"type": "confirm"}, "ticket": TICKET, "expires_in_secs": 90
        })),
    );
    c.add(
        "subscribe_build",
        json!({"spec": bspec, "ticket": TICKET, "onEvent": channel("BuildFeed")}),
        "string",
        sub(),
    );
    c.add(
        "cleanup_report",
        json!({"minAgeDays": 7}),
        "CleanupReport",
        typed::<engine_core::CleanupReport>(json!({
            "categories": [{
                "id": "unused_volumes",
                "items": [{"kind": "volume", "id": "data", "name": "data", "size_bytes": 10,
                           "estimate": "upper_bound", "reason": "sin uso", "risk": "high",
                           "selected_by_default": false}],
                "reclaimable_bytes": 10, "executable": true
            }, {
                "id": "build_cache", "items": [], "reclaimable_bytes": null, "executable": false
            }],
            "total_reclaimable_bytes": 10, "unknown_count": 1, "defaults_truncated": false,
            "generated_at": "2025-01-02T03:04:05Z"
        })),
    );
    c.add(
        "podman_detect",
        json!({}),
        "PodmanCandidate[]",
        typed_vec::<engine_docker::PodmanCandidate>(vec![
            json!({"path": "/run/user/1000/podman/podman.sock", "rootless": true, "source": "xdg"}),
        ]),
    );

    // --- shell de escritorio (Ola 3) ---
    c.add(
        "open_port_in_browser",
        json!({"id": CID, "port": 8080, "scheme": "http"}),
        "void",
        unit.clone(),
    );
    c.add(
        "tray_status",
        json!({}),
        "TrayStatus",
        ser(&TrayStatus {
            available: false,
            error: Some("falta libayatana-appindicator".into()),
        }),
    );
    c.add(
        "notify_user",
        json!({"kind": "op_done", "title": "Build listo", "body": "app:dev"}),
        "void",
        unit.clone(),
    );
    c.add(
        "busy_summary",
        json!({}),
        "BusySummary",
        ser(&BusySummary {
            stacks: 1,
            pulls: 0,
            builds: 0,
            terminals: 2,
        }),
    );
    c.add(
        "quit_app",
        json!({"confirmed": false}),
        "void",
        unit.clone(),
    );
    c.add(
        "subscribe_app_events",
        json!({"onEvent": channel("AppFeed")}),
        "void",
        unit.clone(),
    );
    c.add(
        "window_set_decorations",
        json!({"enabled": false}),
        "void",
        unit.clone(),
    );
    for name in [
        "window_minimize",
        "window_toggle_maximize",
        "window_close",
        "window_start_drag",
    ] {
        c.add(name, json!({}), "void", unit.clone());
    }
    c.add(
        "window_start_resize",
        json!({"direction": "south_east"}),
        "void",
        unit,
    );

    Value::Object(c.0.into_iter().collect())
}

/// Contrato completo.
fn build_contract() -> Value {
    json!({
        "version": FORMAT_VERSION,
        "note": "Generado por `UPDATE_CONTRACT=1 cargo test -p dockinng-app contract_fixtures`. No editar a mano.",
        "commands": commands(),
        "api_errors": api_errors(),
        "feeds": feeds(),
        "enums": Value::Object(enums()),
        "types": Value::Object(types()),
    })
}

fn render() -> String {
    let mut text = serde_json::to_string_pretty(&build_contract()).expect("json");
    text.push('\n');
    text
}

// --- firmas Rust: nombres de argumentos ---

/// Módulos con comandos, leídos como texto para comparar los argumentos con la firma real.
const COMMAND_SOURCES: &[&str] = &[
    include_str!("commands.rs"),
    include_str!("commands_engine.rs"),
    include_str!("commands_open.rs"),
    include_str!("commands_remote.rs"),
    include_str!("commands_shell.rs"),
    include_str!("commands_stacks.rs"),
    include_str!("commands_store.rs"),
    include_str!("commands_tools.rs"),
    include_str!("commands_window.rs"),
];

fn snake_to_camel(s: &str) -> String {
    let mut out = String::new();
    let mut up = false;
    for c in s.chars() {
        if c == '_' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// Parámetros «de datos» (los inyectados por Tauri no cuentan) de cada `#[tauri::command]`.
fn rust_command_params() -> BTreeMap<String, BTreeSet<String>> {
    let mut out = BTreeMap::new();
    for src in COMMAND_SOURCES {
        let code = src.split("#[cfg(test)]").next().unwrap_or(src);
        for chunk in code.split("#[tauri::command]").skip(1) {
            let after_fn = chunk.split("fn ").nth(1).expect("fn");
            let name: String = after_fn
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            // Cuerpo de los paréntesis de la firma (tras los genéricos `<R: Runtime>`).
            let open = after_fn.find('(').expect("(");
            let mut depth = 0i32;
            let mut end = open;
            for (i, ch) in after_fn[open..].char_indices() {
                match ch {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            end = open + i;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let params = &after_fn[open + 1..end];
            // Comas de primer nivel (los genéricos llevan comas dentro de `<>`).
            let mut parts = Vec::new();
            let (mut d, mut cur) = (0i32, String::new());
            for ch in params.chars() {
                match ch {
                    '<' | '(' | '[' => d += 1,
                    '>' | ')' | ']' => d -= 1,
                    _ => {}
                }
                if ch == ',' && d == 0 {
                    parts.push(std::mem::take(&mut cur));
                } else {
                    cur.push(ch);
                }
            }
            parts.push(cur);
            let mut set = BTreeSet::new();
            for p in parts {
                let p = p.trim();
                let Some((pname, ptype)) = p.split_once(':') else {
                    continue;
                };
                let ptype = ptype.trim();
                if ptype.starts_with("State<")
                    || ptype.starts_with("Window<")
                    || ptype.starts_with("AppHandle<")
                {
                    continue;
                }
                set.insert(snake_to_camel(pname.trim()));
            }
            out.insert(name, set);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_fixtures_estan_al_dia() {
        let text = render();
        if std::env::var("UPDATE_CONTRACT").as_deref() == Ok("1") {
            std::fs::create_dir_all(std::path::Path::new(FIXTURES_PATH).parent().unwrap())
                .expect("directorio contract");
            std::fs::write(FIXTURES_PATH, &text).expect("escribe fixtures");
            return;
        }
        let on_disk = std::fs::read_to_string(FIXTURES_PATH).unwrap_or_else(|e| {
            panic!(
                "no se pudo leer {FIXTURES_PATH}: {e}\nGenéralo con: \
                 UPDATE_CONTRACT=1 cargo test -p dockinng-app contract_fixtures"
            )
        });
        assert!(
            on_disk == text,
            "deriva del contrato: backend/app/contract/fixtures.json no coincide con lo que \
             serializa Rust. Regenéralo con: \
             UPDATE_CONTRACT=1 cargo test -p dockinng-app contract_fixtures"
        );
    }

    #[test]
    fn cubre_todos_los_comandos() {
        let contract = build_contract();
        let with_fixture: BTreeSet<&str> = contract["commands"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let registered: BTreeSet<&str> = COMMAND_NAMES.iter().copied().collect();
        assert_eq!(
            with_fixture, registered,
            "comandos con fixture distintos de COMMAND_NAMES"
        );
        assert_eq!(
            registered.len(),
            COMMAND_NAMES.len(),
            "COMMAND_NAMES repetidos"
        );
    }

    #[test]
    fn los_argumentos_de_cada_fixture_coinciden_con_la_firma_de_rust() {
        let params = rust_command_params();
        let contract = build_contract();
        for (name, cmd) in contract["commands"].as_object().unwrap() {
            let expected = params
                .get(name)
                .unwrap_or_else(|| panic!("no se encontró la firma de {name}"));
            let got: BTreeSet<String> = cmd["args"].as_object().unwrap().keys().cloned().collect();
            assert_eq!(&got, expected, "argumentos de {name}");
        }
        // Y no hay comandos Rust sin fixture.
        for name in params.keys() {
            assert!(
                contract["commands"].get(name).is_some(),
                "comando {name} sin fixture"
            );
        }
    }

    #[test]
    fn los_errores_cubren_los_veinte_codigos_y_la_forma_de_cause_y_quiesced() {
        let e = api_errors();
        assert_eq!(e["by_code"].as_object().unwrap().len(), 20);
        assert_eq!(e["by_cause"].as_object().unwrap().len(), 10);
        // `cause` va siempre (null si no aplica); `quiesced` solo cuando es verdadero.
        assert!(e["by_code"]["conflict"]["cause"].is_null());
        assert!(e["by_code"]["conflict"].get("quiesced").is_none());
        assert_eq!(e["by_cause"]["socket_missing"]["cause"], "socket_missing");
        assert_eq!(e["quiesced"]["quiesced"], true);
    }

    #[test]
    fn los_feeds_incluyen_todas_las_variantes() {
        let f = feeds();
        let types_of = |name: &str| -> BTreeSet<String> {
            f[name]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["type"].as_str().unwrap().to_string())
                .collect()
        };
        let set = |v: &[&str]| -> BTreeSet<String> { v.iter().map(|s| s.to_string()).collect() };
        assert_eq!(
            types_of("EngineFeed"),
            set(&["events", "connection", "ended"])
        );
        assert_eq!(types_of("LogFeed"), set(&["lines", "ended"]));
        assert_eq!(types_of("StatsFeed"), set(&["sample", "ended"]));
        assert_eq!(types_of("ExecFeed"), set(&["opened", "output", "ended"]));
        assert_eq!(types_of("PullFeed"), set(&["started", "progress", "ended"]));
        assert_eq!(
            types_of("StackOpFeed"),
            set(&["started", "progress", "log", "ended"])
        );
        assert_eq!(
            types_of("BuildFeed"),
            set(&["line", "lines", "step", "ended"])
        );
        assert_eq!(
            types_of("AppFeed"),
            set(&["quit_requested", "window_visibility"])
        );
    }

    #[test]
    fn el_secreto_del_registro_se_lee_como_cadena() {
        // `registry_save` recibe el secreto como texto plano JSON (único canal con secretos).
        let s: engine_core::registry::Secret =
            serde_json::from_value(json!("token-de-prueba")).expect("secreto");
        assert_eq!(s.expose(), "token-de-prueba");
    }
}
