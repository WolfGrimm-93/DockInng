// StatusBadge: 6 estados visuales, SIEMPRE icono + texto (forma distinta por estado: legible en escala de grises).
// Contrato: <StatusBadge state={ContainerState} busy?={ContainerBusy} live? /> · STATUS_UI[UiStatus] · toUiStatus(state)
//   live = «En ejecución» con el icono animado (halo + pulso); solo lo usa el detalle: en la tabla, con muchas filas, sería ruido. Sin movimiento si el sistema lo reduce.
//   running = ● (icono propio `dot`); ▶ queda solo para la ACCIÓN «Iniciar». busy sustituye por spinner («Iniciando…»…).
//   removing -> busy 'remove' («Eliminando…») · stopping -> «Deteniendo…» · unknown -> «Desconocido» (aspecto exited).
import type { ContainerBusy, ContainerState } from '@/data/types'
import { Icon } from './Icon'
import { STATUS_UI, toUiStatus } from './statusUi'

const BUSY_LABEL: Record<ContainerBusy, string> = { start: 'Iniciando…', stop: 'Deteniendo…', restart: 'Reiniciando…', remove: 'Eliminando…' }

export function StatusBadge({ state, busy, live }: { state: ContainerState; busy?: ContainerBusy; live?: boolean }) {
  const effective: ContainerBusy | undefined = busy ?? (state === 'removing' ? 'remove' : state === 'stopping' ? 'stop' : undefined)
  if (effective) {
    return (
      <span className="status status-restarting">
        <Icon name="loader" spin />
        {BUSY_LABEL[effective]}
      </span>
    )
  }
  const ui = toUiStatus(state)
  const d = STATUS_UI[ui]
  return (
    <span className={`status status-${ui}${live && (ui === 'running' || ui === 'restarting') ? ' is-live' : ''}`}>
      <Icon name={d.icon} fill={d.fill} />
      {state === 'unknown' ? 'Desconocido' : d.label}
    </span>
  )
}
