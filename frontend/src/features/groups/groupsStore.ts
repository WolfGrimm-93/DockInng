// Grupos propios del usuario para la tabla de contenedores (además de los stacks de Compose, que son automáticos).
// Ola 2: la fuente de verdad es el almacén del backend (SQLite: `groups_load` / `groups_mutate`); este módulo es una CACHÉ write-through:
// cada acción cambia el estado al instante (optimista) y se envía como operación al backend; al terminar se reemplaza por el snapshot
// devuelto; si falla, toast + se recarga lo real. Sin backend (o si `groups_load` falla) sigue el modo heredado en localStorage
// `dockinng.groups.v1`, así la app nunca pierde grupos. Contrato del hook:
//   useGroupsStore(selector)                       — hook (zustand)
//   groups: { id (UUID v7), name, hue 0–359 }[]     — grupos propios
//   assign: { [profileId + NUL + nombreDeContenedor]: groupId }  — a qué grupo pertenece cada contenedor, POR CONEXIÓN
//   stackHue: { [proyectoCompose]: hue }            — color elegido para un stack (si no hay, el automático)
// MIGRACIÓN (una sola vez, idempotente): si el backend dice `legacy_imported:false` y hay datos válidos en `dockinng.groups.v1`, se envían con
// `groups_import_legacy`; solo si TODO sale bien la clave se RENOMBRA a `dockinng.groups.v1.migrated` (no se borra). Ante un error no se toca nada.
// La asignación va por NOMBRE de contenedor (sobrevive a recrearlo con Compose) y por conexión (los nombres pueden repetirse entre equipos).
import { create } from 'zustand'
import type { EngineApi } from '@/data/api'
import type { GroupOp, GroupsSnapshot } from '@/data/types'
import { MAX_ASSIGNMENTS, MAX_GROUPS, MAX_GROUP_NAME, clampHue, isEmptyGroups, sanitizeGroups, toLegacyPayload, validateGroupName, type CustomGroup, type GroupsData } from '@/lib/groupRules'
import { safeStorage } from '@/lib/safeStorage'
import { toast } from '@/lib/toastStore'
import { uuidv7 } from '@/lib/uuid7'
import { GROUP_HUES } from '../common/groupColor'

export const GROUPS_KEY = 'dockinng.groups.v1'
/** Clave a la que se renombra la heredada tras migrar (se conserva hasta la Ola 3, no se borra). */
export const GROUPS_MIGRATED_KEY = 'dockinng.groups.v1.migrated'
export { MAX_GROUP_NAME, clampHue, validateGroupName }
export type { CustomGroup }

export interface GroupsState extends GroupsData {
  /** Devuelve el id del grupo creado o `null` si el nombre no es válido (usa `validateGroupName` para el motivo). */
  createGroup(name: string, hue?: number): string | null
  renameGroup(id: string, name: string): boolean
  setGroupHue(id: string, hue: number): void
  /** Borra el grupo; sus contenedores vuelven a su stack (o quedan sueltos). No toca Docker. */
  deleteGroup(id: string): void
  /** `groupId = null` quita a esos contenedores de su grupo propio. */
  moveContainers(profileId: string, containerNames: readonly string[], groupId: string | null): void
  /** `hue = null` vuelve al color automático del stack. */
  setStackHue(project: string, hue: number | null): void
  /** Quita las asignaciones de la conexión cuyo contenedor ya no está en `liveNames` (lista COMPLETA). Devuelve cuántas quitó. */
  pruneOrphans(profileId: string, liveNames: readonly string[]): number
  /** Vuelve a leer el estado del backend (tras importar un archivo). No hace nada sin backend. */
  reloadFromBackend(): Promise<void>
}

export const assignKey = (profileId: string, containerName: string): string => `${profileId}\u0000${containerName}`

