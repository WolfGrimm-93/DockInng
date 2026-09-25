// Datos de ejemplo del adaptador simulado: portados de platilla-html/js/data.js (nada aquí es real).
// `buildWorld(now)` devuelve una copia NUEVA y mutable en cada llamada (tests y recargas parten de cero).
import type { Container, ConnectionProfile, Image, Network, StackSummary, Volume, UiStatus, ContainerState } from '../../types'

const MB = 1024 * 1024
const DAY = 86400

/** id de 12 hex de la plantilla -> id completo de 64 hex (determinista). */
export function fullId(id12: string): string {
  return id12.repeat(6).slice(0, 64)
}

interface CSeed {
  name: string; image: string; id: string; status: UiStatus; ports: string; stack: string | null
  text: string; vols: string[]; bind: string[]; nets: string[]; ago: number
}
const C: CSeed[] = [
  { name: 'tienda-web-1', image: 'nginx:1.27-alpine', id: '3f9a1c7e02b4', status: 'running', ports: '8080:80', stack: 'tienda', text: 'Up 3 days', vols: [], bind: [], nets: ['tienda_default', 'proxy-publico'], ago: 3 * DAY },
  { name: 'tienda-api-1', image: 'ghcr.io/casaluna/tienda-api:2.4.1', id: '9b2e5d81a7c0', status: 'running', ports: '3000:3000', stack: 'tienda', text: 'Up 3 days', vols: [], bind: ['~/proyectos/tienda/uploads'], nets: ['tienda_default'], ago: 3 * DAY },
  { name: 'tienda-postgres-1', image: 'postgres:16.4', id: 'c41d0a9be3f2', status: 'running', ports: '5432:5432', stack: 'tienda', text: 'Up 3 days', vols: ['tienda_postgres-datos'], bind: [], nets: ['tienda_default'], ago: 3 * DAY },
  { name: 'tienda-redis-1', image: 'redis:7.4-alpine', id: '7ae8f2136b59', status: 'running', ports: '6379', stack: 'tienda', text: 'Up 3 days', vols: ['tienda_redis-datos'], bind: [], nets: ['tienda_default'], ago: 3 * DAY },
  { name: 'tienda-worker-1', image: 'ghcr.io/casaluna/tienda-worker:2.4.1', id: 'e05b7c34d918', status: 'restarting', ports: '—', stack: 'tienda', text: 'Restarting (3) 5 seconds ago', vols: [], bind: [], nets: ['tienda_default'], ago: 3 * DAY },
  { name: 'monitoreo-prometheus-1', image: 'prom/prometheus:v2.54.1', id: '1d6f9e40c2a7', status: 'running', ports: '9090:9090', stack: 'monitoreo', text: 'Up 6 days', vols: ['monitoreo_prometheus-tsdb'], bind: [], nets: ['monitoreo_default'], ago: 6 * DAY },
  { name: 'monitoreo-grafana-1', image: 'grafana/grafana:11.2.0', id: 'b8c3a51f7d64', status: 'running', ports: '3001:3000', stack: 'monitoreo', text: 'Up 6 days', vols: ['monitoreo_grafana-datos'], bind: [], nets: ['monitoreo_default', 'proxy-publico'], ago: 6 * DAY },
  { name: 'monitoreo-loki-1', image: 'grafana/loki:3.1.1', id: '5c2d8e9a1b30', status: 'paused', ports: '3100', stack: 'monitoreo', text: 'Up 6 days (Paused)', vols: [], bind: [], nets: ['monitoreo_default'], ago: 6 * DAY },
  { name: 'traefik-proxy', image: 'traefik:v3.1', id: 'a70e4b26f8d1', status: 'running', ports: '80, 443', stack: null, text: 'Up 12 days', vols: [], bind: ['/var/run/docker.sock'], nets: ['proxy-publico'], ago: 12 * DAY },
  { name: 'minio-dev', image: 'minio/minio:RELEASE.2024-09-13T20-26-02Z', id: '2f8b6d05e7a3', status: 'exited', ports: '9000, 9001', stack: null, text: 'Exited (0) 2 hours ago', vols: ['minio-dev-datos'], bind: [], nets: ['bridge'], ago: 2 * DAY },
  { name: 'mailpit-pruebas', image: 'axllent/mailpit:v1.20', id: '84e1c7a09b25', status: 'exited', ports: '8025', stack: null, text: 'Exited (137) 1 day ago', vols: [], bind: [], nets: ['bridge'], ago: 5 * DAY },
  { name: 'respaldo-nocturno', image: 'casaluna/pg-backup:1.3', id: 'f3a92d17c6b8', status: 'dead', ports: '—', stack: null, text: 'Dead', vols: [], bind: [], nets: [], ago: 9 * DAY },
  { name: 'wiki-outline-1', image: 'outlinewiki/outline:0.82', id: '06d5b3e8a1f9', status: 'created', ports: '3005:3000', stack: null, text: 'Created', vols: [], bind: [], nets: [], ago: 1 * DAY },
]

