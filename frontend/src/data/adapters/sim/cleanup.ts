// Simulado: limpieza guiada (`cleanup_report`) y su ejecución por elemento (`plan_action`/`execute_action` con `{type:'cleanup'}`).
// Estimaciones honestas como el backend: capas compartidas => cota superior; volúmenes con tamaño casi siempre desconocido y riesgo alto,
// nunca marcados por defecto; caché de build solo informativa. NUNCA hay `prune`: se borra elemento a elemento re-verificando que siga sin usarse.
import type { EngineApi } from '../../api'
import type { ActionOutcome, AffectedItem, CleanupCategory, CleanupItem, CleanupReport, CleanupSelection } from '../../types'
import { apiError, type SimCtx } from './ctx'

const MAX_ITEMS = 500
const DAY = 86400

const isStopped = (s: string) => s === 'exited' || s === 'created' || s === 'dead'

export function buildCleanupReport(ctx: SimCtx, minAgeDays: number): CleanupReport {
  const w = ctx.world
  const nowS = Math.floor(Date.now() / 1000)
  const cats: CleanupCategory[] = []
  const sum = (items: CleanupItem[]) => (items.every((i) => i.size_bytes === null) ? null : items.reduce((a, i) => a + (i.size_bytes ?? 0), 0))
  const add = (id: CleanupCategory['id'], items: CleanupItem[], executable = true, reclaimable: number | null = sum(items)) => cats.push({ id, items, reclaimable_bytes: reclaimable, executable })

  add('stopped_containers', w.containers.filter((c) => isStopped(c.state)).map((c): CleanupItem => ({
    kind: 'container', id: c.id, name: c.names[0], size_bytes: ((c.id.length * 7 + [...c.id].reduce((a, ch) => a + ch.charCodeAt(0), 0)) % 180 + 4) * 1024 * 1024,
    estimate: 'exact', reason: c.state === 'dead' ? 'Contenedor muerto' : 'Detenido', risk: 'low', selected_by_default: true,
  })))
  add('dangling_images', w.images.filter((i) => i.dangling && !i.containers).map((i): CleanupItem => ({
    kind: 'image', id: i.id, name: i.reference.slice(0, 19), size_bytes: i.size_bytes, estimate: 'upper_bound',
    reason: 'Imagen colgada (sin nombre)', risk: 'low', selected_by_default: true,
  })))
  add('unused_images', w.images.filter((i) => !i.dangling && !i.containers && nowS - i.created >= minAgeDays * DAY).map((i): CleanupItem => ({
    kind: 'image', id: i.id, name: i.reference, size_bytes: i.size_bytes, estimate: 'upper_bound',
    reason: `Sin contenedores · creada hace ${Math.max(1, Math.round((nowS - i.created) / DAY))} días`, risk: 'medium', selected_by_default: false,
  })))
  add('unused_volumes', w.volumes.filter((v) => !v.used_by.length).map((v, k): CleanupItem => ({
    kind: 'volume', id: v.name, name: v.name, size_bytes: k % 2 === 0 ? null : v.size_bytes, estimate: k % 2 === 0 ? 'unknown' : 'exact',
    reason: v.anonymous ? 'Volumen anónimo sin contenedores' : 'Sin contenedores: puede tener datos', risk: 'high', selected_by_default: false,
  })))
  add('unused_networks', w.networks.filter((n) => !n.system && !n.connected.length).map((n): CleanupItem => ({
    kind: 'network', id: n.id, name: n.name, size_bytes: 0, estimate: 'exact', reason: 'Sin contenedores conectados', risk: 'low', selected_by_default: true,
  })))
  add('build_cache', [], false, 1.3 * 1024 ** 3)

  const all = cats.flatMap((c) => c.items)
  const known = all.filter((i) => i.size_bytes !== null)
  return {
    categories: cats,
    total_reclaimable_bytes: known.length ? known.reduce((a, i) => a + (i.size_bytes ?? 0), 0) : null,
    unknown_count: all.length - known.length,
    generated_at: new Date().toISOString(),
  }
}

