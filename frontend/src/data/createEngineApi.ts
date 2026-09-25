// Elige el adaptador: Tauri (real + simulado de lo no conectado) o simulado completo (navegador/tests).
// Contrato: `createEngineApi(): EngineApi` y `isDesktop()`.
import { isTauri } from '@tauri-apps/api/core'
import type { EngineApi } from './api'
import { createSimApi, type SimControls, type SimEngineApi } from './adapters/sim'
import { createTauriApi } from './adapters/tauri'

export const isDesktop = (): boolean => isTauri()

export function createEngineApi(): EngineApi {
  return isDesktop() ? createTauriApi() : createSimApi()
}

/** Acceso a los controles del simulado (devFlags/tests) solo si el adaptador activo lo es. */
export function asSim(api: EngineApi): SimControls | null {
  return 'sim' in api ? (api as SimEngineApi).sim : null
}
