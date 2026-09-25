// Estado de UI global y no persistido en URL: selector de conexión abierto, paleta abierta y sidebar colapsada.
// Contrato: useUiStore(selector) · uiStore.getState().{openCtxMenu(b), openPalette(b), setCollapsed(b, persist?)}
//   La clase `is-collapsed` vive en <html> (la fija el script inline de index.html antes del primer pintado);
//   persistencia en localStorage `dockinng.sidebar` = 'collapsed' | 'expanded' (try/catch en cada acceso).
import { create } from 'zustand'
import { safeStorage } from '@/lib/safeStorage'

interface UiState {
  ctxMenuOpen: boolean
  paletteOpen: boolean
  collapsed: boolean
  openCtxMenu(open: boolean): void
  openPalette(open: boolean): void
  setCollapsed(collapsed: boolean, persist?: boolean): void
}

const KEY = 'dockinng.sidebar'

export const useUiStore = create<UiState>((set) => ({
  ctxMenuOpen: false,
  paletteOpen: false,
  collapsed: typeof document !== 'undefined' && document.documentElement.classList.contains('is-collapsed'),
  openCtxMenu: (ctxMenuOpen) => set({ ctxMenuOpen }),
  openPalette: (paletteOpen) => set({ paletteOpen }),
  setCollapsed(collapsed, persist = true) {
    document.documentElement.classList.toggle('is-collapsed', collapsed)
    if (persist) {
      safeStorage().setItem(KEY, collapsed ? 'collapsed' : 'expanded')
    }
    set({ collapsed })
  },
}))
export const uiStore = useUiStore
