// Capas de proveedores (orden del plan): Theme > Tooltip > Engine > Confirm > (Toaster + CommandPalette) > app.
// El store de toasts es un módulo (no requiere provider); <Toaster/> y <CommandPalette/> se montan aquí una sola vez.
import type { ReactNode } from 'react'
import { CommandPalette } from '@/components/shared/CommandPalette'
import { ConfirmProvider } from '@/components/shared/ConfirmDialog'
import { Toaster } from '@/components/shared/Toaster'
import { TooltipProvider } from '@/components/ui/tooltip'
import { EngineProvider } from '@/data/EngineProvider'
import type { EngineApi } from '@/data/api'
import type { EngineStore } from '@/data/store/engineStore'
import { ThemeProvider } from '@/theme/ThemeProvider'
import { applyPrepare, applyReady } from './devFlags'

export function Providers({ children, api, store }: { children: ReactNode; api?: EngineApi; store?: EngineStore }) {
  return (
    <ThemeProvider>
      <TooltipProvider delay={300} closeDelay={0}>
        <EngineProvider api={api} store={store} prepare={applyPrepare} onReady={applyReady}>
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
