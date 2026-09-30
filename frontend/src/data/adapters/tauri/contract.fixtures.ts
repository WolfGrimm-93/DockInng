// FIXTURES DE CONTRATO: JSON con la forma EXACTA que serializa el backend (serde), leída de
// backend/crates/engine-core/src/{model,resources,connection,actions,api,events,logs,stats}.rs y app/src/streams.rs.
// Están anotadas con los tipos de `data/types.ts`: si un tipo diverge del backend, `tsc` falla aquí.
import type {
  ActionOutcome, ActionPlan, ActionRequest, ApiError, ComposeInfo, ConnectionStatus, Container, ContainerDetail, CreateContainerSpec, CreatePlan,
  CreateResult, EngineFeed, ExecFeed, Image, LogFeed, Network, PullFeed, StackFiles, StackOpFeed, StackSummary, StackValidation,
  GpuInfo, StatsFeed, StatsSnapshotItem, SystemUsage, Volume,
} from '../../types'

const ID = 'a'.repeat(64)

export const container: Container = {
  id: ID, names: ['tienda-api-1'], image: 'nginx:1.27-alpine', image_id: 'sha256:' + 'b'.repeat(64), state: 'running', status: 'Up 3 days', created: 1_790_000_000,
  compose_project: 'tienda', compose_service: 'api',
  ports: [{ ip: '0.0.0.0', private_port: 80, public_port: 8080, protocol: 'tcp' }, { ip: null, private_port: 6379, public_port: null, protocol: 'tcp' }],
  mounts: [{ kind: 'volume', name: 'datos', source: '/var/lib/docker/volumes/datos/_data', destination: '/data', read_write: true }, { kind: 'bind', name: null, source: '/srv/x', destination: '/x', read_write: false }],
  networks: ['tienda_default'],
  endpoints: [{ name: 'tienda_default', ip_address: '172.20.0.3', ipv6_address: null, gateway: '172.20.0.1', mac_address: '02:42:ac:14:00:03', aliases: [] }],
}
export const containerDetail: ContainerDetail = {
  summary: container, created_at: '2026-09-21T09:14:52.318Z', ip_address: '172.20.0.3', started_at: '2026-09-21T09:15:01Z', finished_at: null, exit_code: null, pid: 4821,
  oom_killed: false, restart_count: 0, error: null, tty: false, restart_policy: 'unless-stopped', memory_limit_bytes: 536870912, cpu_limit: 1,
  networks: [{ name: 'tienda_default', ip_address: '172.20.0.3', ipv6_address: null, gateway: '172.20.0.1', mac_address: '02:42:ac:14:00:03', aliases: ['api', 'tienda-api-1', '9b2e5d81a7c0'] }], raw: { Id: ID, Config: { Env: ['A=1'] } },
}
export const image: Image = { id: 'sha256:' + 'c'.repeat(64), reference: 'nginx:1.27-alpine', repository: 'nginx', tag: '1.27-alpine', size_bytes: 54525952, created: 1_790_000_000, containers: 1, dangling: false }
export const volume: Volume = { name: 'datos', driver: 'local', mountpoint: '/var/lib/docker/volumes/datos/_data', created_at: '2026-09-01T00:00:00Z', labels: { 'com.docker.compose.project': 'tienda' }, compose_project: 'tienda', size_bytes: null, used_by: ['tienda-api-1'], anonymous: false }
export const network: Network = { id: 'd'.repeat(64), name: 'tienda_default', driver: 'bridge', scope: 'local', subnets: ['172.20.0.0/16'], internal: false, system: false, connected: ['tienda-api-1'], compose_project: 'tienda' }

export const statusConnected: ConnectionStatus = { state: 'connected', endpoint: 'unix:///var/run/docker.sock', server: { version: '27.3.1', api_version: '1.47', os: 'linux', arch: 'x86_64' } }
export const statusPermission: ConnectionStatus = {
  state: 'failed', endpoint: 'unix:///var/run/docker.sock', cause: 'permission_denied', message: 'permission denied (os error 13)',
  steps: [{ id: 'socket', status: 'ok', detail: '' }, { id: 'permissions', status: 'fail', detail: 'permission denied' }, { id: 'daemon', status: 'skipped', detail: '' }],
}