interface ISeed { repo: string; tag: string; id: string; size: number; ago: number }
const I: ISeed[] = [
  { repo: 'ghcr.io/casaluna/tienda-api', tag: '2.4.1', id: '4be91a20c7d3', size: 412, ago: 3 * DAY },
  { repo: 'ghcr.io/casaluna/tienda-worker', tag: '2.4.1', id: '81f3d5c69e02', size: 398, ago: 3 * DAY },
  { repo: 'postgres', tag: '16.4', id: 'a19c6e3b7f40', size: 434, ago: 35 * DAY },
  { repo: 'nginx', tag: '1.27-alpine', id: 'd25f8a01b96c', size: 52, ago: 21 * DAY },
  { repo: 'redis', tag: '7.4-alpine', id: '3c70e9b4d158', size: 61, ago: 14 * DAY },
  { repo: 'prom/prometheus', tag: 'v2.54.1', id: 'e6b12f8a3c95', size: 289, ago: 28 * DAY },
  { repo: 'grafana/grafana', tag: '11.2.0', id: '5a0d7c93e1b8', size: 497, ago: 42 * DAY },
  { repo: 'grafana/loki', tag: '3.1.1', id: '92e4b6d0a7f3', size: 105, ago: 49 * DAY },
  { repo: 'traefik', tag: 'v3.1', id: 'c8f1a35d20e6', size: 189, ago: 14 * DAY },
  { repo: 'minio/minio', tag: 'RELEASE.2024-09-13T20-26-02Z', id: '17b9e4c5f3a2', size: 241, ago: 14 * DAY },
  { repo: 'node', tag: '20-bookworm-slim', id: 'f40c2a86d9b1', size: 230, ago: 56 * DAY },
  { repo: '<none>', tag: '<none>', id: '0d9b5e71c3a8', size: 405, ago: 21 * DAY },
]

const V: { name: string; mb: number; used: string[] }[] = [
  { name: 'tienda_postgres-datos', mb: 1843, used: ['tienda-postgres-1'] },
  { name: 'tienda_redis-datos', mb: 24, used: ['tienda-redis-1'] },
  { name: 'monitoreo_prometheus-tsdb', mb: 3277, used: ['monitoreo-prometheus-1'] },
  { name: 'monitoreo_grafana-datos', mb: 58, used: ['monitoreo-grafana-1'] },
  { name: 'minio-dev-datos', mb: 640, used: ['minio-dev'] },
  { name: 'respaldos-pg', mb: 5530, used: [] },
  { name: '8c1f0e3a7b52d94e6f01a3c8b5d72e90', mb: 12, used: [] },
]

const N: { name: string; driver: string; subnet: string; sys: boolean }[] = [
  { name: 'bridge', driver: 'bridge', subnet: '172.17.0.0/16', sys: true },
  { name: 'host', driver: 'host', subnet: '', sys: true },
  { name: 'none', driver: 'null', subnet: '', sys: true },
  { name: 'tienda_default', driver: 'bridge', subnet: '172.20.0.0/16', sys: false },
  { name: 'monitoreo_default', driver: 'bridge', subnet: '172.21.0.0/16', sys: false },
  { name: 'proxy-publico', driver: 'bridge', subnet: '172.22.0.0/24', sys: false },
]

/**
 * Puertos como la plantilla: «8080:80» = publicado (host:contenedor); «6379» y «80, 443» = expuestos SIN publicar
 * (solo puerto del contenedor). El formato «host:contenedor» aplica solo cuando hay puerto público.
 */
function parsePorts(s: string): Container['ports'] {
  if (s === '—') return []
  return s.split(/[,\s]+/).filter(Boolean).map((p) => {
    const [a, b] = p.split(':')
    return b
      ? { ip: '0.0.0.0', private_port: Number(b), public_port: Number(a), protocol: 'tcp' }
      : { ip: null, private_port: Number(a), public_port: null, protocol: 'tcp' }
  })
}

export interface World {
  containers: Container[]
  images: Image[]
  volumes: Volume[]
  networks: Network[]
  stacks: StackSummary[]
  profiles: ConnectionProfile[]
  /** Memoria/CPU de muestra por nombre de contenedor (en marcha). */
  usage: Record<string, { cpu: number; memMb: number }>
}

