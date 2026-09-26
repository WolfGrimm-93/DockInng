// Progreso por capa (pull) y por servicio (stack up). Contratos:
//   <LayerProgress layers={PullLayer[]} pulling />          fila: id · barra · «x / y» (bytes) · etiqueta (En espera/Descargando/Extrayendo/Completa)
//                                                            total desconocido (0) => barra indeterminada y «Calculando…»
//   <ServiceProgress services={ServiceProgressRow[]} />      fila .up-row: nombre · barra · estado (StatusBadge running al 100 %)
import type { PullLayer, ServiceProgressRow } from '@/data/types'
import { Progress } from '@/components/ui/progress'
import { formatBytesPrecise } from '@/lib/format'
import { safeText } from '@/lib/safeText'
import { Icon } from './Icon'
import { StatusBadge } from './StatusBadge'

const LAYER_LABEL: Record<PullLayer['phase'], string> = { waiting: 'En espera', downloading: 'Descargando', downloaded: 'Descargada', extracting: 'Extrayendo', complete: 'Completa' }

export function LayerProgress({ layers, pulling }: { layers: PullLayer[]; pulling: boolean }) {
  return (
    <>
      {layers.map((l) => {
        const known = l.total > 0
        const pct = known ? (l.done / l.total) * 100 : 0
        const done = l.phase === 'complete'
        const indeterminate = pulling && !done && (l.phase === 'extracting' || (l.phase === 'downloading' && !known))
        const label = !pulling && !done && l.phase === 'waiting' ? 'No iniciada' : LAYER_LABEL[l.phase]
        const id = safeText(l.id, { singleLine: true })
        return (
          <div className="layer" key={l.id}>
            <span className="mono">{id}</span>
            <Progress value={done ? 100 : pct} label={`Capa ${id}`} indeterminate={indeterminate} />
            <span className="mono muted">{known ? `${formatBytesPrecise(l.done)} / ${formatBytesPrecise(l.total)}` : l.phase === 'waiting' ? '—' : 'Calculando…'}</span>
            <span className={done ? '' : 'muted'}>{done ? <><Icon name="check" size="sm" />{' '}</> : null}{label}</span>
          </div>
        )
      })}
    </>
  )
}

const PHASE: Record<ServiceProgressRow['phase'], string> = { waiting: 'En espera', pulling: 'Descargando imagen', creating: 'Creando contenedor', started: 'Iniciado' }

export function ServiceProgress({ services }: { services: ServiceProgressRow[] }) {
  return (
    <>
      {services.map((s) => (
        <div className="up-row" key={s.name}>
          <b>{safeText(s.name, { singleLine: true })}</b>
          <Progress value={s.percent} label={`Servicio ${safeText(s.name, { singleLine: true })}`} />
          <span>
            {s.percent >= 100 ? <StatusBadge state="running" /> : <span className="muted">{s.percent > 0 ? <><Icon name="loader" size="sm" spin />{' '}</> : null}{PHASE[s.phase]}</span>}
          </span>
        </div>
      ))}
    </>
  )
}