/** Primer matiz de la paleta que no esté en uso; si todos lo están, se reutilizan en orden. */
/** Nombres de contenedor asignados en `profileId` que ya no aparecen en `liveNames`. Función pura. */
export function orphanNames(assign: Readonly<Record<string, string>>, profileId: string, liveNames: readonly string[]): string[] {
  const vivos = new Set(liveNames)
  const out: string[] = []
  for (const k of Object.keys(assign)) {
    const [pid, name] = k.split('\u0000')
    if (pid === profileId && name !== undefined && !vivos.has(name)) out.push(name)
  }
  return out
}

export function nextFreeHue(used: readonly number[]): number {
  return GROUP_HUES.find((h) => !used.includes(h)) ?? GROUP_HUES[used.length % GROUP_HUES.length]
}

const EMPTY: GroupsData = { groups: [], assign: {}, stackHue: {} }

/** Lee y VALIDA lo guardado (modo heredado): cualquier forma rara cae a vacío (o descarta solo la parte inválida), nunca rompe la app. */
export function loadGroups(): GroupsData {
  let raw: unknown
  try { raw = JSON.parse(safeStorage().getItem(GROUPS_KEY) ?? 'null') } catch { return { ...EMPTY, groups: [], assign: {}, stackHue: {} } }
  return sanitizeGroups(raw)
}

function persist(d: GroupsData): void {
  try { safeStorage().setItem(GROUPS_KEY, JSON.stringify({ v: 1, groups: d.groups, assign: d.assign, stackHue: d.stackHue })) } catch { /* sin almacenamiento: vive en memoria */ }
}

// ---- Respaldo en el backend (write-through) ----
let backend: EngineApi | null = null
let ready = false // el backend ya se cargó: las mutaciones van a `groups_mutate`
let hydrating = false
/** B-3: cambios hechos MIENTRAS se carga el backend: se aplican en el backend al terminar la carga (no se pierden al archivar la clave heredada). */
let deferred: { op: GroupOp; optimisticId?: string }[] = []
let sendOp: (op: GroupOp, optimisticId?: string) => void = () => {}
let pending = 0 // mutaciones enviadas y sin respuesta
let chain: Promise<void> = Promise.resolve() // serializa las operaciones (el orden de las acciones importa)
let epoch = 0 // invalida continuaciones tardías tras unbind/reset
/** `create_group` no lleva id (lo genera el backend): id optimista de la UI -> id real, para reescribir las operaciones en cola que lo mencionan. */
const idMap = new Map<string, string>()
const realId = (id: string): string => idMap.get(id) ?? id
function remap(op: GroupOp): GroupOp {
  switch (op.type) {
    case 'rename_group': case 'set_group_hue': case 'delete_group': return { ...op, id: realId(op.id) }
    case 'assign': return op.group_id === null ? op : { ...op, group_id: realId(op.group_id) }
    default: return op
  }
}

const snapshotToData = (s: GroupsSnapshot): GroupsData => ({
  groups: s.groups.map((g) => ({ id: g.id, name: g.name, hue: g.hue })),
  assign: Object.fromEntries(s.assignments.map((a) => [assignKey(a.connection_id, a.container_name), a.group_id])),
  stackHue: { ...s.stack_hues },
})

/** Renombra la clave heredada (no la borra: se conserva hasta la Ola 3). */
function archiveLegacy(): void {
  try {
    const kv = safeStorage()
    const raw = kv.getItem(GROUPS_KEY)
    if (raw === null) return
    kv.setItem(GROUPS_MIGRATED_KEY, raw)
    kv.removeItem(GROUPS_KEY)
  } catch { /* sin almacenamiento */ }
}

