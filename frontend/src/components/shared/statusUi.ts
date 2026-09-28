// Tabla de presentación de los estados de contenedor y su normalización (separado de StatusBadge.tsx: solo componentes allí).
import type { ContainerState, UiStatus } from '@/data/types'
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
