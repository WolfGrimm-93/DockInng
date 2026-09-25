// ADAPTADOR SIMULADO: implementa TODO EngineApi en memoria con las fixtures de la plantilla.
// - Modo navegador (`pnpm dev` sin Tauri) y tests: mundo coherente y mutable (crear/eliminar/iniciar…).
// - Dentro de Tauri se reutilizan solo las partes «no conectadas aún» (exec, pull, create, stacks,
//   connections); con `mutateWorld:false` NO se insertan datos falsos en listas reales.
// Contrato adicional `sim`: controles para devFlags y tests (emitir eventos, forzar fallos de conexión).
import { uuidv7 } from '@/lib/uuid7'
import type { Capability, EngineApi, Feature } from '../../api'
import type {
  ActionOutcome, ActionPlan, ActionRequest, AffectedItem, ApiError, ConnSpec, ConnectionProfile, ConnectionStatus,
  Container, ContainerDetail, ContainerState, ContainerStats, EngineFeed, LogFeed, LogLine, PlanDecision,
  PlanWarning, PullProgress, StackSummary, UpProgress,
} from '../../types'
import { createSimTerminal } from './exec'
import {
  BROKEN_YAML, FAIL_START, LIVE_LOGS, LOG_SEED, PULL_LAYERS, SAMPLE_ENV, SAMPLE_YAML, UP_SERVICES, buildWorld, type World,
} from './fixtures'

export type SimFault = 'permission' | 'daemon' | null
export interface SimOptions {
  /** ms de latencia de start/stop/restart y execute (por defecto 900, como la plantilla; 0 en tests). */
  latency?: number
  now?: number
  world?: World
  /** false en Tauri: los simulados no tocan datos reales. */
  mutateWorld?: boolean
  /** ms entre ticks de pull/up (por defecto 450). */
  tick?: number
}
export interface SimControls {
  world: World
  /** Emite un feed de eventos a los suscriptores (como si viniera del backend). */
  emit(feed: EngineFeed): void
  /** Fuerza el error de conexión de los paneles «permission» / «daemon» hasta `reconnect()` con éxito. */
  setFault(f: SimFault): void
  failStart: Record<string, string>
}
export type SimEngineApi = EngineApi & { sim: SimControls }

const MB = 1024 * 1024