export const requests: ActionRequest[] = [
  { type: 'remove_containers', ids: [ID] }, { type: 'remove_image', reference: 'nginx:1.27-alpine' }, { type: 'prune_images' },
  { type: 'remove_volume', name: 'datos' }, { type: 'prune_volumes' }, { type: 'remove_network', id: 'x' }, { type: 'stack_down', project: 'tienda' }, { type: 'prune_system' },
  { type: 'cleanup', selection: { containers: [ID], images: [], volumes: [], networks: [] } },
]
export const planConfirm: ActionPlan = {
  decision: { type: 'confirm' }, ticket: '01935f00-0000-7000-8000-000000000001', expires_in_secs: 120,
  affected: [{ kind: 'container', id: ID, name: 'tienda-api-1', state: 'running', size_bytes: null, detail: null }],
  warnings: [{ type: 'running_force', count: 1 }, { type: 'volumes_kept', items: ['datos'] }, { type: 'bind_mounts_kept', items: ['/srv/x'] }, { type: 'in_use', count: 2 }], total_size_bytes: null,
}
export const planTyped: ActionPlan = {
  decision: { type: 'confirm_typed', expected: 'datos' }, ticket: '01935f00-0000-7000-8000-000000000002', expires_in_secs: 120,
  affected: [{ kind: 'volume', id: 'datos', name: 'datos', state: null, size_bytes: 1024, detail: null }], warnings: [], total_size_bytes: 1024,
}
export const planDeny: ActionPlan = { decision: { type: 'deny', reason: 'forbidden' }, ticket: null, expires_in_secs: 120, affected: [], warnings: [], total_size_bytes: null }
export const apiErr: ApiError = { code: 'conflict', message: 'volume in use', cause: null }
export const outcome: ActionOutcome = {
  succeeded: [{ kind: 'container', id: ID, name: 'tienda-api-1' }],
  failed: [{ item: { kind: 'volume', id: 'datos', name: 'datos' }, error: { code: 'state_changed', message: 'cambió', cause: null } }], freed_bytes: 1024,
}

export const feedEvents: EngineFeed = { type: 'events', resync: false, items: [{ kind: 'container', action: 'die', id: ID, name: 'tienda-api-1', time_nano: 1_790_000_000_000_000_000, attributes: { exitCode: '137' } }] }
export const feedConnection: EngineFeed = { type: 'connection', status: statusPermission }
export const feedEnded: EngineFeed = { type: 'ended', reason: 'error' }
export const logLines: LogFeed = { type: 'lines', dropped: 3, lines: [{ stream: 'stderr', timestamp: '2026-09-24T14:02:11.037123456Z', message: 'ERROR x', truncated: false }] }
export const logEnded: LogFeed = { type: 'ended', reason: 'container_stopped', error: null }
export const statsSample: StatsFeed = {
  type: 'sample',
  stats: { read_at: '2026-09-24T14:02:11Z', cpu_percent: 6.8, mem_used_bytes: 224395264, mem_limit_bytes: 536870912, mem_percent: 41.8, net_rx_bytes: 1, net_tx_bytes: 2, net_rx_bytes_per_sec: 1200.5, net_tx_bytes_per_sec: 0, block_read_bytes: 3, block_write_bytes: 4, pids: 23 },
}
export const statsEnded: StatsFeed = { type: 'ended', reason: 'eof', error: null }

// container_stats_snapshot(ids) -> Vec<StatsSnapshotItem{id, stats: Option<ContainerStats>, error: Option<ApiError>}> (commands.rs)
export const snapshot: StatsSnapshotItem[] = [
  { id: ID, stats: statsSample.type === 'sample' ? statsSample.stats : null, error: null },
  { id: 'e'.repeat(64), stats: null, error: { code: 'timeout', message: 'timeout', cause: null } },
]

// system_usage -> SystemUsage (engine-core/src/system.rs). `null` = desconocido (Option<u64> serializa a null), nunca cero.
export const systemUsage: SystemUsage = {
  host: { cpu_count: 24, mem_total_bytes: 33_064_775_680 },
  disk: {
    images: { total_bytes: 33_306_079_873, reclaimable_bytes: 12_283_808_840 },
    containers: { total_bytes: 161_054_720, reclaimable_bytes: 157_421_568 },
    volumes: { total_bytes: 15_505_617_941, reclaimable_bytes: 560_263_712 },
    build_cache: { total_bytes: null, reclaimable_bytes: null },
  },
  container_disk: [{ id: ID, size_rw_bytes: 3_051_520 }],
  disk_known: true,
}
// gpu_status -> Vec<GpuInfo> (salida real de nvidia-smi del equipo del autor; temperature_c es Option<u32>).
export const gpus: GpuInfo[] = [
  { index: 0, name: 'NVIDIA GeForce RTX 5060 Laptop GPU', utilization_percent: 13, mem_used_bytes: 42_991_616, mem_total_bytes: 8_547_991_552, temperature_c: 57 },
]

