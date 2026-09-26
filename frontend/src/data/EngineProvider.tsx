// Proveedor de la capa de datos. Crea (o recibe) el EngineApi y el store y lanza bootstrap().
// Contrato: <EngineProvider api?={EngineApi} store?={EngineStore}>…</EngineProvider>; hooks en data/store/hooks.ts.
import { createContext, useEffect, useMemo, type ReactNode } from 'react'
import type { EngineApi } from './api'
import { asSim, createEngineApi } from './createEngineApi'
import { createEngineStore, type EngineStore } from './store/engineStore'
import { resetSubscriptions } from './adapters/tauri'

export interface EngineContextValue { api: EngineApi; store: EngineStore }
export const EngineContext = createContext<EngineContextValue | null>(null)

export interface EngineProviderProps {
  api?: EngineApi
  store?: EngineStore
  /** Se llama una vez, con el api ya creado y ANTES de bootstrap (devFlags: fallos simulados, conexión activa). */
  prepare?: (api: EngineApi) => void
  /** Se llama tras bootstrap (devFlags: ?state=lost). */
  onReady?: (api: EngineApi, store: EngineStore) => void
  children: ReactNode
}

export function EngineProvider({ api, store, prepare, onReady, children }: EngineProviderProps) {
  const value = useMemo<EngineContextValue>(() => {
    const a = api ?? createEngineApi()
    prepare?.(a)
    return { api: a, store: store ?? createEngineStore(a) }
    // prepare/onReady son estables (funciones de módulo); solo cuenta el api/store recibido.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, store])

  useEffect(() => {
    const { api: a, store: s } = value
    // Tras una recarga del webview pueden quedar suscripciones huérfanas en el backend.
    // Recargar/cerrar la ventana aborta descargas y operaciones de stack en curso (los Channels mueren con el webview): se pide confirmación.
    const onBefore = (e: BeforeUnloadEvent) => {
      const st = s.getState()
      if (Object.values(st.stackOps).some((o) => o.state === 'running') || Object.values(st.pulls).some((p) => p.state === 'pulling')) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', onBefore)
    // Solo en desarrollo: expone los controles del simulado para depurar y para los guiones E2E (contadores de sesiones, fallos forzados).
    if (import.meta.env.DEV) (window as unknown as { __dockinngSim?: unknown }).__dockinngSim = asSim(a) ?? undefined
    // Se cierran las suscripciones huérfanas ANTES de bootstrap (si no, el reset podría matar las recién abiertas).
    const reset = a.mode === 'tauri' ? resetSubscriptions() : Promise.resolve()
    void reset.then(() => s.getState().bootstrap()).then(() => onReady?.(a, s))
    return () => { window.removeEventListener('beforeunload', onBefore); s.getState().dispose() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>
}