export const useGroupsStore = create<GroupsState>()((set, get) => {
  const apply = (d: GroupsData) => set({ groups: d.groups, assign: d.assign, stackHue: d.stackHue })
  /** Envía la operación al backend (serializada). */
  const send = (op: GroupOp, optimisticId?: string) => {
    const a = backend
    if (!a) return
    const my = epoch
    pending++
    chain = chain.then(async () => {
      if (my !== epoch) return
      try {
        const snap = await a.groups.mutate(remap(op))
        // Aprende el id real del grupo recién creado (los nombres son únicos sin distinguir mayúsculas).
        if (op.type === 'create_group' && optimisticId) {
          const made = snap.groups.find((g) => g.name.toLocaleLowerCase() === op.name.trim().toLocaleLowerCase())
          if (made) idMap.set(optimisticId, made.id)
        }
        if (my !== epoch) return // B-2: otra época (unbind/reset): pending ya se reinició, no se toca
        pending--
        if (pending === 0) apply(snapshotToData(snap))
      } catch (e) {
        if (my !== epoch) return
        pending--
        const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : ''
        toast.err('No se pudo guardar el cambio de grupos', { sub: msg || undefined })
        // Se recarga lo real (el cambio optimista ya no vale). Si quedan mutaciones detrás, su snapshot corregirá el estado.
        try { const real = await a.groups.load(); if (my === epoch && pending === 0) apply(snapshotToData(real)) } catch { /* se conserva lo visible */ }
      }
    })
  }
  sendOp = send
  /** Cambio optimista + envío. `op` es la operación equivalente para el backend. */
  const commit = (patch: Partial<GroupsData>, op: GroupOp, optimisticId?: string) => {
    set(patch)
    const s = get()
    if (hydrating) { deferred.push({ op, optimisticId }); return } // se cargará el backend; luego se envía
    if (!ready || !backend) {
      // Modo heredado (sin backend o backend no disponible): se guarda en localStorage como siempre.
      persist({ groups: s.groups, assign: s.assign, stackHue: s.stackHue })
      return
    }
    send(op, optimisticId)
  }
  return {
    ...loadGroups(),
    createGroup(name, hue) {
      const { groups } = get()
      if (validateGroupName(name, groups)) return null
      const g: CustomGroup = { id: uuidv7(), name: name.trim(), hue: hue === undefined ? nextFreeHue(groups.map((x) => x.hue)) : clampHue(hue) }
      commit({ groups: [...groups, g] }, { type: 'create_group', name: g.name, hue: g.hue }, g.id)
      return g.id
    },
    renameGroup(id, name) {
      const { groups } = get()
      if (!groups.some((g) => g.id === id) || validateGroupName(name, groups, id)) return false
      commit({ groups: groups.map((g) => (g.id === id ? { ...g, name: name.trim() } : g)) }, { type: 'rename_group', id, name: name.trim() })
      return true
    },
    setGroupHue(id, hue) {
      commit({ groups: get().groups.map((g) => (g.id === id ? { ...g, hue: clampHue(hue) } : g)) }, { type: 'set_group_hue', id, hue: clampHue(hue) })
    },
    deleteGroup(id) {
      const assign = Object.fromEntries(Object.entries(get().assign).filter(([, gid]) => gid !== id))
      commit({ groups: get().groups.filter((g) => g.id !== id), assign }, { type: 'delete_group', id })
    },
    moveContainers(profileId, names, groupId) {
      const { groups, assign } = get()
      if (groupId !== null && !groups.some((g) => g.id === groupId)) return
      const next = { ...assign }
      for (const n of names) {
        if (groupId === null) delete next[assignKey(profileId, n)]
        else next[assignKey(profileId, n)] = groupId
      }
      commit({ assign: next }, { type: 'assign', connection_id: profileId, names: [...names], group_id: groupId })
    },
    setStackHue(project, hue) {
      const next = { ...get().stackHue }
      if (hue === null) delete next[project]
      else next[project] = clampHue(hue)
      commit({ stackHue: next }, { type: 'set_stack_hue', project, hue: hue === null ? null : clampHue(hue) })
    },
    async reloadFromBackend() {
      const a = backend
      if (!a) return
      apply(snapshotToData(await a.groups.load()))
    },
    pruneOrphans(profileId, liveNames) {
      const huerfanos = orphanNames(get().assign, profileId, liveNames)
      if (huerfanos.length === 0) return 0
      const next = { ...get().assign }
      for (const n of huerfanos) delete next[assignKey(profileId, n)]
      commit({ assign: next }, { type: 'prune_assignments', connection_id: profileId, live_names: [...liveNames] })
      return huerfanos.length
    },
  }
})

