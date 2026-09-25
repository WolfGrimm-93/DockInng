// Formato de datos para la UI (español). Contrato público:
//   formatBytes(n)            "412 MB" / "1.8 GB" (MB si < 1 GiB, como la plantilla; n en bytes)
//   formatMB(mb)              igual pero recibiendo MB
//   relativeTimeEs(epochSec, nowMs?)  "hace 3 días"
//   statusTextEs(status, state)       traduce "Up 3 hours" / "Exited (137) 1 day ago" -> "hace 3 horas" / "salió (137) hace 1 día"
//   stateLabelEs(state)               etiqueta corta del estado ("En ejecución"…)
import type { ContainerState } from '@/data/types'

export function formatMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

export function formatBytes(bytes: number): string {
  return formatMB(bytes / (1024 * 1024))
}

/** Bytes con unidades binarias finas (para CPU/memoria/red en detalle). */
export function formatBytesPrecise(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

/**
 * Tiempo relativo con los textos de la plantilla (data.js): «hace un momento», «hace 5 min», «hace 2 h» (abreviado),
 * «hace 3 días» hasta 13 días, «hace 5 semanas» (granularidad de semanas hasta ~12), luego meses y años.
 */
export function relativeTimeEs(epochSec: number, nowMs: number = Date.now()): string {
  const sec = Math.max(0, Math.floor(nowMs / 1000 - epochSec))
  return `hace ${spanLabel(sec)}`
}

/** Etiqueta de duración: «un momento» · «5 min» · «2 h» · «3 días» · «5 semanas» · «4 meses» · «2 años». */
function spanLabel(sec: number): string {
  if (sec < 60) return 'un momento'
  if (sec < 3600) return `${Math.floor(sec / 60)} min`
  if (sec < 86400) return `${Math.floor(sec / 3600)} h`
  const d = Math.floor(sec / 86400)
  if (d < 14) return `${d} ${d === 1 ? 'día' : 'días'}`
  if (d < 84) return `${Math.floor(d / 7)} semanas`
  if (d < 365) {
    const m = Math.floor(d / 30)
    return `${m} ${m === 1 ? 'mes' : 'meses'}`
  }
  const y = Math.floor(d / 365)
  return `${y} ${y === 1 ? 'año' : 'años'}`
}

const UNIT_SEC: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 }

/** «About an hour» / «3 days» / «Less than a second» (Docker, inglés) -> etiqueta de la plantilla; null si no se reconoce. */
function spanishSpan(text: string): string | null {
  const t = text.trim().toLowerCase()
  if (t === 'less than a second' || t === 'about a second') return 'un momento'
  const m = t.match(/^(?:about )?(an? |\d+ )?(second|minute|hour|day|week|month|year)s?$/)
  if (!m) return null
  const raw = (m[1] ?? '').trim()
  const n = /^\d+$/.test(raw) ? Number(raw) : 1
  return spanLabel(n * UNIT_SEC[m[2]])
}

/** Traduce el texto de estado de `docker ps` (inglés) con los textos de la plantilla. Si no lo reconoce, devuelve el crudo. */
export function statusTextEs(status: string, state?: ContainerState): string {
  const s = status.trim()
  if (/^Up .*\(Paused\)$/i.test(s) || /^Paused/i.test(s)) return 'en pausa'
  let m = s.match(/^Up (.+)$/i)
  if (m) {
    const span = spanishSpan(m[1].replace(/ \(.*\)$/, ''))
    return span ? `hace ${span}` : s
  }
  m = s.match(/^Exited \((-?\d+)\) (.+?) ago$/i)
  if (m) {
    const span = spanishSpan(m[2])
    if (span === 'un momento') return `salió (${m[1]}) ahora`
    return span ? `salió (${m[1]}) hace ${span}` : s
  }
  m = s.match(/^Restarting \((-?\d+)\)/i)
  if (m) return `reiniciando (${m[1]})`
  if (/^Created/i.test(s)) return 'sin iniciar'
  if (/^Dead/i.test(s)) return 'error al detener'
  if (state === 'removing') return 'eliminando'
  return s
}

/**
 * Bytes DECIMALES como la plantilla (Estadísticas de red/disco): «184 MB», «1.2 MB», «640 KB», «1.9 GB».
 * ≥100 sin decimales; si no, 1 decimal sin «.0» final. (La memoria sigue en MiB: formatBytesPrecise.)
 */
export function formatBytesSI(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Math.max(0, bytes)
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  const txt = i === 0 || v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '')
  return `${txt} ${units[i]}`
}

export const STATE_LABEL_ES: Record<ContainerState, string> = {
  created: 'Creado',
  running: 'En ejecución',
  paused: 'Pausado',
  restarting: 'Reiniciando',
  removing: 'Eliminando',
  stopping: 'Deteniendo',
  exited: 'Detenido',
  dead: 'Muerto',
  unknown: 'Desconocido',
}

export function stateLabelEs(state: ContainerState): string {
  return STATE_LABEL_ES[state]
}

/** Recorta en el medio (ids largos, rutas) sin romper el texto completo (úsese junto a `title`). */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  const keep = Math.max(1, max - 1)
  const head = Math.ceil(keep / 2)
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`
}

/** Id corto de 12 caracteres (sin prefijo `sha256:`), como muestra la plantilla. */
export function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12)
}
