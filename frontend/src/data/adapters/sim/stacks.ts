// Simulado: stacks Compose. Mundo derivado del de contenedores (compose_project) + stacks con archivos (managed/linked).
// Reglas del backend real: discovered no se edita (policy_denied); save con revisión vieja -> state_changed; validate no escribe;
// runOp emite `started` -> `progress` (instantáneas por servicio) -> `ended`; cancel() -> ended canceled; stack_down/delete van por la política.
import { validateCompose } from '@/lib/yamlCheck'
import { uuidv7 } from '@/lib/uuid7'
import type { EngineApi } from '../../api'
import type { ComposeInfo, Container, ServiceProgressRow, StackFiles, StackOpFeed, StackOpKind, StackRisk, StackService, StackSummary, ValidationIssue } from '../../types'
import { apiError, sleep, type SimCtx } from './ctx'
import { BROKEN_YAML, SAMPLE_ENV, UP_SERVICES, fullId, type SimOwnStack } from './fixtures'

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/

export interface SimStackControls {
  setComposeMissing(b: boolean): void
  /** El próximo `save` responde «cambió en disco». */
  failNextSave: boolean
  /** YAML roto de la plantilla (?yaml=broken). */
  brokenYaml: string
}

interface DeclaredService { name: string; image: string }

/** Servicios declarados en un YAML de compose (nombre + imagen), con el mismo criterio que la validación local. */
export function declaredServices(yaml: string): DeclaredService[] {
  const out: DeclaredService[] = []
  let inServices = false
  let cur: DeclaredService | null = null
  for (const ln of yaml.split('\n')) {
    if (/^services:\s*$/.test(ln)) inServices = true
    else if (/^\S/.test(ln)) inServices = false
    const m = ln.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/)
    if (inServices && m) { cur = { name: m[1], image: '' }; out.push(cur) }
    const im = ln.match(/^ {4}image:\s*(\S+)/)
    if (cur && im) cur.image = im[1]
  }
  return out
}

