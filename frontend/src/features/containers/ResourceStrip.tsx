// Franja de consumo total sobre la tabla de contenedores: CPU y RAM (suma de los contenedores en marcha), disco de Docker y GPU del equipo.
// Sin navbar: es contenido de la vista. CPU en «% de un núcleo» (100 % = 1 núcleo, como cada fila y como `docker stats`).
// La GPU es del equipo (solo NVIDIA con nvidia-smi y solo con motor local): Docker no la informa por contenedor, por eso no hay GPU por stack.
import { memo, useMemo } from 'react'
import { useAllStats, useContainers, useGpu, useStatsConsumer, useStatsStale, useSystemUsage } from '@/data/store/hooks'
import type { DiskUsage } from '@/data/types'
import { formatBytesPrecise, formatBytesSI } from '@/lib/format'
import { safeText } from '@/lib/safeText'
import { sumConsumption } from './usage'

interface MeterProps {
  label: string
  value: string
  sub: string
  /** 0–100 (se acota). */
  pct: number
  title?: string
  /** Barra segmentada (disco): porcentajes que suman ≤ 100, uno por clase `seg-N`. */
  segments?: number[]
}

function Meter({ label, value, sub, pct, title, segments }: MeterProps) {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  return (
    <div className="meter" role="group" aria-label={label} title={title}>
      <div className="meter-label">{label}</div>
      <div className="meter-value mono">{value}</div>
      <div className="meter-sub">{sub}</div>
      <div className="meter-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
        {segments ? segments.map((s, i) => <span key={i} className={`seg-${i + 1}`} style={{ width: `${Math.max(0, Math.min(100, s))}%` }} />) : <span style={{ width: `${p}%` }} />}
      </div>
    </div>
  )
}

const cat = (d: DiskUsage, k: keyof DiskUsage) => d[k].total_bytes ?? 0

function ResourceStripImpl() {
  useStatsConsumer()
  const stale = useStatsStale()
  const { list } = useContainers()
  const stats = useAllStats()
  const system = useSystemUsage()
  const gpus = useGpu()

  const sum = useMemo(() => sumConsumption(list, stats), [list, stats])
  const cores = system?.host.cpu_count ?? 0
  const memTotal = system?.host.mem_total_bytes ?? 0

  const cpuPct = cores > 0 ? (sum.cpu / (cores * 100)) * 100 : 0
  const cpuSub = `${sum.running} en ejecución${cores > 0 ? ` · de ${cores * 100} % (${cores} núcleos)` : ''}${sum.running > 0 && sum.sampled === 0 ? ' · midiendo…' : ''}`
  const memPct = memTotal > 0 ? (sum.memBytes / memTotal) * 100 : 0
  const memSub = memTotal > 0 ? `de ${formatBytesPrecise(memTotal)} del equipo · ${memPct.toFixed(1)} %` : 'Cargando…'

  let diskValue = '—'
  let diskSub = system ? 'Docker no informó el uso de disco' : 'Cargando…'
  let diskTitle = 'Disco que usa Docker (no el disco del equipo)'
  let diskSegs: number[] | undefined
  if (system?.disk_known) {
    const d = system.disk
    const img = cat(d, 'images')
    const vol = cat(d, 'volumes')
    const rest = cat(d, 'containers') + cat(d, 'build_cache')
    const total = img + vol + rest
    diskValue = formatBytesSI(total)
    diskSub = `imágenes ${formatBytesSI(img)} · volúmenes ${formatBytesSI(vol)}`
    const reclaimable = (d.images.reclaimable_bytes ?? 0) + (d.containers.reclaimable_bytes ?? 0) + (d.volumes.reclaimable_bytes ?? 0) + (d.build_cache.reclaimable_bytes ?? 0)
    diskTitle = `Disco que usa Docker (no el disco del equipo): imágenes ${formatBytesSI(img)}, volúmenes ${formatBytesSI(vol)}, contenedores y caché ${formatBytesSI(rest)}. Recuperable: ${formatBytesSI(reclaimable)}`
    diskSegs = total > 0 ? [(img / total) * 100, (vol / total) * 100, (rest / total) * 100] : [0, 0, 0]
  }

  const g = gpus[0]
  const gpuValue = g ? `${Math.round(g.utilization_percent)} %` : '—'
  // El nombre va en el título (con varias GPU, en la lista): en la línea cabe VRAM y temperatura.
  const gpuSub = g
    ? `VRAM ${formatBytesPrecise(g.mem_used_bytes)} de ${formatBytesPrecise(g.mem_total_bytes)}${g.temperature_c != null ? ` · ${g.temperature_c} °C` : ''}${gpus.length > 1 ? ` · +${gpus.length - 1} más` : ''}`
    : 'No detectada (solo NVIDIA con nvidia-smi)'
  const gpuTitle = g
    ? `${gpus.map((x) => safeText(x.name, { singleLine: true })).join(' · ')}. GPU del equipo: Docker no informa la GPU por contenedor, por eso no hay GPU por stack.`
    : 'GPU del equipo (solo NVIDIA con nvidia-smi y solo con motor local). Docker no informa la GPU por contenedor.'

  return (
    <section className={`resource-strip${stale ? ' is-stale' : ''}`} aria-label="Consumo total" aria-busy={stale || undefined}>
      <Meter label="CPU" value={`${sum.cpu.toFixed(1)} %`} sub={cpuSub} pct={cpuPct} title="Suma de los contenedores en marcha (100 % = 1 núcleo, como docker stats)" />
      <Meter label="RAM" value={formatBytesPrecise(sum.memBytes)} sub={memSub} pct={memPct} title="Memoria usada por los contenedores en marcha frente a la del equipo" />
      <Meter label="Disco" value={diskValue} sub={diskSub} pct={0} segments={diskSegs} title={diskTitle} />
      <Meter label="GPU" value={gpuValue} sub={gpuSub} pct={g?.utilization_percent ?? 0} title={gpuTitle} />
    </section>
  )
}

/** Memoizada: no tiene props, así solo se repinta por sus propias suscripciones (stats, sistema, GPU, lista), nunca por el padre. */
export const ResourceStrip = memo(ResourceStripImpl)
