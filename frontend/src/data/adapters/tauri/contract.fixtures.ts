// FIXTURES DE CONTRATO: JSON con la forma EXACTA que serializa el backend (serde), leída de
// backend/crates/engine-core/src/{model,resources,connection,actions,api,events,logs,stats}.rs y app/src/streams.rs.
// Están anotadas con los tipos de `data/types.ts`: si un tipo diverge del backend, `tsc` falla aquí.
import type {
  ActionOutcome, ActionPlan, ActionRequest, ApiError, ConnectionStatus, Container, ContainerDetail, EngineFeed, Image, LogFeed, Network,
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