export function createSimStacks(ctx: SimCtx): { api: EngineApi['stacks']; controls: SimStackControls; own: () => SimOwnStack[] } {
  let composeMissing = false
  const controls: SimStackControls = {
    setComposeMissing: (b) => { composeMissing = b },
    failNextSave: false,
    brokenYaml: BROKEN_YAML,
  }
  const own = () => ctx.world.ownStacks
  const ownOf = (name: string) => own().find((s) => s.name === name)
  const containersOf = (name: string) => ctx.world.containers.filter((c) => c.compose_project === name)

  function serviceRows(name: string): StackService[] {
    const cs = containersOf(name)
    const bySvc = new Map<string, Container[]>()
    for (const c of cs) {
      const k = c.compose_service ?? c.names[0]
      bySvc.set(k, [...(bySvc.get(k) ?? []), c])
    }
    const rows: StackService[] = [...bySvc.entries()].map(([svc, list]) => {
      const running = list.filter((c) => c.state === 'running').length
      const state = running > 0 && running === list.length ? 'running' : list.every((c) => c.state === list[0].state) ? list[0].state : running > 0 ? 'running' : list[0].state
      return { name: svc, image: list[0].image, state, replicas: `${running}/${list.length}`, running, total: list.length }
    })
    // Servicios definidos en el archivo que aún no tienen contenedor.
    const o = ownOf(name)
    if (o) for (const d of declaredServices(o.yaml)) if (!bySvc.has(d.name)) rows.push({ name: d.name, image: d.image, state: 'created', replicas: '0/1', running: 0, total: 1 })
    return rows
  }

  function summary(name: string): StackSummary {
    const o = ownOf(name)
    const cs = containersOf(name)
    const running = cs.filter((c) => c.state === 'running').length
    return {
      name,
      origin: o ? o.origin : 'discovered',
      path: o ? o.path : `~/infra/${name}/compose.yaml`,
      config_files: o ? [o.path] : [`~/infra/${name}/compose.yaml`],
      working_dir: o ? o.path.replace(/[^/]+$/, '') : `~/infra/${name}`,
      editable: !!o,
      status: cs.length === 0 ? 'declared' : running === cs.length ? 'running' : running === 0 ? 'stopped' : 'partial',
      containers: cs.length,
      running,
      services: serviceRows(name),
    }
  }

  const names = (): string[] => {
    const set = new Set<string>(own().map((s) => s.name))
    for (const c of ctx.world.containers) if (c.compose_project) set.add(c.compose_project)
    return [...set].sort((a, b) => a.localeCompare(b))
  }

  const filesOf = (o: SimOwnStack): StackFiles => ({
    name: o.name, origin: o.origin, yaml: o.yaml, env: o.env, path: o.path, env_path: o.path.replace(/[^/]+$/, '.env'),
    editable: true, config_files: [o.path], revision: `r${o.revision}`,
  })

  function issuesOf(yaml: string, env: string): { issues: ValidationIssue[]; services: string[]; risks: StackRisk[] } {
    const chk = validateCompose(yaml, env)
    const issues: ValidationIssue[] = chk.list.filter((x) => x.l === 'bad').map((x) => ({
      line: x.line || null, column: null, kind: /tabul/.test(x.msg) ? 'syntax' : 'schema',
      message: x.msg.replace(/^Línea \d+: /, ''),
    }))
    const risks: StackRisk[] = []
    if (/privileged:\s*true/.test(yaml)) risks.push({ type: 'privileged' })
    if (/docker\.sock/.test(yaml)) risks.push({ type: 'docker_sock' })
    if (/network_mode:\s*["']?host/.test(yaml)) risks.push({ type: 'host_network' })
    if (ctx.isRemote()) {
      // Con Compose sobre túnel, `./data` se resuelve en LOCAL a una ruta absoluta que el daemon remoto interpretará en su propio disco.
      const rel = yaml.match(/^\s*-\s*["']?(\.{1,2}\/[^:"'\s]*)/m)
      if (rel) risks.push({ type: 'remote_bind', path: `/home/usuario/proyectos/${rel[1].replace(/^\.\//, '')}` })
    }
    return { issues, services: declaredServices(yaml).map((d) => d.name), risks }
  }

  const stackServiceList = (name: string): DeclaredService[] => {
    const o = ownOf(name)
    const decl = o ? declaredServices(o.yaml) : []
    if (decl.length) return decl
    const fromContainers = containersOf(name).map((c) => ({ name: c.compose_service ?? c.names[0], image: c.image }))
    return fromContainers.length ? fromContainers : UP_SERVICES.map((s) => ({ name: s, image: `${s}:latest` }))
  }

  function mutateAfter(name: string, op: StackOpKind) {
    if (!ctx.mutate) return
    const decl = stackServiceList(name)
    if (op === 'up' || op === 'start' || op === 'restart') {
      for (const d of decl) {
        let c = containersOf(name).find((x) => (x.compose_service ?? x.names[0]) === d.name)
        if (!c) {
          if (op === 'start') continue
          const img = ctx.world.images.find((i) => i.reference === d.image)
          c = {
            id: fullId(uuidv7().replace(/-/g, '')), names: [`${name}-${d.name}-1`], image: d.image, image_id: img?.id ?? `sha256:${'0'.repeat(64)}`, state: 'created', status: 'Created',
            created: Math.floor(Date.now() / 1000), compose_project: name, compose_service: d.name, ports: [], mounts: [], networks: [`${name}_default`], endpoints: [],
          }
          ctx.world.containers.push(c)
          ctx.emitContainer(c, 'create')
        }
        if (c.state !== 'running') {
          c.state = 'running'
          c.status = 'Up Less than a second'
          ctx.world.usage[c.names[0]] = { cpu: 0.4, memMb: 24 }
          ctx.emitContainer(c, 'start')
        }
      }
    } else if (op === 'stop') {
      for (const c of containersOf(name)) {
        if (c.state === 'running') {
          c.state = 'exited'
          c.status = 'Exited (0) Less than a second ago'
          delete ctx.world.usage[c.names[0]]
          ctx.emitContainer(c, 'die')
          ctx.notifyStopped(c.id)
        }
      }
    }
  }

  const api: EngineApi['stacks'] = {
    async composeInfo(_recheck?: boolean): Promise<ComposeInfo> {
      void _recheck
      return composeMissing
        ? { available: false, flavor: 'missing', version: null, supported: false, docker_cli: true }
        : { available: true, flavor: 'plugin', version: '5.5.1', supported: true, docker_cli: true }
    },
    async list() {
      await sleep(Math.min(ctx.latency, 60))
      return structuredClone(names().map(summary))
    },
    runOp(name, op, on) {
      let stopped = false
      let canceled = false
      const timers: ReturnType<typeof setTimeout>[] = []
      const decl = stackServiceList(name)
      const p = decl.map(() => 0)
      const rows = (): ServiceProgressRow[] => decl.map((d, i) => ({ name: d.name, percent: p[i], phase: p[i] >= 100 ? 'started' : p[i] >= 70 ? 'creating' : p[i] > 0 ? 'pulling' : 'waiting' }))
      const fail = composeMissing ? { code: 'compose_missing' as const, msg: 'docker compose no está instalado' } : /fail|roto/.test(name) || /imagen-inexistente/.test(ownOf(name)?.yaml ?? '') ? { code: 'compose_failed' as const, msg: 'Error response from daemon: No such image: imagen-inexistente:latest' } : null
      timers.push(setTimeout(() => {
        if (stopped) return
        on({ type: 'started', op: op.type, stack: name, compose_version: '5.5.1' })
        if (!ownOf(name) && (op.type === 'up' || op.type === 'pull')) return on({ type: 'ended', outcome: 'failed', exit_code: null, error: { code: 'policy_denied', message: `«${name}» solo fue descubierto por sus etiquetas: vincula su archivo Compose para usar ${op.type}.` }, issues: [] })
        if (fail?.code === 'compose_missing') return on({ type: 'ended', outcome: 'failed', exit_code: null, error: { code: fail.code, message: fail.msg }, issues: [] })
        on({ type: 'log', text: ` Network ${name}_default  Creating` })
        on({ type: 'progress', items: [], services: rows() })
        const iv = setInterval(() => {
          if (stopped) return clearInterval(iv)
          const i = p.findIndex((v) => v < 100)
          if (i < 0 || (fail && i >= Math.min(1, decl.length - 1) && p[i] >= 40)) {
            clearInterval(iv)
            if (fail) return on({ type: 'ended', outcome: 'failed', exit_code: 1, error: { code: fail.code, message: fail.msg }, issues: [] })
            mutateAfter(name, op.type)
            return on({ type: 'ended', outcome: 'success', exit_code: 0, error: null, issues: [] })
          }
          p[i] = Math.min(100, p[i] + 24 + Math.random() * 20)
          on({ type: 'log', text: ` Container ${name}-${decl[i].name}-1  ${p[i] >= 100 ? 'Started' : 'Starting'}` })
          on({ type: 'progress', items: [], services: rows() })
        }, ctx.tick)
        timers.push(iv as unknown as ReturnType<typeof setTimeout>)
      }, 0))
      const clear = () => { stopped = true; for (const t of timers) { clearTimeout(t); clearInterval(t) } }
      return {
        cancel() {
          if (stopped || canceled) return
          canceled = true
          clear()
          setTimeout(() => on({ type: 'ended', outcome: 'canceled', exit_code: null, error: null, issues: [] } satisfies StackOpFeed), 0)
        },
        dispose: clear,
      }
    },
    async read(name) {
      await sleep(Math.min(ctx.latency, 60))
      const o = ownOf(name)
      if (o) return filesOf(o)
      // Descubierto: como el backend real, el archivo se LEE (solo lectura); editar/validar/levantar queda denegado.
      if (containersOf(name).length) {
        const s = summary(name)
        const yaml = `name: ${name}\n\nservices:\n${s.services.map((x) => `  ${x.name}:\n    image: ${x.image}\n`).join('')}`
        return { name, origin: 'discovered', yaml, env: '', path: s.path, env_path: s.path.replace(/[^/]+$/, '.env'), editable: false, config_files: s.config_files, revision: 'ro' }
      }
      throw apiError('not_found', `No existe el stack ${name}.`)
    },
    async save(name, f) {
      await sleep(Math.min(ctx.latency, 120))
      const o = ownOf(name)
      if (!o) throw apiError('policy_denied', 'Este stack no es editable.')
      if (controls.failNextSave || (f.expectedRevision !== null && f.expectedRevision !== `r${o.revision}`)) {
        controls.failNextSave = false
        throw apiError('state_changed', 'El archivo cambió en el disco desde que lo abriste.')
      }
      o.yaml = f.yaml
      o.env = f.env
      o.revision++
      return filesOf(o)
    },
    async validate(name, yaml, env) {
      await sleep(Math.min(ctx.latency, 80))
      if (!ownOf(name ?? '') && name !== null && containersOf(name).length) throw apiError('policy_denied', `«${name}» solo fue descubierto: no se puede validar hasta vincular su archivo.`)
      if (composeMissing) throw apiError('compose_missing', 'docker compose no está instalado')
      const r = issuesOf(yaml, env)
      return { ok: r.issues.length === 0, ...r }
    },
    async create(name, yaml, env) {
      await sleep(Math.min(ctx.latency, 100))
      if (!NAME_RE.test(name)) throw apiError('invalid_input', 'El nombre debe ir en minúsculas: letras, números, «-» y «_».')
      if (names().includes(name)) throw apiError('conflict', `Ya existe un stack llamado ${name}.`)
      own().push({ name, origin: 'managed', path: `~/.local/share/dockinng/stacks/${name}/compose.yaml`, yaml, env, revision: 1 })
      return summary(name)
    },
    async link(path) {
      await sleep(Math.min(ctx.latency, 100))
      if (!path.startsWith('/') && !path.startsWith('~/')) throw apiError('invalid_input', 'Indica una ruta absoluta.')
      if (!/\.ya?ml$/.test(path)) throw apiError('invalid_input', 'El archivo debe ser .yml o .yaml.')
      const parts = path.split('/').filter(Boolean)
      const dir = (parts[parts.length - 2] ?? 'stack').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '') || 'stack'
      if (path.includes('no-existe')) throw apiError('not_found', `No se encontró ${path}.`)
      const existing = ownOf(dir)
      if (existing) throw apiError('conflict', `Ya existe un stack llamado ${dir}.`)
      const disc = names().includes(dir)
      own().push({ name: dir, origin: 'linked', path, yaml: `name: ${dir}\n\nservices:\n  app:\n    image: nginx:1.27-alpine\n`, env: SAMPLE_ENV, revision: 1 })
      void disc
      return summary(dir)
    },
    async unlink(name) {
      await sleep(Math.min(ctx.latency, 60))
      const o = ownOf(name)
      if (!o || o.origin !== 'linked') throw apiError('conflict', 'Solo se pueden desvincular stacks vinculados.')
      ctx.world.ownStacks = own().filter((s) => s !== o)
    },
  }
  return { api, controls, own }
}