export function buildWorld(now: number = Date.now()): World {
  const nowS = Math.floor(now / 1000)
  const usageSeed: Record<string, [number, number]> = {
    'tienda-web-1': [0.4, 12], 'tienda-api-1': [6.8, 214], 'tienda-postgres-1': [2.1, 168], 'tienda-redis-1': [0.6, 9],
    'monitoreo-prometheus-1': [1.3, 142], 'monitoreo-grafana-1': [0.9, 96], 'monitoreo-loki-1': [0, 71], 'traefik-proxy': [0.2, 34],
  }
  const usage: World['usage'] = {}
  for (const [k, [cpu, memMb]] of Object.entries(usageSeed)) usage[k] = { cpu, memMb }

  const images: Image[] = I.map((s) => ({
    id: `sha256:${fullId(s.id)}`,
    reference: s.repo === '<none>' ? `sha256:${fullId(s.id)}` : `${s.repo}:${s.tag}`,
    repository: s.repo, tag: s.tag, size_bytes: s.size * MB, created: nowS - s.ago, containers: 0, dangling: s.repo === '<none>',
  }))
  const containers: Container[] = C.map((s) => {
    const img = images.find((i) => i.reference === s.image)
    const project = s.stack
    return {
      id: fullId(s.id), names: [s.name], image: s.image, image_id: img?.id ?? `sha256:${fullId(s.id.split('').reverse().join(''))}`,
      state: (s.status === 'created' ? 'created' : s.status) as ContainerState, status: s.text, created: nowS - s.ago,
      compose_project: project, compose_service: project ? s.name.replace(new RegExp(`^${project}-`), '').replace(/-\d+$/, '') : null,
      ports: parsePorts(s.ports),
      mounts: [
        ...s.vols.map((v) => ({ kind: 'volume' as const, name: v, source: `/var/lib/docker/volumes/${v}/_data`, destination: '/data', read_write: true })),
        ...s.bind.map((b) => ({ kind: 'bind' as const, name: null, source: b, destination: '/mnt/' + (b.split('/').pop() || 'host'), read_write: true })),
      ],
      networks: s.nets,
    }
  })
  for (const im of images) im.containers = containers.filter((c) => c.image_id === im.id).length
  const volumes: Volume[] = V.map((v) => ({
    name: v.name, driver: 'local', mountpoint: `/var/lib/docker/volumes/${v.name}/_data`, created_at: new Date(now - 20 * DAY * 1000).toISOString(),
    labels: {}, compose_project: v.name.includes('_') ? v.name.split('_')[0] : null, size_bytes: v.mb * MB, used_by: v.used, anonymous: /^[0-9a-f]{32}$/.test(v.name),
  }))
  const networks: Network[] = N.map((n) => ({
    id: fullId(n.name.replace(/[^a-f0-9]/g, '') + 'a1b2c3'), name: n.name, driver: n.driver, scope: 'local', subnets: n.subnet ? [n.subnet] : [], internal: false, system: n.sys,
    connected: containers.filter((c) => c.networks.includes(n.name)).map((c) => c.names[0]), compose_project: n.name.endsWith('_default') ? n.name.replace('_default', '') : null,
  }))
  const stacks: StackSummary[] = [
    { name: 'tienda', path: '~/proyectos/tienda/docker-compose.yml', services: [
      { name: 'web', image: 'nginx:1.27-alpine', state: 'running', replicas: '1/1' }, { name: 'api', image: 'tienda-api:2.4.1', state: 'running', replicas: '1/1' },
      { name: 'postgres', image: 'postgres:16.4', state: 'running', replicas: '1/1' }, { name: 'redis', image: 'redis:7.4-alpine', state: 'running', replicas: '1/1' },
      { name: 'worker', image: 'tienda-worker:2.4.1', state: 'restarting', replicas: '0/1' }] },
    { name: 'monitoreo', path: '~/infra/monitoreo/compose.yaml', services: [
      { name: 'prometheus', image: 'prom/prometheus:v2.54.1', state: 'running', replicas: '1/1' }, { name: 'grafana', image: 'grafana/grafana:11.2.0', state: 'running', replicas: '1/1' },
      { name: 'loki', image: 'grafana/loki:3.1.1', state: 'paused', replicas: '1/1' }] },
  ]
  const profiles: ConnectionProfile[] = [
    { id: 'local', name: 'Local', target: 'unix:///var/run/docker.sock', kind: 'local', icon: 'monitor', remote: false, version: 'Docker 27.3.1 · API 1.47', simulated: false },
    { id: 'prod', name: 'prod-hetzner', target: 'ssh://deploy@203.0.113.10', kind: 'ssh', icon: 'server', remote: true, version: 'Docker 26.1.4 · API 1.45', simulated: true },
    { id: 'staging', name: 'staging-lab', target: 'ssh://ops@192.168.1.40', kind: 'ssh', icon: 'server', remote: true, version: '', simulated: true, failsToConnect: true },
  ]
  return { containers, images, volumes, networks, stacks, profiles, usage }
}

