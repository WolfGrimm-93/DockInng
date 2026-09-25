// Utilidades de test de las vistas: proveedores reales (motor simulado en memoria, confirmaciones, toasts) y navegación por hash.
import { resetGroupsStore } from './groups/groupsStore'
import { render } from '@testing-library/react'
import { StrictMode, type ReactElement } from 'react'
import { ConfirmProvider } from '@/components/shared/ConfirmDialog'
import { Toaster } from '@/components/shared/Toaster'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createSimApi, type SimEngineApi } from '@/data/adapters/sim'
import { EngineProvider } from '@/data/EngineProvider'
import { setComposeMissing, setPreviewState } from '@/app/devFlags'
import { toast } from '@/lib/toastStore'
import { resetStartupOnce } from './common/devOnce'

export function makeApi(): SimEngineApi {
  return createSimApi({ latency: 0, tick: 5 })
}

export function renderView(ui: ReactElement, opts: { api?: SimEngineApi; hash?: string } = {}) {
  const api = opts.api ?? makeApi()
  window.location.hash = opts.hash ?? ''
  const r = render(
    <StrictMode><TooltipProvider>
      <EngineProvider api={api}>
        <ConfirmProvider>
          {ui}
          <Toaster />
        </ConfirmProvider>
      </EngineProvider>
    </TooltipProvider></StrictMode>,
  )
  return { api, ...r }
}

/** Limpia estado global entre tests (toasts, vista previa, hash). */
export function resetGlobals(): void {
  resetGroupsStore()
  toast.clear()
  setPreviewState(null)
  setComposeMissing(false)
  resetStartupOnce()
  window.location.hash = ''
}
