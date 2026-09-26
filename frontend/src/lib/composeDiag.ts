// Diagnósticos del editor de stack: mezcla la validación local (instantánea, lib/yamlCheck) con la de `docker compose config` (backend).
// Contrato: mergeDiagnostics(local, backend|null) -> Diag[] (ordenado por línea; sin línea al final) · summarizeDiagnostics(diags, services|null, mode)
import type { ValidationIssue } from '@/data/types'
import type { ComposeCheck } from './yamlCheck'

export interface Diag {
  level: 'error' | 'warn'
  line: number | null
  column: number | null
  message: string
  source: 'local' | 'compose'
}

const byLine = (a: Diag, b: Diag): number => (a.line ?? Infinity) - (b.line ?? Infinity) || (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1)

/**
 * `backend = null` (aún no respondió, o Compose no disponible) => solo la capa local.
 * Con respuesta del backend: sus errores mandan (son los reales); de la capa local se conservan solo los AVISOS (variables sin definir),
 * y los errores locales se descartan para no duplicar ni contradecir a Compose.
 */
export function mergeDiagnostics(local: ComposeCheck, backend: ValidationIssue[] | null): Diag[] {
  const localErrors: Diag[] = local.list.filter((x) => x.l === 'bad').map((x) => ({ level: 'error', line: x.line || null, column: null, message: x.msg.replace(/^Línea \d+: /, ''), source: 'local' }))
  const localWarns: Diag[] = local.list.filter((x) => x.l === 'warn').map((x) => ({ level: 'warn', line: x.line || null, column: null, message: x.msg, source: 'local' }))
  if (backend === null) return [...localErrors, ...localWarns].sort(byLine)
  const remote: Diag[] = backend.map((i) => ({ level: 'error', line: i.line, column: i.column, message: i.message, source: 'compose' }))
  // Aviso local sobre una variable que el backend ya reportó como error de interpolación: se omite.
  const interp = new Set(backend.filter((i) => i.kind === 'interpolation').map((i) => i.message))
  const warns = localWarns.filter((w) => ![...interp].some((m) => m.includes(w.message.split(' ')[2] ?? '\u0000')))
  return [...remote, ...warns].sort(byLine)
}

/** Texto del resumen (región aria-live): «Sintaxis correcta · 4 servicios» / «2 errores, 1 aviso». */
export function summarizeDiagnostics(diags: Diag[], services: number | null): string {
  const e = diags.filter((d) => d.level === 'error').length
  const w = diags.length - e
  if (e === 0 && w === 0) return services === null ? 'Sintaxis correcta' : `Sintaxis correcta · ${services} ${services === 1 ? 'servicio' : 'servicios'}`
  const parts: string[] = []
  if (e) parts.push(`${e} ${e === 1 ? 'error' : 'errores'}`)
  if (w) parts.push(`${w} ${w === 1 ? 'aviso' : 'avisos'}`)
  return parts.join(', ')
}
