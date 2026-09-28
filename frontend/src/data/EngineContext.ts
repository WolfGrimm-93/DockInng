// Contexto de la capa de datos (separado de EngineProvider.tsx: un archivo de componentes solo exporta componentes).
import { createContext } from 'react'
import type { EngineApi } from './api'
import type { EngineStore } from './store/engineStore'

export interface EngineContextValue { api: EngineApi; store: EngineStore }
export const EngineContext = createContext<EngineContextValue | null>(null)
