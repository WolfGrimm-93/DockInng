// Simulado: construcción de imágenes (`build_plan` + `subscribe_build`). Valida como el backend (contexto, Dockerfile relativo, tag, ARG),
// pide ticket si el contexto es sensible y emite líneas «Step n/m» + progreso. Cancelar = Unsubscribe (sin `ended`, como tras un abort real).
// Contextos que contengan «fail» terminan mal a mitad de camino (para probar el estado de error).
import type { EngineApi } from '../../api'
import type { BuildPlan, BuildSpec, BuildWarning } from '../../types'
import { isReservedArgName } from '@/lib/buildArgs'
import { validateImageRef, normalizeImageRef } from '@/lib/imageRef'
import { uuidv7 } from '@/lib/uuid7'
import { apiError, type SimCtx } from './ctx'
import { fullId } from './fixtures'

const SENSITIVE = [/^\/$/, /^\/(?:root|home|etc|usr|var|boot|proc|sys|dev|bin|sbin|lib|lib64|opt)\/?$/, /^\/home\/[^/]+\/?$/]
const SECRET_ARG = /PASSWORD|TOKEN|SECRET|KEY/i

export function createSimBuild(ctx: SimCtx): Pick<EngineApi['images'], 'planBuild' | 'build'> {
  const tickets = new Set<string>()
  const validate = (spec: BuildSpec): BuildWarning[] => {
    const dir = spec.context_dir.trim()
    if (!dir) throw apiError('invalid_input', 'Indica el directorio de contexto.')
    if (!dir.startsWith('/')) throw apiError('invalid_input', 'El contexto debe ser una ruta absoluta.')
    if (spec.dockerfile !== null && (spec.dockerfile.startsWith('/') || spec.dockerfile.split('/').includes('..'))) throw apiError('invalid_input', 'El Dockerfile debe ser una ruta relativa dentro del contexto (sin «..»).')
    if (spec.tag !== null) { const bad = validateImageRef(spec.tag); if (bad) throw apiError('invalid_input', bad) }
    for (const [k, v] of spec.build_args) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw apiError('invalid_input', `El nombre del argumento «${k}» no es válido.`)
      if (isReservedArgName(k)) throw apiError('invalid_input', `El argumento «${k}» es un nombre reservado.`)
      if (/[\r\n]/.test(v)) throw apiError('invalid_input', 'El valor de un argumento no puede tener saltos de línea.')
    }
    const warnings: BuildWarning[] = []
    if (SENSITIVE.some((r) => r.test(dir))) warnings.push({ type: 'sensitive_context', path: dir })
    for (const [k] of spec.build_args) if (SECRET_ARG.test(k)) warnings.push({ type: 'secret_like_arg', name: k })
    return warnings
  }
  return {
    async planBuild(spec): Promise<BuildPlan> {
      const warnings = validate(spec)
      const sensitive = warnings.some((w) => w.type === 'sensitive_context')
      if (!sensitive) return { warnings, decision: { type: 'allow' }, ticket: null, expires_in_secs: 0 }
      const ticket = uuidv7()
      tickets.add(ticket)
      return { warnings, decision: { type: 'confirm' }, ticket, expires_in_secs: 120 }
    },
    build(spec, ticket, on) {
      let stopped = false
      const timers: ReturnType<typeof setTimeout>[] = []
      const fail = (message: string) => timers.push(setTimeout(() => !stopped && on({ type: 'ended', outcome: 'failed', image_id: null, error: { code: 'engine', message } }), 0))
      let warnings: BuildWarning[]
      try { warnings = validate(spec) } catch (e) { fail((e as { message: string }).message); return () => { stopped = true } }
      if (warnings.some((w) => w.type === 'sensitive_context') && !(ticket && tickets.delete(ticket))) {
        fail('El contexto es sensible: hace falta confirmarlo antes de construir.')
        return () => { stopped = true }
      }
      const steps = ['FROM node:20-bookworm-slim', 'WORKDIR /app', 'COPY package*.json ./', 'RUN npm ci --omit=dev', 'COPY . .', 'CMD ["node","dist/main.js"]']
      const total = steps.length
      const willFail = /fail/i.test(spec.context_dir)
      let i = 0
      const iv = setInterval(() => {
        if (stopped) return clearInterval(iv)
        if (i === 0) on({ type: 'line', text: `Sending build context to Docker daemon  ${spec.no_cache ? '2.1MB' : '1.3MB'}`, stream: 'stdout' })
        if (i < total) {
          on({ type: 'step', n: i + 1, total })
          on({ type: 'line', text: `Step ${i + 1}/${total} : ${steps[i]}`, stream: 'stdout' })
          if (i === 3) on({ type: 'line', text: 'npm warn deprecated inflight@1.0.6: This module is not supported', stream: 'stderr' })
          if (willFail && i === 3) {
            clearInterval(iv)
            on({ type: 'line', text: 'npm error code ELIFECYCLE', stream: 'stderr' })
            return on({ type: 'ended', outcome: 'failed', image_id: null, error: { code: 'engine', message: "The command '/bin/sh -c npm ci --omit=dev' returned a non-zero code: 1" } })
          }
          i++
          return
        }
        clearInterval(iv)
        const id = `sha256:${fullId(uuidv7().replace(/-/g, ''))}`
        on({ type: 'line', text: `Successfully built ${id.slice(7, 19)}`, stream: 'stdout' })
        if (spec.tag) {
          on({ type: 'line', text: `Successfully tagged ${spec.tag}`, stream: 'stdout' })
          if (ctx.mutate) {
            const ref = normalizeImageRef(spec.tag)
            const [repo, tag = 'latest'] = ref.split(/:(?=[^/]*$)/)
            ctx.world.images = ctx.world.images.filter((im) => im.reference !== ref)
            ctx.world.images.unshift({ id, reference: ref, repository: repo, tag, size_bytes: 187 * 1024 * 1024, created: Math.floor(Date.now() / 1000), containers: 0, dangling: false })
            ctx.emitKind('image', 'tag', id)
          }
        }
        on({ type: 'ended', outcome: 'ok', image_id: id, error: null })
      }, Math.max(1, ctx.tick))
      timers.push(iv as unknown as ReturnType<typeof setTimeout>)
      return () => { stopped = true; for (const t of timers) { clearTimeout(t); clearInterval(t) } }
    },
  }
}
