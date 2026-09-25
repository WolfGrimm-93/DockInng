// Sumas de consumo para la franja de la tabla y las cabeceras de stack (funciones puras, sin React).
//
// Unidades (las mismas que la columna CPU de cada fila): CPU en «% de un núcleo» como `docker stats` (100 % = 1 núcleo, así que
// varios contenedores pueden sumar más de 100 %). Solo cuentan los contenedores EN MARCHA con muestra: Docker no da estadísticas de los
// detenidos. Disco = uso de Docker (no el disco del equipo); por grupo es APROXIMADO: capas de escritura + volúmenes que usa, sin imágenes.
import type { Container, ContainerDisk, ContainerStats, Volume } from '@/data/types'
import { containerName } from '@/data/store/engineStore'

export interface ConsumptionSum {
  /** Suma de CPU% (100 = 1 núcleo). */
  cpu: number
  /** Suma de memoria usada en bytes. */
  memBytes: number
  /** Contenedores en marcha del conjunto. */
  running: number
  /** De ellos, los que ya tienen muestra. */
  sampled: number
}

export function sumConsumption(cs: readonly Container[], stats: Readonly<Record<string, ContainerStats>>): ConsumptionSum {
  let cpu = 0
  let memBytes = 0
  let running = 0
  let sampled = 0
  for (const c of cs) {
    if (c.state !== 'running') continue
    running++
    const s = stats[c.id]
    if (!s) continue
    sampled++
    cpu += Number.isFinite(s.cpu_percent) ? s.cpu_percent : 0
    memBytes += Number.isFinite(s.mem_used_bytes) ? s.mem_used_bytes : 0
  }
  return { cpu, memBytes, running, sampled }
}

/**
 * Disco aproximado de un grupo: capa de escritura de sus contenedores + tamaño de los volúmenes que usan (cada volumen se cuenta
 * una vez por grupo; uno compartido con otro grupo se cuenta en ambos). `null` = no se puede saber (sin datos de `df`).
 */
export function groupDiskBytes(
  cs: readonly Container[],
  volumes: readonly Volume[],
  containerDisk: readonly ContainerDisk[],
  diskKnown: boolean,
): number | null {
  if (!diskKnown) return null
  const rwById = new Map(containerDisk.map((d) => [d.id, d.size_rw_bytes]))
  const names = new Set(cs.map((c) => containerName(c)))
  let total = 0
  for (const c of cs) total += rwById.get(c.id) ?? 0
  for (const v of volumes) {
    if (v.size_bytes == null) continue
    if (v.used_by.some((n) => names.has(n))) total += v.size_bytes
  }
  return total
}
