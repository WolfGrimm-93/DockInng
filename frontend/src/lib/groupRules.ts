// Reglas puras de los grupos propios (nombres, matiz, forma de la carga heredada). Las comparten la UI (groupsStore) y el adaptador
// simulado (que replica las validaciones del backend en el borde). Sin dependencias de React ni del almacén.
import type { LegacyGroupsPayload, StoredGroup } from '@/data/types'

export const MAX_GROUP_NAME = 40
export const MAX_GROUPS = 500
export const MAX_ASSIGNMENTS = 20_000

export type CustomGroup = StoredGroup

export const clampHue = (h: number): number => (Number.isFinite(h) ? ((Math.round(h) % 360) + 360) % 360 : 0)

/** Caracteres de control C0/DEL y de control bidireccional (U+202A–202E, U+2066–2069): no se admiten en nombres de grupo. */
export function hasForbiddenChars(t: string): boolean {
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

export interface GroupsData { groups: CustomGroup[]; assign: Record<string, string>; stackHue: Record<string, number> }

/** Valida una carga de `dockinng.groups.v1` (o de cualquier origen no fiable): descarta lo inválido, nunca lanza. */
export function sanitizeGroups(raw: unknown): GroupsData {
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

export const toLegacyPayload = (d: GroupsData): LegacyGroupsPayload => ({ v: 1, groups: d.groups, assign: d.assign, stackHue: d.stackHue })
export const isEmptyGroups = (d: GroupsData): boolean => !d.groups.length && !Object.keys(d.assign).length && !Object.keys(d.stackHue).length
export const isUuidV7 = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
