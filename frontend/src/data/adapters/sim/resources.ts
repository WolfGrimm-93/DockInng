// Simulado: crear volumen / red (create_volume, create_network). Duplicado -> conflict; CIDR inválido -> invalid_input.
import { cidrOverlaps, gatewayInside, parseCidr } from '@/lib/cidr'
import { uuidv7 } from '@/lib/uuid7'
import type { EngineApi } from '../../api'
import { apiError, sleep, type SimCtx } from './ctx'
import { fullId } from './fixtures'

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

export function createSimResources(ctx: SimCtx): { createVolume: EngineApi['volumes']['create']; createNetwork: EngineApi['networks']['create'] } {
  return {
    async createVolume(spec) {
      await sleep(Math.min(ctx.latency, 200))
      if (!NAME_RE.test(spec.name) || spec.name.length < 2) throw apiError('invalid_input', 'El nombre solo admite letras, números, «_», «.» y «-», y debe empezar por letra o número.')
      if (ctx.world.volumes.some((v) => v.name === spec.name)) throw apiError('conflict', `Ya existe un volumen llamado ${spec.name}.`)
      const v = {
        name: spec.name, driver: 'local', mountpoint: `/var/lib/docker/volumes/${spec.name}/_data`, created_at: new Date().toISOString(),
        labels: { ...spec.labels }, compose_project: null, size_bytes: 0, used_by: [] as string[], anonymous: false,
      }
      if (ctx.mutate) {
        ctx.world.volumes.unshift(v)
        ctx.emitKind('volume', 'create', v.name)
      }
      return { ...v }
    },
    async createNetwork(spec) {
      await sleep(Math.min(ctx.latency, 200))
      if (!NAME_RE.test(spec.name) || spec.name.length < 2) throw apiError('invalid_input', 'El nombre solo admite letras, números, «_», «.» y «-», y debe empezar por letra o número.')
      if (['bridge', 'host', 'none', 'default'].includes(spec.name.toLowerCase())) throw apiError('invalid_input', `«${spec.name}» es un nombre reservado por Docker.`)
      if (ctx.world.networks.some((n) => n.name === spec.name)) throw apiError('conflict', `Ya existe una red llamada ${spec.name}.`)
      if (spec.subnet) {
        const c = parseCidr(spec.subnet)
        if (!c) throw apiError('invalid_input', `La subred «${spec.subnet}» no es un CIDR válido.`)
        const clash = ctx.world.networks.find((n) => n.subnets.some((s) => cidrOverlaps(s, spec.subnet as string)))
        if (clash) throw apiError('conflict', `Pool overlaps with other one on this address space (${clash.name}).`)
        if (spec.gateway && !gatewayInside(spec.subnet, spec.gateway)) throw apiError('invalid_input', 'La puerta de enlace no está dentro de la subred.')
      } else if (spec.gateway) throw apiError('invalid_input', 'La puerta de enlace necesita una subred.')
      const n = {
        id: fullId(uuidv7().replace(/-/g, '')), name: spec.name, driver: 'bridge', scope: 'local', subnets: spec.subnet ? [spec.subnet] : ['172.30.0.0/16'],
        internal: spec.internal, system: false, connected: [] as string[], compose_project: null,
      }
      if (ctx.mutate) {
        ctx.world.networks.push(n)
        ctx.emitKind('network', 'create', n.id)
      }
      return { ...n }
    },
  }
}
