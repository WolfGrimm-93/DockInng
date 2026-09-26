// Simulado: descarga de imágenes por capas (subscribe_pull). Bytes reales por capa, fases y errores por nombre.
// Cancelar = Unsubscribe (sin `ended`, como el backend real tras un abort).
import type { EngineApi } from '../../api'
import type { LayerPhase, PullLayer } from '../../types'
import { normalizeImageRef } from '@/lib/imageRef'
import { uuidv7 } from '@/lib/uuid7'
import type { SimCtx } from './ctx'
import { PULL_LAYERS, fullId } from './fixtures'

const MB = 1024 * 1024

export function createSimPull(ctx: SimCtx): EngineApi['images']['pull'] {
  return (reference, on) => {
    let stopped = false
    const total = PULL_LAYERS.map(([, mb]) => Math.round(mb * MB))
    const done = PULL_LAYERS.map(() => 0)
    const phase: LayerPhase[] = PULL_LAYERS.map(() => 'waiting')
    const layers = (): PullLayer[] => PULL_LAYERS.map((l, i) => ({ id: l[0], phase: phase[i], total: total[i], done: done[i] }))
    const sums = () => ({ done_bytes: done.reduce((a, b) => a + b, 0), total_bytes: total.reduce((a, b) => a + b, 0) })
    const end = (o: { outcome: 'done' | 'error'; code?: 'engine' | 'image_missing' | 'auth_required' | 'registry_unreachable'; msg?: string }) =>
      on({ type: 'ended', outcome: o.outcome, up_to_date: false, digest: o.outcome === 'done' ? `sha256:${fullId(uuidv7().replace(/-/g, '')).slice(0, 64)}` : null, error: o.code ? { code: o.code, message: o.msg ?? '' } : null })

    const bad = /429|ratelimit/i.test(reference) ? 'rate' : /404|no-?existe|notfound/i.test(reference) ? 'missing' : /private|auth/i.test(reference) ? 'auth' : /offline|unreach/i.test(reference) ? 'net' : null
    const t0 = setTimeout(() => {
      if (stopped) return
      if (bad === 'missing') return end({ outcome: 'error', code: 'image_missing', msg: `failed to resolve reference "${reference}": ${reference}: not found` })
      if (bad === 'auth') return end({ outcome: 'error', code: 'auth_required', msg: `pull access denied for ${reference}, repository does not exist or may require authorization` })
      if (bad === 'net') return end({ outcome: 'error', code: 'registry_unreachable', msg: 'dial tcp: connect: connection refused' })
      on({ type: 'started', reference })
      const iv = setInterval(() => {
        if (stopped) return clearInterval(iv)
        const i = done.findIndex((d, k) => d < total[k])
        if (i < 0) {
          clearInterval(iv)
          if (ctx.mutate && !ctx.world.images.some((im) => im.reference === normalizeImageRef(reference))) {
            const [repo, tag = 'latest'] = normalizeImageRef(reference).split(/:(?=[^/]*$)/)
            ctx.world.images.unshift({ id: `sha256:${fullId(uuidv7().replace(/-/g, ''))}`, reference: `${repo}:${tag}`, repository: repo, tag, size_bytes: total.reduce((a, b) => a + b, 0), created: Math.floor(Date.now() / 1000), containers: 0, dangling: false })
            ctx.emitKind('image', 'pull', reference)
          }
          return end({ outcome: 'done' })
        }
        if (bad === 'rate' && i === 2 && done[i] > total[i] * 0.12) {
          clearInterval(iv)
          return end({ outcome: 'error', code: 'engine', msg: 'toomanyrequests: You have reached your pull rate limit.' })
        }
        phase[i] = 'downloading'
        done[i] = Math.min(total[i], done[i] + Math.round(total[i] * (0.07 + Math.random() * 0.09)))
        if (done[i] >= total[i]) phase[i] = 'complete'
        if (i + 1 < done.length && done[i] > total[i] * 0.4 && done[i + 1] === 0) { phase[i + 1] = 'downloading'; done[i + 1] = Math.round(total[i + 1] * 0.04) }
        on({ type: 'progress', layers: layers(), ...sums() })
      }, ctx.tick)
      t1 = iv
      on({ type: 'progress', layers: layers(), ...sums() })
    }, 0)
    let t1: ReturnType<typeof setInterval> | null = null
    return () => {
      stopped = true
      clearTimeout(t0)
      if (t1) clearInterval(t1)
    }
  }
}