// ---------------------------------------------------------------- Ola 1 (forma serde del backend: PLAN_ola1_backend §A–E)
// Los valores salen de las muestras reales saneadas (Compose 5.5.1 / bollard 0.21): proyecto dockinng-test-recon, capas c8e91746bdfc…, L2.C3.
export const composeInfo: ComposeInfo = { available: true, flavor: 'plugin', version: '5.5.1', supported: true, docker_cli: true }
export const composeMissing: ComposeInfo = { available: false, flavor: 'missing', version: null, supported: false, docker_cli: true }
export const stackSummary: StackSummary = {
  name: 'dockinng-test-recon', origin: 'linked', path: '/home/user/stacks/recon/compose.yaml', config_files: ['/home/user/stacks/recon/compose.yaml'],
  working_dir: '/home/user/stacks/recon', editable: true, status: 'partial', containers: 2, running: 1,
  services: [
    { name: 'sleeper', image: 'alpine:3.20', state: 'running', replicas: '1/1', running: 1, total: 1 },
    { name: 'second', image: 'alpine:3.20', state: 'exited', replicas: '0/1', running: 0, total: 1 },
  ],
}
export const stackDeclared: StackSummary = { ...stackSummary, name: 'declarado', origin: 'managed', status: 'declared', containers: 0, running: 0, services: [] }
export const stackFiles: StackFiles = {
  name: 'dockinng-test-recon', origin: 'linked', yaml: 'services:\n  sleeper:\n    image: alpine:3.20\n', env: 'TZ=UTC\n', path: '/home/user/stacks/recon/compose.yaml',
  env_path: '/home/user/stacks/recon/.env', editable: true, config_files: ['/home/user/stacks/recon/compose.yaml'], revision: '1790000000000000000:71',
}
export const validationBad: StackValidation = {
  ok: false,
  issues: [{ line: 2, column: 3, kind: 'syntax', message: 'go-yaml load error in parser (while parsing a block mapping) at L2.C3-L4.C4: did not find expected key' },
    { line: null, column: null, kind: 'schema', message: "services.web additional properties 'imagen' not allowed" }],
  services: [], risks: [{ type: 'privileged' }, { type: 'sensitive_bind', path: '/etc' }, { type: 'docker_sock' }],
}
// run_stack_op: los eventos reales de `--progress json` ya vienen resumidos por el backend.
export const opStarted: StackOpFeed = { type: 'started', op: 'up', stack: 'dockinng-test-recon', compose_version: '5.5.1' }
export const opProgress: StackOpFeed = {
  type: 'progress',
  items: [{ id: 'Container dockinng-test-recon-sleeper-1', kind: 'container', name: 'dockinng-test-recon-sleeper-1', status: 'working', text: 'Starting', details: null, current: null, total: null, percent: null, parent_id: null }],
  services: [{ name: 'sleeper', percent: 80, phase: 'creating' }, { name: 'second', percent: 0, phase: 'waiting' }],
}
export const opLog: StackOpFeed = { type: 'log', text: ' Network dockinng-test-recon_default  Creating' }
export const opEndedOk: StackOpFeed = { type: 'ended', outcome: 'success', exit_code: 0, error: null, issues: [] }
export const opEndedFail: StackOpFeed = {
  type: 'ended', outcome: 'failed', exit_code: 1, issues: [],
  error: { code: 'compose_failed', message: 'Error response from daemon: No such image: dockinng-test-noexiste:latest', cause: null },
}
export const opEndedCanceled: StackOpFeed = { type: 'ended', outcome: 'canceled', exit_code: null, error: null, issues: [] }

