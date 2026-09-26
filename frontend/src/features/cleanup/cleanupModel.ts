// Lógica pura de la limpieza guiada (sin React): claves de selección, texto de tamaño, selección hacia el backend y resumen.
import type { CleanupItem, CleanupReport, CleanupSelection } from '@/data/types'
import { formatBytes } from '@/lib/format'

export const keyOf = (i: CleanupItem): string => `${i.kind}:${i.id}`
export function sizeText(i: Pick<CleanupItem, 'size_bytes' | 'estimate'>): string {
  if (i.size_bytes === null || i.estimate === 'unknown') return 'tamaño desconocido'
  return i.estimate === 'upper_bound' ? `≤ ${formatBytes(i.size_bytes)} (aprox.)` : formatBytes(i.size_bytes)
}

export function toSelection(report: CleanupReport, picked: ReadonlySet<string>): CleanupSelection {
  const sel: CleanupSelection = { containers: [], images: [], volumes: [], networks: [] }
  for (const c of report.categories) {
    if (!c.executable) continue
    for (const i of c.items) {
      if (!picked.has(keyOf(i))) continue
      if (i.kind === 'container') sel.containers.push(i.id)
      else if (i.kind === 'image') sel.images.push(i.id)
      else if (i.kind === 'volume') sel.volumes.push(i.id)
      else if (i.kind === 'network') sel.networks.push(i.id)
    }
  }
  return sel
}

/** Resumen de lo seleccionado: suma de tamaños conocidos, si alguna es cota y cuántos no tienen tamaño. */
export function summarize(report: CleanupReport, picked: ReadonlySet<string>): { count: number; bytes: number; approx: boolean; unknown: number; volumes: number } {
  let count = 0, bytes = 0, unknown = 0, volumes = 0
  let approx = false
  for (const c of report.categories) {
    if (!c.executable) continue
    for (const i of c.items) {
      if (!picked.has(keyOf(i))) continue
      count++
      if (i.kind === 'volume') volumes++
      if (i.size_bytes === null || i.estimate === 'unknown') unknown++
      else { bytes += i.size_bytes; if (i.estimate === 'upper_bound') approx = true }
    }
  }
  return { count, bytes, approx, unknown, volumes }
}

