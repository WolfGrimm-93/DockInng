// Reductor PURO de eventos del motor -> qué colecciones hay que refrescar (invalidate + refetch).
// Contrato: planRefresh(events, resync) -> RefreshPlan. No toca el store: es testeable sin React ni Tauri.
import type { EngineEvent } from '../types'

export interface RefreshPlan {
  containers: boolean
  images: boolean
  volumes: boolean
  networks: boolean
  /** stacks: cualquier evento de contenedor cambia sus servicios/estado. */
  stacks: boolean
  /** ids de contenedor destruidos: se eliminan del store al instante (sin esperar al refetch). */
  removedContainerIds: string[]
}

const CONTAINER_ACTIONS = new Set([
  'start', 'die', 'stop', 'pause', 'unpause', 'kill', 'oom', 'rename', 'restart', 'health_status', 'create', 'destroy', 'update',
])

export function planRefresh(events: EngineEvent[], resync = false): RefreshPlan {
  const plan: RefreshPlan = { containers: resync, images: resync, volumes: resync, networks: resync, stacks: resync, removedContainerIds: [] }
  for (const e of events) {
    switch (e.kind) {
      case 'container': {
        // health_status llega como "health_status: healthy": se compara solo el prefijo.
        const action = e.action.split(':')[0]
        if (!CONTAINER_ACTIONS.has(action)) break
        plan.containers = true
        plan.stacks = true
        if (action === 'destroy') plan.removedContainerIds.push(e.id)
        // Crear/destruir/arrancar cambia «en uso» de imágenes, «usado por» de volúmenes y conectados de redes.
        // El backend coalesce create+start en `start` (docker run) y die+destroy en `destroy`: `start` también cuenta
        // (contador «en uso» de imágenes, redes conectadas, «usado por» de volúmenes). Se refresca con debounce en el store.
        if (action === 'create' || action === 'destroy' || action === 'start' || action === 'die') {
          plan.images = true
          plan.volumes = true
          plan.networks = true
        }
        break
      }
      case 'image':
        plan.images = true
        break
      case 'volume':
        plan.volumes = true
        break
      case 'network':
        plan.networks = true
        break
      default:
        break
    }
  }
  return plan
}
