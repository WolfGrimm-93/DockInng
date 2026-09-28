// Estado del arrastre de filas hacia un grupo (zustand). Solo lo mínimo: qué contenedores se arrastran y el anuncio para lectores de pantalla.
// La posición del puntero y el resalte del destino NO viven aquí (se aplican directo al DOM): así `pointermove` no re-renderiza la tabla.
import { create } from 'zustand'

export interface DragState {
  /** Ids de los contenedores arrastrados (vacío = no hay arrastre). */
  ids: string[]
  /** Nombres de esos contenedores (la asignación a grupos va por nombre). */
  names: string[]
  /** Texto para la región `role="status"` (lector de pantalla). */
  message: string
  start(ids: string[], names: string[]): void
  end(message?: string): void
}

export const useDragStore = create<DragState>()((set) => ({
  ids: [],
  names: [],
  message: '',
  start: (ids, names) => set({ ids, names, message: `Arrastrando ${ids.length} ${ids.length === 1 ? 'contenedor' : 'contenedores'}. Suelta sobre un grupo.` }),
  end: (message = '') => set({ ids: [], names: [], message }),
}))

/** Solo tests. */
export const resetDragStore = (): void => useDragStore.getState().end('')
