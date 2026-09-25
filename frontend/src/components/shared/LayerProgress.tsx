// Progreso por capa (pull) y por servicio (stack up). Contratos:
//   <LayerProgress layers={[{id,total,done}]} pulling />   fila: id · barra · «x / y MB» · etiqueta (Completa/Descargando/En espera/No iniciada)
//   <ServiceProgress services={[{name,percent,phase}]} />   fila .up-row: nombre · barra · estado (StatusBadge running al 100 %)
import type { PullProgress, UpProgress } from '@/data/types'
import { Progress } from '@/components/ui/progress'
import { Icon } from './Icon'
import { StatusBadge } from './StatusBadge'

export function LayerProgress({ layers, pulling }: { layers: PullProgress['layers']; pulling: boolean }) {
  return (
    <>
      {layers.map((l) => {
        const pct = l.total ? (l.done / l.total) * 100 : 0
        const v = Math.round(pct)
        const done = v >= 100
        const label = done ? 'Completa' : v === 0 ? (pulling ? 'En espera' : 'No iniciada') : 'Descargando'
        return (
          <div className="layer" key={l.id}>
            <span className="mono">{l.id}</span>
            <Progress value={pct} label={`Capa ${l.id}`} />
            <span className="mono muted">{l.done.toFixed(1)} / {l.total} MB</span>
            <span className={done ? '' : 'muted'}>{done ? <><Icon name="check" size="sm" />{' '}</> : null}{label}</span>
          </div>
        )
      })}
    </>
  )
}

const PHASE: Record<UpProgress['services'][number]['phase'], string> = { waiting: 'En espera', pulling: 'Descargando imagen', creating: 'Creando contenedor', started: 'Iniciado' }

export function ServiceProgress({ services }: { services: UpProgress['services'] }) {
  return (
    <>
      {services.map((s) => (
        <div className="up-row" key={s.name}>
          <b>{s.name}</b>
          <Progress value={s.percent} label={s.name} />
          <span>
            {s.percent >= 100 ? <StatusBadge state="running" /> : <span className="muted">{s.percent > 0 ? <><Icon name="loader" size="sm" spin />{' '}</> : null}{PHASE[s.phase]}</span>}
          </span>
        </div>
      ))}
    </>
  )
}