/** Elementos afectados de una selección (validando que existan y sigan sin usarse). */
export function planCleanupItems(ctx: SimCtx, sel: CleanupSelection): { affected: AffectedItem[]; hasVolumes: boolean; total: number } {
  const w = ctx.world
  const count = sel.containers.length + sel.images.length + sel.volumes.length + sel.networks.length
  if (!count) throw apiError('invalid_input', 'No hay nada seleccionado.')
  if (count > MAX_ITEMS) throw apiError('invalid_input', `Máximo ${MAX_ITEMS} elementos por limpieza.`)
  const affected: AffectedItem[] = []
  for (const id of sel.containers) { const c = w.containers.find((x) => x.id === id); if (c && isStopped(c.state)) affected.push({ kind: 'container', id, name: c.names[0], state: c.state }) }
  for (const id of sel.images) { const i = w.images.find((x) => x.id === id); if (i && !i.containers) affected.push({ kind: 'image', id, name: i.reference, size_bytes: i.size_bytes }) }
  for (const id of sel.volumes) { const v = w.volumes.find((x) => x.name === id); if (v && !v.used_by.length) affected.push({ kind: 'volume', id, name: v.name, size_bytes: v.size_bytes }) }
  for (const id of sel.networks) { const n = w.networks.find((x) => x.id === id); if (n && !n.system && !n.connected.length) affected.push({ kind: 'network', id, name: n.name }) }
  if (!affected.length) throw apiError('state_changed', 'Nada de lo seleccionado sigue siendo elegible: vuelve a generar el informe.')
  return { affected, hasVolumes: affected.some((a) => a.kind === 'volume'), total: affected.reduce((a, i) => a + (i.size_bytes ?? 0), 0) }
}

/** Ejecuta por elemento; lo que pasó a estar en uso se omite y se informa como fallo. */
export function applyCleanup(ctx: SimCtx, sel: CleanupSelection): ActionOutcome {
  const w = ctx.world
  const out: ActionOutcome = { succeeded: [], failed: [], freed_bytes: null }
  let freed = 0
  const skip = (kind: AffectedItem['kind'], id: string, name: string, why: string) => out.failed.push({ item: { kind, id, name }, error: apiError('state_changed', why) })
  for (const id of sel.containers) {
    const c = w.containers.find((x) => x.id === id)
    if (!c) continue
    if (!isStopped(c.state)) { skip('container', id, c.names[0], 'Volvió a ejecutarse: se omitió.'); continue }
    if (ctx.mutate) { w.containers = w.containers.filter((x) => x !== c); ctx.emitContainer(c, 'destroy') }
    out.succeeded.push({ kind: 'container', id, name: c.names[0] })
  }
  for (const id of sel.images) {
    const i = w.images.find((x) => x.id === id)
    if (!i) continue
    if (i.containers) { skip('image', id, i.reference, 'Ahora la usa un contenedor: se omitió.'); continue }
    if (ctx.mutate) { w.images = w.images.filter((x) => x !== i); ctx.emitKind('image', 'delete', id) }
    freed += i.size_bytes
    out.succeeded.push({ kind: 'image', id, name: i.reference })
  }
  for (const id of sel.volumes) {
    const v = w.volumes.find((x) => x.name === id)
    if (!v) continue
    if (v.used_by.length) { skip('volume', id, v.name, 'Ahora lo usa un contenedor: se omitió.'); continue }
    if (ctx.mutate) { w.volumes = w.volumes.filter((x) => x !== v); ctx.emitKind('volume', 'destroy', id) }
    freed += v.size_bytes ?? 0
    out.succeeded.push({ kind: 'volume', id, name: v.name })
  }
  for (const id of sel.networks) {
    const n = w.networks.find((x) => x.id === id)
    if (!n) continue
    if (n.connected.length || n.system) { skip('network', id, n.name, 'Ahora tiene contenedores: se omitió.'); continue }
    if (ctx.mutate) { w.networks = w.networks.filter((x) => x !== n); ctx.emitKind('network', 'destroy', id) }
    out.succeeded.push({ kind: 'network', id, name: n.name })
  }
  out.freed_bytes = freed || null
  return out
}

export const simPodman: EngineApi['system']['podmanDetect'] = async () => [
  { path: '/run/user/1000/podman/podman.sock', rootless: true, source: 'XDG_RUNTIME_DIR' },
]