export const execOpened: ExecFeed = { type: 'opened', shell: '/bin/sh', risk: { privileged: false, docker_socket: true, host_pid: false, host_network: false } }
// "héllo €" en UTF-8, PARTIDO entre dos chunks en mitad de «é» (c3 | a9) y de «€» (e2 82 | ac): xterm debe recibir bytes crudos.
export const execChunkA: ExecFeed = { type: 'output', data: btoa(String.fromCharCode(0x68, 0xc3)) }
export const execChunkB: ExecFeed = { type: 'output', data: btoa(String.fromCharCode(0xa9, 0x6c, 0x6c, 0x6f, 0x20, 0xe2, 0x82)) }
export const execChunkC: ExecFeed = { type: 'output', data: btoa(String.fromCharCode(0xac)) }
export const execEnded: ExecFeed = { type: 'ended', reason: 'process_exited', exit_code: 7, error: null }
export const execStopped: ExecFeed = { type: 'ended', reason: 'container_stopped', exit_code: null, error: null }

export const pullStarted: PullFeed = { type: 'started', reference: 'localhost:54109/dockinng-test/layers:1' }
export const pullProgress: PullFeed = {
  type: 'progress', done_bytes: 3145728, total_bytes: 10005636,
  layers: [
    { id: '80cb7bcf5d4b', phase: 'downloading', total: 3002106, done: 1048576 },
    { id: '648890eaed45', phase: 'downloading', total: 5001771, done: 1048576 },
    { id: 'c8e91746bdfc', phase: 'complete', total: 2001759, done: 2001759 },
  ],
}
export const pullEnded: PullFeed = { type: 'ended', outcome: 'done', up_to_date: false, digest: 'sha256:d9fa', error: null }
export const pullEndedErr: PullFeed = {
  type: 'ended', outcome: 'error', up_to_date: false, digest: null,
  error: { code: 'registry_unreachable', message: 'failed to resolve reference "localhost:1/dockinng-test/x:1": failed to do request: connection refused', cause: null },
}

export const createSpec: CreateContainerSpec = {
  image: 'alpine:3.20', name: 'dockinng-test-c1', ports: [{ host_ip: '127.0.0.1', host_port: 54108, container_port: 80, protocol: 'tcp' }],
  volumes: [{ source: '/srv/datos', target: '/data', read_only: true }], env: [{ key: 'A', value: 'b=c' }], network: 'bridge',
  restart: 'unless-stopped', restart_max_retries: null, command: null, labels: {},
}
export const createPlanConfirm: CreatePlan = {
  ok: true, field_errors: [], normalized: createSpec, ticket: '01935f00-0000-7000-8000-000000000003', expires_in_secs: 120,
  decision: { type: 'confirm' },
  warnings: [{ type: 'sensitive_bind', source: '/etc', reason: 'da acceso a /etc' }, { type: 'docker_socket' }, { type: 'host_network' }, { type: 'port_in_use', port: 8080, by: 'tienda-web-1' }, { type: 'published_all_interfaces', port: 8080 }],
}
export const createPlanBad: CreatePlan = {
  ok: false, field_errors: [{ field: 'volumes[0].source', message: 'usa una ruta absoluta' }], normalized: createSpec, ticket: null, expires_in_secs: 120, decision: { type: 'allow' }, warnings: [],
}
export const createResult: CreateResult = { id: 'f'.repeat(64), name: 'dockinng-test-c1', started: false, warnings: [], start_error: { code: 'conflict', message: 'port is already allocated', cause: null } }

// ---------------------------------------------------------------- Ola 2 (forma serde descrita en DISEÑO Ola 2 §G)
import type {
  BuildFeed, BuildPlan, BuildSpec, CleanupReport, ConnSpec, ConnTestResult, ConnectionProfile, GroupsImportResult, GroupsSnapshot, HostKeyProbe, PodmanCandidate, RegistrySummary,
} from '../../types'

