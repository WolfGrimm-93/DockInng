// Capas de proveedores (orden del plan): Theme > Tooltip > Engine > Confirm > (Toaster + CommandPalette) > app.
// El store de toasts es un módulo (no requiere provider); <Toaster/> y <CommandPalette/> se montan aquí una sola vez.
import { useEffect, type ReactNode } from 'react'
import { CommandPalette } from '@/components/shared/CommandPalette'
import { ConfirmProvider } from '@/components/shared/ConfirmDialog'
import { Toaster } from '@/components/shared/Toaster'
import { TooltipProvider } from '@/components/ui/tooltip'
import { EngineProvider } from '@/data/EngineProvider'
import { useEngineApi } from '@/data/store/hooks'
import type { EngineApi } from '@/data/api'
import type { EngineStore } from '@/data/store/engineStore'
import { ThemeProvider } from '@/theme/ThemeProvider'
import { applyPrepare, applyReady } from './devFlags'

/** Conecta la caché de grupos al almacén del backend (migra `dockinng.groups.v1` la primera vez). */
function GroupsBackend() {
  const api = useEngineApi()
  // Carga diferida: el almacén de grupos no entra en el bundle principal (solo lo usan la tabla de contenedores y Configuración).
  useEffect(() => {
    let off: (() => void) | null = null
    let alive = true
    void import('@/features/groups/groupsStore').then((m) => { if (alive) off = m.bindGroupsBackend(api) })
    return () => { alive = false; off?.() }
  }, [api])
  return null
}

export function Providers({ children, api, store }: { children: ReactNode; api?: EngineApi; store?: EngineStore }) {
  return (
    <ThemeProvider>
      <TooltipProvider delay={300} closeDelay={0}>
        <EngineProvider api={api} store={store} prepare={applyPrepare} onReady={applyReady}>
          <GroupsBackend />
          <ConfirmProvider>
            {children}
            <CommandPalette />
            <Toaster />
          </ConfirmProvider>
        </EngineProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}
