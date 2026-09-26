// Simulado: plan_create_container + create_container. Valida como el motor (nombre/puertos/volúmenes/env), avisa de riesgos,
// exige ticket si el plan lo pide, NUNCA descarga la imagen (image_missing) y crea el contenedor en el mundo simulado.
import { normalizeImageRef } from '@/lib/imageRef'
import { sensitiveBind } from '@/lib/sensitiveBind'
import { uuidv7 } from '@/lib/uuid7'
import type { EngineApi } from '../../api'
import type { CreateContainerSpec, CreatePlan, CreateWarning, FieldError, PlanDecision } from '../../types'
import { apiError, sleep, type SimCtx } from './ctx'
import { fullId } from './fixtures'

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function createSimCreate(ctx: SimCtx): { planCreate: EngineApi['containers']['planCreate']; create: EngineApi['containers']['create'] } {
  const tickets = new Map<string, string>() // ticket -> huella del spec

  const hash = (s: CreateContainerSpec) => JSON.stringify(s)

  function evaluate(spec: CreateContainerSpec): { field_errors: FieldError[]; warnings: CreateWarning[]; decision: PlanDecision } {
    const errs: FieldError[] = []
    const warnings: CreateWarning[] = []
    if (!spec.image.trim() || /\s/.test(spec.image)) errs.push({ field: 'image', message: 'La imagen no es válida.' })
    if (spec.name !== null && spec.name !== '' && !NAME_RE.test(spec.name)) errs.push({ field: 'name', message: 'Nombre no válido.' })
    if (spec.name && ctx.world.containers.some((c) => c.names.includes(spec.name as string))) errs.push({ field: 'name', message: `Ya existe un contenedor llamado ${spec.name}.` })
    spec.ports.forEach((p, i) => {
      if (p.container_port < 1 || p.container_port > 65535) errs.push({ field: `ports[${i}].container_port`, message: 'Puerto fuera de rango (1–65535).' })
      if (p.host_port !== null && (p.host_port < 1 || p.host_port > 65535)) errs.push({ field: `ports[${i}].host_port`, message: 'Puerto fuera de rango (1–65535).' })
      if (p.host_port !== null) {
        const by = ctx.world.containers.find((c) => c.state === 'running' && c.ports.some((x) => x.public_port === p.host_port))
        if (by) warnings.push({ type: 'port_in_use', port: p.host_port, by: by.names[0] })
        if (!p.host_ip || p.host_ip === '0.0.0.0') warnings.push({ type: 'published_all_interfaces', port: p.host_port })
      }
    })
    spec.volumes.forEach((v, i) => {
      if (!v.target.startsWith('/')) errs.push({ field: `volumes[${i}].target`, message: 'La ruta del contenedor debe ser absoluta.' })
      if (/^\.{1,2}(\/|$)/.test(v.source)) errs.push({ field: `volumes[${i}].source`, message: 'Usa una ruta absoluta o el nombre de un volumen.' })
      const w = sensitiveBind(v.source, v.read_only)
      if (w) warnings.push(/docker\.sock$/.test(v.source) ? { type: 'docker_socket' } : { type: 'sensitive_bind', source: v.source, reason: w.text })
    })
    if (ctx.isRemote()) for (const v of spec.volumes) if (v.source.startsWith('/')) warnings.push({ type: 'remote_bind', source: v.source })
    const seen = new Set<string>()
    spec.env.forEach((e, i) => {
      if (!ENV_RE.test(e.key)) errs.push({ field: `env[${i}].key`, message: 'Nombre de variable no válido.' })
      if (seen.has(e.key)) errs.push({ field: `env[${i}].key`, message: 'Variable repetida.' })
      seen.add(e.key)
    })
    if (spec.network && !['bridge', 'host', 'none'].includes(spec.network) && !ctx.world.networks.some((n) => n.name === spec.network)) errs.push({ field: 'network', message: `No existe la red ${spec.network}.` })
    if (spec.network === 'host') warnings.push({ type: 'host_network' })
    const needsConfirm = warnings.some((w) => w.type === 'sensitive_bind' || w.type === 'docker_socket' || w.type === 'host_network')
    return { field_errors: errs, warnings, decision: needsConfirm ? { type: 'confirm' } : { type: 'allow' } }
  }

  return {
    async planCreate(spec) {
      await sleep(Math.min(ctx.latency, 100))
      const e = evaluate(spec)
      const ok = e.field_errors.length === 0
      let ticket: string | null = null
      if (ok && e.decision.type === 'confirm') {
        ticket = uuidv7()
        if (tickets.size >= 32) tickets.delete(tickets.keys().next().value as string)
        tickets.set(ticket, hash(spec))
      }
      const plan: CreatePlan = { ok, ...e, ticket, expires_in_secs: 120, normalized: spec }
      return plan
    },
    async create(spec, start, ticket) {
      await sleep(Math.min(ctx.latency, 300))
      const e = evaluate(spec)
      if (e.field_errors.length) {
        const f = e.field_errors[0]
        throw apiError(f.field === 'name' && /^Ya existe/.test(f.message) ? 'conflict' : 'invalid_input', f.message)
      }
      if (e.decision.type !== 'allow') {
        if (!ticket || tickets.get(ticket) !== hash(spec)) throw apiError('ticket_invalid', 'La confirmación no existe, ya se usó o no corresponde a este contenedor.')
        tickets.delete(ticket)
      }
      const img = ctx.world.images.find((i) => i.reference === normalizeImageRef(spec.image) || i.id === spec.image)
      if (!img) throw apiError('image_missing', `No such image: ${spec.image}`)
      const name = spec.name || `${spec.image.split('/').pop()!.split(':')[0].split('@')[0]}-${Math.floor(Math.random() * 90 + 10)}`
      const id = fullId(uuidv7().replace(/-/g, ''))
      let started = false
      let startError = null
      if (start) {
        const clash = spec.ports.find((p) => p.host_port !== null && ctx.world.containers.some((c) => c.state === 'running' && c.ports.some((x) => x.public_port === p.host_port)))
        if (clash) startError = apiError('conflict', `driver failed programming external connectivity: Bind for 0.0.0.0:${clash.host_port} failed: port is already allocated`)
        else started = true
      }
      if (ctx.mutate) {
        const c = {
          id, names: [name], image: spec.image, image_id: img.id, state: started ? ('running' as const) : ('created' as const),
          status: started ? 'Up Less than a second' : 'Created', created: Math.floor(Date.now() / 1000), compose_project: null, compose_service: null,
          ports: spec.ports.map((p) => ({ ip: p.host_ip ?? (p.host_port !== null ? '0.0.0.0' : null), private_port: p.container_port, public_port: p.host_port, protocol: p.protocol })),
          mounts: spec.volumes.map((v) => (v.source.startsWith('/') || v.source.startsWith('~')
            ? { kind: 'bind' as const, name: null, source: v.source, destination: v.target, read_write: !v.read_only }
            : { kind: 'volume' as const, name: v.source, source: `/var/lib/docker/volumes/${v.source}/_data`, destination: v.target, read_write: !v.read_only })),
          networks: [spec.network ?? 'bridge'], endpoints: [],
        }
        ctx.world.containers.unshift(c)
        img.containers += 1
        if (started) ctx.world.usage[name] = { cpu: 0.3, memMb: 18 }
        ctx.emitContainer(c, 'create')
        if (started) ctx.emitContainer(c, 'start')
      }
      return { id, name, started, warnings: e.warnings.filter((w) => w.type === 'published_all_interfaces').map((w) => `Puerto ${(w as { port: number }).port} publicado en todas las interfaces`), start_error: startError }
    },
  }
}