/** Recorta un legado que superaría los límites del backend (500 grupos / 20 000 asignaciones) y lo explica (B-4). */
export function clampLegacy(d: GroupsData): { data: GroupsData; trimmed: boolean } {
  let trimmed = false
  let groups = d.groups
  if (groups.length > MAX_GROUPS) { groups = groups.slice(0, MAX_GROUPS); trimmed = true }
  const keep = new Set(groups.map((g) => g.id))
  let entries = Object.entries(d.assign).filter(([, gid]) => keep.has(gid))
  if (entries.length !== Object.keys(d.assign).length) trimmed = true
  if (entries.length > MAX_ASSIGNMENTS) { entries = entries.slice(0, MAX_ASSIGNMENTS); trimmed = true }
  return { data: { groups, assign: Object.fromEntries(entries), stackHue: d.stackHue }, trimmed }
}

/** Carga inicial desde el backend + migración de `dockinng.groups.v1`. Ante cualquier error queda en modo heredado y NO toca localStorage. */
async function hydrate(a: EngineApi, my: number): Promise<void> {
  hydrating = true
  deferred = []
  try {
    let snap = await a.groups.load()
    if (my !== epoch) return
    if (!snap.legacy_imported) {
      const { data: legacy, trimmed } = clampLegacy(loadGroups())
      if (!isEmptyGroups(legacy)) {
        if (trimmed) toast.warn('Migración de grupos', { sub: `Había más de ${MAX_GROUPS} grupos o ${MAX_ASSIGNMENTS} asignaciones: se migró solo lo que cabe. El resto sigue en la copia heredada.` })
        try {
          const r = await a.groups.importLegacy(toLegacyPayload(legacy))
          if (my !== epoch) return
          if (r.dropped_assignments) toast.warn('Migración de grupos', { sub: `${r.dropped_assignments} asignaciones de conexiones que ya no existen se descartaron.` })
        } catch (e) {
          // B-4: el fallo ya no es silencioso (y no se reintenta en bucle: se queda en modo heredado hasta el próximo arranque).
          const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : ''
          if (my === epoch) toast.err('No se pudieron migrar los grupos', { sub: msg || 'Se siguen usando los guardados en esta app.' })
          throw e
        }
        snap = await a.groups.load()
        if (my !== epoch) return
      }
    }
    if (snap.legacy_imported) archiveLegacy()
    ready = true
    hydrating = false
    const queued = deferred
    deferred = []
    // B-3: lo cambiado durante la carga se envía ahora; hasta que respondan no se pisa la UI con el snapshot viejo.
    if (queued.length === 0 && pending === 0) useGroupsStore.setState(snapshotToData(snap))
    for (const q of queued) sendOp(q.op, q.optimisticId)
  } catch {
    // Backend sin almacén (o error): se sigue en modo heredado, sin marcar nada como migrado.
    ready = false
    hydrating = false
    if (my === epoch && deferred.length) { const s = useGroupsStore.getState(); persist({ groups: s.groups, assign: s.assign, stackHue: s.stackHue }) }
    deferred = []
  } finally { if (my === epoch) hydrating = false }
}

/** Conecta la caché al backend (una vez por proveedor). Devuelve la desconexión. Los tests del modo heredado no la llaman. */
export function bindGroupsBackend(api: EngineApi): () => void {
  const my = ++epoch
  backend = api
  ready = false
  pending = 0
  deferred = []
  chain = Promise.resolve()
  idMap.clear()
  void hydrate(api, my)
  return () => {
    if (my !== epoch) return
    epoch++
    backend = null
    ready = false
    hydrating = false
  }
}

/** Solo tests: deja el almacén vacío y borra lo guardado. */
export function resetGroupsStore(data: Partial<GroupsData> = {}): void {
  epoch++
  backend = null
  ready = false
  hydrating = false
  deferred = []
  pending = 0
  chain = Promise.resolve()
  idMap.clear()
  try { safeStorage().removeItem(GROUPS_KEY); safeStorage().removeItem(GROUPS_MIGRATED_KEY) } catch { /* nada */ }
  useGroupsStore.setState({ ...EMPTY, groups: [], assign: {}, stackHue: {}, ...data })
}