function apiError(code: ApiError['code'], message: string): ApiError {
  return { code, message }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function createSimApi(opts: SimOptions = {}): SimEngineApi {
  const latency = opts.latency ?? 900
  const tick = opts.tick ?? 450
  const mutate = opts.mutateWorld ?? true
  const world = opts.world ?? buildWorld(opts.now)
  const failStart = { ...FAIL_START }
  const tried = new Set<string>()
  const subs = new Set<(f: EngineFeed) => void>()
  let active = 'local'
  let fault: SimFault = null
  const tickets = new Map<string, { request: ActionRequest; decision: PlanDecision; ids: string[]; expires: number; attempts: number }>()

  const emit = (feed: EngineFeed) => {
    for (const s of subs) s(feed)
  }
  const emitContainer = (c: Container, action: string) =>
    emit({ type: 'events', resync: false, items: [{ kind: 'container', action, id: c.id, name: c.names[0], time_nano: Date.now() * 1e6, attributes: { name: c.names[0], image: c.image } }] })
  const emitKind = (kind: 'image' | 'volume' | 'network', action: string, id: string) =>
    emit({ type: 'events', resync: false, items: [{ kind, action, id, name: null, time_nano: Date.now() * 1e6, attributes: {} }] })

  const find = (idOrName: string): Container => {
    const c = world.containers.find((x) => x.id === idOrName || x.names.includes(idOrName) || (idOrName.length >= 4 && x.id.startsWith(idOrName)))
    if (!c) throw apiError('not_found', `No existe el contenedor ${idOrName}`)
    return c
  }
  const profile = (): ConnectionProfile => world.profiles.find((p) => p.id === active) ?? world.profiles[0]
  const isOn = (s: ContainerState) => s === 'running' || s === 'paused' || s === 'restarting'

  function statusOf(): ConnectionStatus {
    const p = profile()
    if (p.failsToConnect) {
      return { state: 'failed', endpoint: p.target, cause: 'other', message: 'Permission denied (publickey)', steps: [] }
    }
    if (fault === 'permission') {
      return { state: 'failed', endpoint: p.target, cause: 'permission_denied', message: 'permission denied (os error 13)', steps: [
        { id: 'socket', status: 'ok', detail: '' }, { id: 'permissions', status: 'fail', detail: 'permission denied (os error 13)' }, { id: 'daemon', status: 'skipped', detail: '' }] }
    }
    if (fault === 'daemon') {
      return { state: 'failed', endpoint: p.target, cause: 'daemon_down', message: 'connection refused (os error 111)', steps: [
        { id: 'socket', status: 'fail', detail: 'connection refused' }, { id: 'permissions', status: 'skipped', detail: '' }, { id: 'daemon', status: 'fail', detail: 'connection refused' }] }
    }
    const m = p.version.match(/Docker ([\d.]+) · API ([\d.]+)/)
    return { state: 'connected', endpoint: p.target, server: { version: m?.[1] ?? '27.3.1', api_version: m?.[2] ?? '1.47', os: 'linux', arch: 'x86_64' } }
  }

  // ------------------------------------------------------------- contenedores
  function statsFor(c: Container, jitter = true): ContainerStats {
    const u = world.usage[c.names[0]] ?? { cpu: 0.3, memMb: 20 }
    const j = jitter ? (Math.random() - 0.5) * 0.6 : 0
    const cpu = Math.max(0, u.cpu + j)
    const limit = 512 * MB
    const mem = u.memMb * MB
    return {
      read_at: new Date().toISOString(), cpu_percent: cpu, mem_used_bytes: mem, mem_limit_bytes: limit, mem_percent: (mem / limit) * 100,
      net_rx_bytes: 48 * MB, net_tx_bytes: 21 * MB, net_rx_bytes_per_sec: 1200 + Math.random() * 400, net_tx_bytes_per_sec: 800 + Math.random() * 300,
      block_read_bytes: 12 * MB, block_write_bytes: 90 * MB, pids: 23,
    }
  }
  function detailOf(c: Container): ContainerDetail {
    const on = isOn(c.state)
    const raw = {
      Id: c.id, Name: '/' + c.names[0], Created: new Date(c.created * 1000).toISOString(), Image: c.image,
      State: { Status: c.state, Running: c.state === 'running', Paused: c.state === 'paused', Restarting: c.state === 'restarting', Pid: on ? 48213 : 0, ExitCode: 0, StartedAt: new Date(c.created * 1000).toISOString() },
      Config: { Hostname: c.id.slice(0, 12), User: 'node', Env: ['NODE_ENV=production', 'PORT=3000', 'DATABASE_URL=postgres://tienda@tienda-postgres-1:5432/tienda', 'REDIS_URL=redis://tienda-redis-1:6379'], Cmd: ['node', 'dist/main.js'], WorkingDir: '/app',
        Labels: { 'com.docker.compose.project': c.compose_project ?? '', 'com.docker.compose.service': c.compose_service ?? '' } },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 }, Memory: 536870912, NanoCpus: 1000000000 },
      NetworkSettings: { Networks: Object.fromEntries(c.networks.map((n) => [n, { IPAddress: '172.20.0.3', Gateway: '172.20.0.1' }])) },
      Mounts: c.mounts.map((m) => ({ Type: m.kind, Source: m.source, Destination: m.destination, RW: m.read_write })),
    }
    return {
      summary: c, created_at: raw.Created, ip_address: on ? '172.20.0.3' : null, started_at: on ? raw.Created : null, finished_at: null, exit_code: on ? null : 0,
      pid: on ? 48213 : null, oom_killed: false, restart_count: 0, error: null, tty: false, restart_policy: 'unless-stopped',
      memory_limit_bytes: 512 * MB, cpu_limit: 1, networks: c.networks.map((n) => ({ name: n, ip_address: '172.20.0.3', gateway: '172.20.0.1' })), raw,
    }
  }
  async function changeState(idOrName: string, op: 'start' | 'stop' | 'restart') {
    const c = find(idOrName)
    await sleep(latency)
    if (op === 'start' && failStart[c.names[0]] && !tried.has(c.names[0])) {
      tried.add(c.names[0])
      throw apiError('conflict', failStart[c.names[0]])
    }
    if (!mutate) return
    if (op === 'stop') {
      c.state = 'exited'
      c.status = 'Exited (0) Less than a second ago'
      delete world.usage[c.names[0]]
    } else {
      c.state = 'running'
      c.status = 'Up Less than a second'
      world.usage[c.names[0]] = { cpu: 0.5, memMb: 20 }
    }
    emitContainer(c, op === 'stop' ? 'die' : op)
  }

  // ------------------------------------------------------------- política
  const inUseImg = (ref: string) => world.images.find((i) => i.reference === ref)
  function plan(req: ActionRequest): ActionPlan {
    const mk = (decision: PlanDecision, affected: AffectedItem[], warnings: PlanWarning[] = [], total: number | null = null, ids: string[] = []): ActionPlan => {
      const ticket = decision.type === 'confirm' || decision.type === 'confirm_typed' ? uuidv7() : null
      if (ticket) {
        if (tickets.size >= 32) tickets.delete(tickets.keys().next().value as string)
        tickets.set(ticket, { request: req, decision, ids, expires: Date.now() + 120_000, attempts: 0 })
      }
      return { decision, ticket, expires_in_secs: 120, affected, warnings, total_size_bytes: total }
    }
    switch (req.type) {
      case 'remove_containers': {
        const cs = req.ids.map(find)
        if (!cs.length) return mk({ type: 'allow' }, [])
        const running = cs.filter((c) => isOn(c.state))
        const vols = [...new Set(cs.flatMap((c) => c.mounts.filter((m) => m.kind === 'volume' && m.name).map((m) => m.name as string)))]
        const binds = [...new Set(cs.flatMap((c) => c.mounts.filter((m) => m.kind === 'bind').map((m) => m.source)))]
        const warnings: PlanWarning[] = []
        if (running.length) warnings.push({ type: 'running_force', count: running.length })
        if (vols.length) warnings.push({ type: 'volumes_kept', items: vols })
        if (binds.length) warnings.push({ type: 'bind_mounts_kept', items: binds })
        return mk({ type: 'confirm' }, cs.map((c) => ({ kind: 'container', id: c.id, name: c.names[0], state: c.state })), warnings, null, cs.map((c) => c.id))
      }
      case 'remove_image': {
        const im = inUseImg(req.reference) ?? world.images.find((i) => i.id === req.reference)
        if (!im) throw apiError('not_found', `No existe la imagen ${req.reference}`)
        return mk({ type: 'confirm' }, [{ kind: 'image', id: im.id, name: im.reference, size_bytes: im.size_bytes }], im.containers ? [{ type: 'in_use', count: im.containers }] : [], im.size_bytes, [im.id])
      }
      case 'prune_images': {
        const un = world.images.filter((i) => !i.containers)
        const total = un.reduce((a, i) => a + i.size_bytes, 0)
        return mk({ type: un.length ? 'confirm' : 'allow' }, un.map((i) => ({ kind: 'image', id: i.id, name: i.reference, size_bytes: i.size_bytes })), [], total, un.map((i) => i.id))
      }
      case 'remove_volume': {
        const v = world.volumes.find((x) => x.name === req.name)
        if (!v) throw apiError('not_found', `No existe el volumen ${req.name}`)
        return mk({ type: 'confirm_typed', expected: v.name }, [{ kind: 'volume', id: v.name, name: v.name, size_bytes: v.size_bytes }], [], v.size_bytes, [v.name])
      }
      case 'prune_volumes': {
        const un = world.volumes.filter((v) => !v.used_by.length)
        const total = un.reduce((a, v) => a + (v.size_bytes ?? 0), 0)
        return mk({ type: 'confirm_typed', expected: 'ELIMINAR' }, un.map((v) => ({ kind: 'volume', id: v.name, name: v.name, size_bytes: v.size_bytes })), [], total, un.map((v) => v.name))
      }
      case 'remove_network': {
        const n = world.networks.find((x) => x.id === req.id || x.name === req.id)
        if (!n) throw apiError('not_found', `No existe la red ${req.id}`)
        if (n.system) throw apiError('conflict', `«${n.name}» es una red del sistema y no se puede eliminar.`)
        if (n.connected.length) throw apiError('conflict', `La red «${n.name}» tiene contenedores conectados.`)
        return mk({ type: 'confirm' }, [{ kind: 'network', id: n.id, name: n.name }], [], null, [n.id])
      }
      case 'stack_down': {
        const cs = world.containers.filter((c) => c.compose_project === req.project)
        if (!cs.length) throw apiError('not_found', `No existe el stack ${req.project}`)
        return mk({ type: 'confirm_typed', expected: req.project }, cs.map((c) => ({ kind: 'container', id: c.id, name: c.names[0], state: c.state })), [], null, cs.map((c) => c.id))
      }
      case 'prune_system':
        return mk({ type: 'deny', reason: 'forbidden' }, [])
    }
  }

  async function execute(ticket: string, typed?: string | null): Promise<ActionOutcome> {
    const t = tickets.get(ticket)
    if (!t) throw apiError('ticket_invalid', 'La confirmación no existe o ya se usó.')
    if (Date.now() > t.expires) {
      tickets.delete(ticket)
      throw apiError('ticket_expired', 'La confirmación caducó (120 s).')
    }
    if (t.decision.type === 'confirm_typed' && (typed ?? '').trim() !== t.decision.expected) {
      if (++t.attempts >= 5) tickets.delete(ticket)
      throw apiError('typed_mismatch', 'El texto escrito no coincide.')
    }
    tickets.delete(ticket) // un solo uso
    await sleep(latency)
    const out: ActionOutcome = { succeeded: [], failed: [], freed_bytes: null }
    let freed = 0
    const req = t.request
    if (req.type === 'remove_containers' || req.type === 'stack_down') {
      for (const id of t.ids) {
        const c = world.containers.find((x) => x.id === id)
        if (!c) { out.failed.push({ item: { kind: 'container', id, name: id.slice(0, 12) }, error: apiError('not_found', 'Ya no existe.') }); continue }
        if (mutate) {
          world.containers = world.containers.filter((x) => x !== c)
          delete world.usage[c.names[0]]
          for (const im of world.images) if (im.id === c.image_id) im.containers = Math.max(0, im.containers - 1)
          for (const v of world.volumes) v.used_by = v.used_by.filter((n) => n !== c.names[0])
          for (const n of world.networks) n.connected = n.connected.filter((x) => x !== c.names[0])
          emitContainer(c, 'destroy')
        }
        out.succeeded.push({ kind: 'container', id, name: c.names[0] })
      }
    } else if (req.type === 'remove_image' || req.type === 'prune_images') {
      for (const id of t.ids) {
        const im = world.images.find((x) => x.id === id)
        if (!im) continue
        if (im.containers) { out.failed.push({ item: { kind: 'image', id, name: im.reference }, error: apiError('conflict', 'La imagen la usa un contenedor.') }); continue }
        if (mutate) world.images = world.images.filter((x) => x !== im)
        freed += im.size_bytes
        out.succeeded.push({ kind: 'image', id, name: im.reference })
        if (mutate) emitKind('image', 'delete', id)
      }
    } else if (req.type === 'remove_volume' || req.type === 'prune_volumes') {
      for (const name of t.ids) {
        const v = world.volumes.find((x) => x.name === name)
        if (!v) continue
        if (mutate) world.volumes = world.volumes.filter((x) => x !== v)
        freed += v.size_bytes ?? 0
        out.succeeded.push({ kind: 'volume', id: name, name })
        if (mutate) emitKind('volume', 'destroy', name)
      }
    } else if (req.type === 'remove_network') {
      for (const id of t.ids) {
        const n = world.networks.find((x) => x.id === id)
        if (!n) continue
        if (mutate) world.networks = world.networks.filter((x) => x !== n)
        out.succeeded.push({ kind: 'network', id, name: n.name })
        if (mutate) emitKind('network', 'destroy', id)
      }
    }
    out.freed_bytes = freed || null
    return out
  }

  // ------------------------------------------------------------- flujos simulados
  const layers = PULL_LAYERS

  const capabilities: Record<Feature, Capability> = {
    connection: 'live', containers: 'live', images: 'live', volumes: 'live', networks: 'live', actions: 'live', events: 'live', logs: 'live', stats: 'live', inspect: 'live', system: 'live',
    exec: 'simulated', pull: 'simulated', create: 'simulated', stacks: 'simulated', connections: 'simulated',
  }

  const api: SimEngineApi = {
    mode: 'browser',
    // En navegador TODO es simulado: la UI lo distingue por `mode`, no por estas capacidades (que describen el adaptador Tauri).
    capabilities,
    sim: {
      world,
      emit,
      failStart,
      setFault(f) {
        fault = f
      },
    },
    connection: {
      async status() {
        return statusOf()
      },
      async reconnect() {
        await sleep(Math.min(latency, 400))
        if (fault && !profile().failsToConnect) return statusOf() // «Sigue sin conectar»: el diagnóstico no cambia
        return statusOf()
      },
      async profiles() {
        return world.profiles.map((p) => ({ ...p }))
      },
      activeId: () => active,
      async select(id) {
        if (!world.profiles.some((p) => p.id === id)) throw apiError('not_found', `No existe la conexión ${id}`)
        active = id
        if (id !== 'staging') fault = fault && id === 'local' ? fault : null
        return statusOf()
      },
    },
    containers: {
      async list(all = true) {
        return world.containers.filter((c) => all || c.state === 'running').map((c) => ({ ...c }))
      },
      async inspect(id) {
        return detailOf(find(id))
      },
      start: (id) => changeState(id, 'start'),
      stop: (id) => changeState(id, 'stop'),
      restart: (id) => changeState(id, 'restart'),
      async statsSnapshot(ids) {
        return ids.map((id) => {
          const c = world.containers.find((x) => x.id === id)
          return { id, stats: c && c.state === 'running' ? statsFor(c) : null, error: null }
        })
      },
      streamLogs(id, o, on) {
        let stopped = false
        const c = find(id)
        const timers: ReturnType<typeof setTimeout>[] = []
        const line = (lvl: string, msg: string, ts: number): LogLine => ({ stream: lvl === 'ERROR' ? 'stderr' : 'stdout', timestamp: new Date(ts).toISOString(), message: `[${lvl}] ${msg}`, truncated: false })
        const base = Date.now() - LOG_SEED.length * 5000
        const seed = LOG_SEED.slice(-Math.max(1, o.tail)).map((l, i) => line(l[0], l[1], base + i * 5000))
        timers.push(setTimeout(() => {
          if (stopped) return
          on({ type: 'lines', lines: seed, dropped: 0 } satisfies LogFeed)
          if (!o.follow) return on({ type: 'ended', reason: 'eof', error: null })
          if (!isOn(c.state)) return on({ type: 'ended', reason: 'container_stopped', error: null })
          let i = 0
          const iv = setInterval(() => {
            if (stopped) return
            const l = LIVE_LOGS[i++ % LIVE_LOGS.length]
            on({ type: 'lines', lines: [line(l[0], l[1], Date.now())], dropped: 0 })
          }, 1500)
          timers.push(iv as unknown as ReturnType<typeof setTimeout>)
        }, 0))
        return () => {
          stopped = true
          for (const t of timers) { clearTimeout(t); clearInterval(t) }
        }
      },
      streamStats(id, on) {
        const c = find(id)
        const iv = setInterval(() => on(statsFor(c)), 1000)
        setTimeout(() => on(statsFor(c)), 0)
        return () => clearInterval(iv)
      },
    },
    system: {
      // Datos de ejemplo coherentes con el mundo simulado (la capa real vive en el adaptador Tauri).
      async usage() {
        const GiB = 1024 ** 3
        const rw = world.containers.map((c) => ({ id: c.id, size_rw_bytes: ((c.id.length * 7 + [...c.id].reduce((a, ch) => a + ch.charCodeAt(0), 0)) % 180 + 4) * 1024 * 1024 }))
        const imgBytes = [...new Map(world.images.map((i) => [i.id, i.size_bytes])).values()].reduce((a, b) => a + b, 0)
        const volBytes = world.volumes.reduce((a, v) => a + (v.size_bytes ?? 0), 0)
        const rwBytes = rw.reduce((a, r) => a + r.size_rw_bytes, 0)
        return {
          host: { cpu_count: 16, mem_total_bytes: 32 * GiB },
          disk: {
            images: { total_bytes: imgBytes, reclaimable_bytes: Math.round(imgBytes * 0.3) },
            containers: { total_bytes: rwBytes, reclaimable_bytes: Math.round(rwBytes * 0.5) },
            volumes: { total_bytes: volBytes, reclaimable_bytes: Math.round(volBytes * 0.1) },
            build_cache: { total_bytes: null, reclaimable_bytes: null },
          },
          container_disk: rw,
          disk_known: true,
        }
      },
      async gpu() {
        return [{ index: 0, name: 'NVIDIA GeForce RTX 3060 (ejemplo)', utilization_percent: 8 + Math.round(Math.random() * 10), mem_used_bytes: 1.2 * 1024 ** 3, mem_total_bytes: 12 * 1024 ** 3, temperature_c: 52 }]
      },
    },
    images: { list: async () => world.images.map((i) => ({ ...i })) },
    volumes: { list: async () => world.volumes.map((v) => ({ ...v })) },
    networks: { list: async () => world.networks.map((n) => ({ ...n })) },
    actions: {
      async plan(req) {
        return plan(req)
      },
      execute,
      async cancel(ticket) {
        tickets.delete(ticket)
      },
    },
    events: {
      subscribe(on) {
        subs.add(on)
        return () => subs.delete(on)
      },
    },
    exec: { open: (id) => createSimTerminal(id.slice(0, 12)) },
    pull: {
      start(ref, on) {
        let stopped = false
        const pct = layers.map(() => 0)
        const snap = (state: PullProgress['state'], error?: string): PullProgress => ({ state, error, layers: layers.map((l, i) => ({ id: l[0], total: l[1], done: (l[1] * pct[i]) / 100 })) })
        const rate = /429|ratelimit/i.test(ref)
        const iv = setInterval(() => {
          if (stopped) return
          const i = pct.findIndex((v) => v < 100)
          if (i < 0) { clearInterval(iv); on(snap('done')); return }
          if (rate && i === 2 && pct[i] > 12) { clearInterval(iv); on(snap('error', 'El registro respondió 429 (demasiadas peticiones). Espera unos minutos o inicia sesión en el registro.')); return }
          pct[i] = Math.min(100, pct[i] + 7 + Math.random() * 9)
          if (i + 1 < pct.length && pct[i] > 40) pct[i + 1] = Math.min(100, pct[i + 1] + 4)
          on(snap('pulling'))
        }, tick)
        on(snap('pulling'))
        return () => { stopped = true; clearInterval(iv) }
      },
    },
    create: {
      async submit(spec, mode) {
        await sleep(Math.min(latency, 300))
        const name = spec.name || spec.image.split('/').pop()!.split(':')[0] + '-1'
        if (mutate) {
          if (world.containers.some((c) => c.names.includes(name))) throw apiError('conflict', `Ya existe un contenedor llamado ${name}.`)
          const c: Container = {
            id: uuidv7().replace(/-/g, '').padEnd(64, '0').slice(0, 64), names: [name], image: spec.image, image_id: 'sha256:' + '0'.repeat(64), state: mode === 'start' ? 'running' : 'created',
            status: mode === 'start' ? 'Up Less than a second' : 'Created', created: Math.floor(Date.now() / 1000), compose_project: null, compose_service: null,
            ports: spec.ports.filter((p) => p.host && p.container).map((p) => ({ ip: '0.0.0.0', private_port: Number(p.container), public_port: Number(p.host), protocol: p.protocol })),
            mounts: [], networks: [spec.network],
          }
          world.containers.unshift(c)
          if (mode === 'start') world.usage[name] = { cpu: 0.3, memMb: 18 }
          emitContainer(c, 'create')
        }
        return { simulated: true as const, name }
      },
    },
    stacks: {
      async list() {
        return structuredClone(world.stacks)
      },
      up(name, on) {
        let stopped = false
        const p = UP_SERVICES.map(() => 0)
        const snap = (state: UpProgress['state']): UpProgress => ({ state, services: UP_SERVICES.map((s, i) => ({ name: s, percent: p[i], phase: p[i] >= 100 ? 'started' : p[i] >= 70 ? 'creating' : p[i] > 0 ? 'pulling' : 'waiting' })) })
        void name
        const iv = setInterval(() => {
          if (stopped) return
          const i = p.findIndex((v) => v < 100)
          if (i < 0) { clearInterval(iv); on(snap('done')); return }
          p[i] = Math.min(100, p[i] + 14 + Math.random() * 12)
          on(snap('running'))
        }, tick)
        on(snap('running'))
        return () => { stopped = true; clearInterval(iv) }
      },
      async down() { await sleep(Math.min(latency, 300)) },
      async restart() { await sleep(Math.min(latency, 300)) },
      async read(name) {
        const s = world.stacks.find((x) => x.name === name)
        return { yaml: name === 'broken' ? BROKEN_YAML : SAMPLE_YAML, env: SAMPLE_ENV, path: s ? s.path.replace(/[^/]+$/, '') : `~/proyectos/${name}/` }
      },
      async save() { await sleep(Math.min(latency, 200)) },
      async composeAvailable() { return true },
    },
    connections: {
      async test(spec: ConnSpec) {
        await sleep(Math.min(latency + 500, 1400))
        return /fail/i.test(spec.host) ? 'fail' : 'ok'
      },
      async save(spec) {
        const p: ConnectionProfile = { id: uuidv7(), name: spec.name || spec.host, target: `${spec.kind === 'ssh' ? 'ssh' : 'tcp'}://${spec.user ? spec.user + '@' : ''}${spec.host}`, kind: spec.kind, icon: 'server', remote: true, version: 'Docker 26.1.4 · API 1.45', simulated: true }
        if (mutate) world.profiles.push(p)
        return p
      },
    },
  }
  return api
}

export type { StackSummary }
