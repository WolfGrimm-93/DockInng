// StatusBadge: 6 estados visuales, SIEMPRE icono + texto (forma distinta por estado: legible en escala de grises).
// Contrato: <StatusBadge state={ContainerState} busy?={ContainerBusy} /> · STATUS_UI[UiStatus] · toUiStatus(state)
//   running = ● (icono propio `dot`); ▶ queda solo para la ACCIÓN «Iniciar». busy sustituye por spinner («Iniciando…»…).
//   removing -> busy 'remove' («Eliminando…») · stopping -> «Deteniendo…» · unknown -> «Desconocido» (aspecto exited).
import type { ContainerBusy, ContainerState, UiStatus } from '@/data/types'
import { Icon } from './Icon'
import type { IconName } from './iconNames'

export const STATUS_UI: Record<UiStatus, { label: string; icon: IconName; fill?: boolean }> = {
  running: { label: 'En ejecución', icon: 'dot' },
  paused: { label: 'Pausado', icon: 'pause', fill: true },
  restarting: { label: 'Reiniciando', icon: 'rotate' },
  exited: { label: 'Detenido', icon: 'square', fill: true },
  dead: { label: 'Muerto', icon: 'xcircle' },
  created: { label: 'Creado', icon: 'dashed' },
}

export function toUiStatus(state: ContainerState): UiStatus {
  switch (state) {
    case 'running': case 'paused': case 'restarting': case 'exited': case 'dead': case 'created':
      return state
    case 'removing': case 'stopping':
      return 'restarting'
    default:
      return 'exited'
  }
}

const BUSY_LABEL: Record<ContainerBusy, string> = { start: 'Iniciando…', stop: 'Deteniendo…', restart: 'Reiniciando…', remove: 'Eliminando…' }

export function StatusBadge({ state, busy }: { state: ContainerState; busy?: ContainerBusy }) {
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
    <span className={`status status-${ui}`}>
      <Icon name={d.icon} fill={d.fill} />
      {state === 'unknown' ? 'Desconocido' : d.label}
    </span>
  )
}
