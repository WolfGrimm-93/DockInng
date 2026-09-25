// Grupos propios del usuario para la tabla de contenedores (además de los stacks de Compose, que son automáticos).
// Se guardan SOLO en esta app (localStorage seguro), nunca en Docker ni en los contenedores. Contrato:
//   useGroupsStore(selector)                       — hook (zustand)
//   groups: { id (UUID v7), name, hue 0–359 }[]     — grupos propios
//   assign: { [profileId + NUL + nombreDeContenedor]: groupId }  — a qué grupo pertenece cada contenedor, POR CONEXIÓN
//   stackHue: { [proyectoCompose]: hue }            — color elegido para un stack (si no hay, el automático)
// La asignación va por NOMBRE de contenedor (sobrevive a recrearlo con Compose) y por conexión (los nombres pueden repetirse entre equipos).
import { create } from 'zustand'
import { safeStorage } from '@/lib/safeStorage'
import { uuidv7 } from '@/lib/uuid7'
import { GROUP_HUES } from '../common/groupColor'

export const GROUPS_KEY = 'dockinng.groups.v1'
export const MAX_GROUP_NAME = 40

export interface CustomGroup { id: string; name: string; hue: number }
interface GroupsData { groups: CustomGroup[]; assign: Record<string, string>; stackHue: Record<string, number> }

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
}

export const clampHue = (h: number): number => (Number.isFinite(h) ? ((Math.round(h) % 360) + 360) % 360 : 0)
export const assignKey = (profileId: string, containerName: string): string => `${profileId}\u0000${containerName}`

/** Caracteres de control C0/DEL y de control bidireccional (U+202A–202E, U+2066–2069): no se admiten en nombres de grupo. */
function hasForbiddenChars(t: string): boolean {
  for (const ch of t) {
    const c = ch.codePointAt(0) ?? 0
    if (c <= 0x1f || c === 0x7f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true
  }
  return false
}

/** `null` = válido. */
export function validateGroupName(name: string, groups: readonly CustomGroup[], exceptId?: string): string | null {
  const t = name.trim()
  if (!t) return 'Escribe un nombre.'
  if (t.length > MAX_GROUP_NAME) return `Máximo ${MAX_GROUP_NAME} caracteres.`
  if (hasForbiddenChars(t)) return 'El nombre tiene caracteres no permitidos.'
  if (groups.some((g) => g.id !== exceptId && g.name.toLocaleLowerCase() === t.toLocaleLowerCase())) return 'Ya existe un grupo con ese nombre.'
  return null
}

/** Primer matiz de la paleta que no esté en uso; si todos lo están, se reutilizan en orden. */
export function nextFreeHue(used: readonly number[]): number {
  return GROUP_HUES.find((h) => !used.includes(h)) ?? GROUP_HUES[used.length % GROUP_HUES.length]
}

const EMPTY: GroupsData = { groups: [], assign: {}, stackHue: {} }

/** Lee y VALIDA lo guardado: cualquier forma rara cae a vacío (o descarta solo la parte inválida), nunca rompe la app. */
export function loadGroups(): GroupsData {
  let raw: unknown
  try { raw = JSON.parse(safeStorage().getItem(GROUPS_KEY) ?? 'null') } catch { return { ...EMPTY, groups: [], assign: {}, stackHue: {} } }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const groups: CustomGroup[] = []
  const seen = new Set<string>()
  if (Array.isArray(o.groups)) {
    for (const g of o.groups) {
      const r = (g ?? {}) as Record<string, unknown>
      if (typeof r.id !== 'string' || !r.id || seen.has(r.id) || typeof r.name !== 'string' || typeof r.hue !== 'number') continue
      const name = r.name.trim()
      if (!name || name.length > MAX_GROUP_NAME || hasForbiddenChars(name)) continue
      seen.add(r.id)
      groups.push({ id: r.id, name, hue: clampHue(r.hue) })
    }
  }
  const assign: Record<string, string> = {}
  if (o.assign && typeof o.assign === 'object') {
    for (const [k, v] of Object.entries(o.assign as Record<string, unknown>)) if (typeof v === 'string' && seen.has(v)) assign[k] = v
  }
  const stackHue: Record<string, number> = {}
  if (o.stackHue && typeof o.stackHue === 'object') {
    for (const [k, v] of Object.entries(o.stackHue as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) stackHue[k] = clampHue(v)
  }
  return { groups, assign, stackHue }
}

function persist(d: GroupsData): void {
  try { safeStorage().setItem(GROUPS_KEY, JSON.stringify({ v: 1, groups: d.groups, assign: d.assign, stackHue: d.stackHue })) } catch { /* sin almacenamiento: vive en memoria */ }
}

export const useGroupsStore = create<GroupsState>()((set, get) => {
  /** Aplica el cambio y lo guarda. */
  const commit = (patch: Partial<GroupsData>) => {
    set(patch)
    const s = get()
    persist({ groups: s.groups, assign: s.assign, stackHue: s.stackHue })
  }
  return {
    ...loadGroups(),
    createGroup(name, hue) {
      const { groups } = get()
      if (validateGroupName(name, groups)) return null
      const g: CustomGroup = { id: uuidv7(), name: name.trim(), hue: hue === undefined ? nextFreeHue(groups.map((x) => x.hue)) : clampHue(hue) }
      commit({ groups: [...groups, g] })
      return g.id
    },
    renameGroup(id, name) {
      const { groups } = get()
      if (!groups.some((g) => g.id === id) || validateGroupName(name, groups, id)) return false
      commit({ groups: groups.map((g) => (g.id === id ? { ...g, name: name.trim() } : g)) })
      return true
    },
    setGroupHue(id, hue) {
      commit({ groups: get().groups.map((g) => (g.id === id ? { ...g, hue: clampHue(hue) } : g)) })
    },
    deleteGroup(id) {
      const assign = Object.fromEntries(Object.entries(get().assign).filter(([, gid]) => gid !== id))
      commit({ groups: get().groups.filter((g) => g.id !== id), assign })
    },
    moveContainers(profileId, names, groupId) {
      const { groups, assign } = get()
      if (groupId !== null && !groups.some((g) => g.id === groupId)) return
      const next = { ...assign }
      for (const n of names) {
        if (groupId === null) delete next[assignKey(profileId, n)]
        else next[assignKey(profileId, n)] = groupId
      }
      commit({ assign: next })
    },
    setStackHue(project, hue) {
      const next = { ...get().stackHue }
      if (hue === null) delete next[project]
      else next[project] = clampHue(hue)
      commit({ stackHue: next })
    },
  }
})

/** Solo tests: deja el almacén vacío y borra lo guardado. */
export function resetGroupsStore(data: Partial<GroupsData> = {}): void {
  try { safeStorage().removeItem(GROUPS_KEY) } catch { /* nada */ }
  useGroupsStore.setState({ ...EMPTY, groups: [], assign: {}, stackHue: {}, ...data })
}
