// Textos del diálogo «Bloqueado» por tipo de acción. Compartido por el flujo guardado, la paleta y el arranque de desarrollo.
import type { ActionRequest } from '@/data/types'
import type { BlockedRequest } from './confirmApi'

/** Nombre visible de cada acción (también en el título del bloqueo). */
export const ACTION_LABEL: Record<ActionRequest['type'], string> = {
  remove_containers: 'Eliminar contenedores', remove_image: 'Eliminar imagen', prune_images: 'Eliminar imágenes sin usar', remove_volume: 'Eliminar volumen',
  prune_volumes: 'Eliminar volúmenes sin usar', remove_network: 'Eliminar red', stack_down: 'Bajar stack', stack_delete: 'Eliminar stack', prune_system: 'Limpiar todo el sistema', cleanup: 'Limpiar recursos sin usar',
}

/**
 * Contenido del bloqueo para una acción. `prune_system` tiene texto propio (con alternativas por partes);
 * el resto usa el nombre de la acción y un texto genérico SIN lista de alternativas.
 */
export function blockedRequestFor(type: ActionRequest['type']): BlockedRequest {
  if (type === 'prune_system') {
    return {
      title: `${ACTION_LABEL.prune_system} está bloqueado`,
      description: <p>DockInng no ejecuta esta acción, ni siquiera con confirmación. Borraría contenedores detenidos, redes, imágenes sin usar y caché de compilación de una sola vez.</p>,
      bullets: [
        'Para limpiar por partes: elimina imágenes o volúmenes sin usar desde sus vistas, con confirmación.',
        'Si de verdad lo necesitas, ejecútalo tú mismo en una terminal.',
      ],
    }
  }
  return {
    title: `${ACTION_LABEL[type]} está bloqueado`,
    description: <p>DockInng no ejecuta esta acción en ningún caso: el motor de seguridad la rechaza antes de enviarla a Docker.</p>,
    bullets: [],
  }
}