/** Arrancar estos contenedores falla la primera vez (estado de error por fila). */
export const FAIL_START: Record<string, string> = { 'mailpit-pruebas': 'El puerto 8025 ya lo usa otro proceso del equipo.' }

export const LOG_SEED: [string, string][] = [
  ['INFO', 'Iniciando tienda-api 2.4.1 (node v20.17.0, NODE_ENV=production)'], ['INFO', 'Conectado a postgres://tienda-postgres-1:5432/tienda (pool: 10)'],
  ['INFO', 'Conectado a redis://tienda-redis-1:6379'], ['INFO', 'Servidor escuchando en 0.0.0.0:3000'], ['DEBUG', 'Cache miss clave=catalogo:destacados'],
  ['INFO', 'GET /api/productos?pagina=1 200 14ms'], ['INFO', 'GET /api/productos/8421 200 6ms'], ['DEBUG', 'Cache hit clave=carrito:8f21ab'],
  ['INFO', 'POST /api/carrito 201 22ms'], ['WARN', 'Consulta lenta (842 ms): SELECT * FROM pedidos WHERE cliente_id = $1 ORDER BY creado DESC'],
  ['INFO', 'GET /api/pedidos 200 851ms'], ['INFO', 'GET /salud 200 1ms'], ['INFO', 'POST /api/pagos/intencion 200 187ms'],
  ['ERROR', 'ECONNRESET al hablar con tienda-redis-1:6379, reintentando (1/5)'], ['WARN', 'Reintento de conexión a redis en 250 ms'],
  ['INFO', 'Conexión a redis restablecida'], ['INFO', 'GET /api/productos?categoria=cafe 200 11ms'], ['DEBUG', 'Cache miss clave=categoria:cafe'],
  ['ERROR', 'Webhook de pago rechazado: firma inválida (evento evt_1Q9xKf) — POST /api/pagos/webhook 400 3ms'], ['INFO', 'GET /salud 200 1ms'],
  ['WARN', 'Uso de memoria del heap al 78% (214 MiB de 275 MiB)'], ['INFO', 'POST /api/sesion 200 41ms'], ['INFO', 'GET /api/usuarios/yo 200 5ms'],
  ['INFO', 'PUT /api/carrito/8f21ab 200 18ms'], ['DEBUG', 'Serializando respuesta: 48 productos, 31.2 KB'], ['INFO', 'GET /api/productos?pagina=2 200 13ms'],
]
export const LIVE_LOGS: [string, string][] = [
  ['INFO', 'GET /api/productos?pagina=3 200 12ms'], ['INFO', 'GET /salud 200 1ms'], ['DEBUG', 'Cache hit clave=catalogo:destacados'],
  ['WARN', 'Consulta lenta (611 ms): SELECT count(*) FROM pedidos'], ['INFO', 'POST /api/carrito 201 19ms'], ['ERROR', 'Tiempo de espera agotado al llamar a pasarela-pagos (5000 ms)'],
]

export const PULL_LAYERS: [string, number][] = [['a3b8c1d92e07', 30.4], ['5f1e9a7b3c42', 12.1], ['9d02c6e8f1a5', 88.7], ['c47b2e0d9a13', 5.6], ['e18f4a6b7c90', 41.2]]
export const UP_SERVICES = ['postgres', 'redis', 'api', 'web']

export const SAMPLE_YAML = [
  'name: tienda', '', 'services:',
  '  web:', '    image: nginx:1.27-alpine', '    ports:', '      - "8081:80"', '    depends_on: [api]',
  '  api:', '    image: ghcr.io/casaluna/tienda-api:2.4.1', '    environment:', '      DATABASE_URL: postgres://tienda:${POSTGRES_PASSWORD}@postgres:5432/tienda',
  '      REDIS_URL: redis://redis:6379', '    ports:', '      - "3000:3000"',
  '  postgres:', '    image: postgres:16.4', '    environment:', '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}', '    volumes:', '      - postgres-datos:/var/lib/postgresql/data',
  '  redis:', '    image: redis:7.4-alpine', '', 'volumes:', '  postgres-datos:',
].join('\n')
export const BROKEN_YAML = ['name: tienda', '', 'services:', '  web:', '\tports:', '      - "8080:80"', '  api:', '    environment:', '      PORT: ${API_PORT}'].join('\n')
export const SAMPLE_ENV = ['# Variables de tienda', 'POSTGRES_PASSWORD=cambia-esto', 'TZ=America/Mexico_City'].join('\n')