export const sshSpec: ConnSpec = { kind: 'ssh', name: 'prod', host: '203.0.113.10', port: 22, user: 'deploy', mode: 'explicit', identity: { type: 'agent' } }
export const sshSpecFile: ConnSpec = { kind: 'ssh', name: 'lab', host: 'lab', port: 2222, user: '', mode: 'alias', identity: { type: 'file', path: '/home/u/.ssh/id_ed25519' } }
export const tlsSpec: ConnSpec = { kind: 'tls', name: 'ci', host: '10.0.0.5', port: 2376, ca_path: '/home/u/.docker/ca.pem', cert_path: '/home/u/.docker/cert.pem', key_path: '/home/u/.docker/key.pem' }
export const probeUnknown: HostKeyProbe = { key_type: 'ssh-ed25519', fingerprint_sha256: 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8', state: 'unknown' }
export const probeChanged: HostKeyProbe = { key_type: 'ssh-ed25519', fingerprint_sha256: 'SHA256:zzzz', state: 'changed', known_fingerprint_sha256: 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8' }
export const testOk: ConnTestResult = { ok: true, server: { version: '26.1.4', api_version: '1.45', os: 'linux', arch: 'x86_64' }, error: null, cause: null }
export const testFail: ConnTestResult = { ok: false, error: { code: 'connection', message: 'Permission denied (publickey).', cause: 'auth_failed' }, cause: 'auth_failed' }
/** Forma REAL de `connection_list`/`connection_save` (engine-core `ConnectionProfile`: spec aplanado, sin target/icono/versión). */
export const profileSshRaw = { id: '01935f00-0000-7000-8000-0000000000aa', kind: 'ssh', name: 'prod', host: '203.0.113.10', port: 22, user: 'deploy', mode: 'explicit', identity: { type: 'agent' }, remote: true, host_key_fp: probeUnknown.fingerprint_sha256, simulated: false }
export const profileTlsRaw = { id: '01935f00-0000-7000-8000-0000000000ab', kind: 'tls', name: 'ci', host: '10.0.0.5', port: 2376, ca_path: '/c/ca.pem', cert_path: '/c/cert.pem', key_path: '/c/key.pem', remote: true, host_key_fp: null, simulated: false }
export const profileSsh: ConnectionProfile = { id: '01935f00-0000-7000-8000-0000000000aa', name: 'prod', target: 'ssh://deploy@203.0.113.10', kind: 'ssh', icon: 'server', remote: true, version: '', simulated: false, host_key_fp: probeUnknown.fingerprint_sha256, spec: sshSpec }
export const importReport: GroupsImportResult = { already_imported: false, imported_groups: 1, imported_assignments: 1, dropped_assignments: 0, snapshot: groupsSnapshotEarly() }
function groupsSnapshotEarly(): GroupsSnapshot { return { groups: [], assignments: [], stack_hues: {}, legacy_imported: true } }
export const registry: RegistrySummary = { id: '01935f00-0000-7000-8000-0000000000bb', server: 'ghcr.io', username: 'casaluna' }
export const groupsSnapshot: GroupsSnapshot = {
  groups: [{ id: '01935f00-0000-7000-8000-0000000000cc', name: 'Trabajo', hue: 200 }],
  assignments: [{ connection_id: 'local', container_name: 'tienda-api-1', group_id: '01935f00-0000-7000-8000-0000000000cc' }],
  stack_hues: { tienda: 140 }, legacy_imported: true,
}
export const buildSpec: BuildSpec = { context_dir: '/home/u/app', dockerfile: null, tag: 'app:1', build_args: [['NODE_ENV', 'production']], target: null, no_cache: false, pull: false }
export const buildPlanAllow: BuildPlan = { warnings: [], decision: { type: 'allow' }, ticket: null }
export const buildPlanSensitive: BuildPlan = { warnings: [{ type: 'sensitive_context', path: '/home/u' }, { type: 'secret_like_arg', name: 'API_TOKEN' }], decision: { type: 'confirm' }, ticket: '01935f00-0000-7000-8000-0000000000dd' }
export const buildFeeds: BuildFeed[] = [
  { type: 'line', text: 'Step 1/3 : FROM alpine', stream: 'stdout' }, { type: 'step', n: 1, total: 3 },
  { type: 'ended', outcome: 'ok', image_id: 'sha256:' + 'e'.repeat(64), error: null },
]
export const cleanupReport: CleanupReport = {
  categories: [
    { id: 'stopped_containers', executable: true, reclaimable_bytes: 1000, items: [{ kind: 'container', id: 'c1', name: 'viejo', size_bytes: 1000, estimate: 'exact', reason: 'Detenido', risk: 'low', selected_by_default: true }] },
    { id: 'unused_volumes', executable: true, reclaimable_bytes: null, items: [{ kind: 'volume', id: 'v1', name: 'datos', size_bytes: null, estimate: 'unknown', reason: 'Sin contenedores', risk: 'high', selected_by_default: false }] },
    { id: 'build_cache', executable: false, reclaimable_bytes: 5000, items: [] },
  ],
  total_reclaimable_bytes: 1000, unknown_count: 1, generated_at: '2026-09-26T10:00:00Z',
}
export const podman: PodmanCandidate[] = [{ path: '/run/user/1000/podman/podman.sock', rootless: true, source: 'xdg_runtime_dir' }]
