// Contexto compartido por los módulos del adaptador simulado (stacks, exec, pull, create, resources).
import type { ApiError, Container, EngineFeed } from '../../types'
import type { World } from './fixtures'

export interface SimCtx {
  world: World
  /** ms de latencia de operaciones (0 en tests). */
  latency: number
  /** ms entre ticks de progreso (pull / stack up). */
  tick: number
  /** false en Tauri: no se insertan datos falsos en listas reales. */
  mutate: boolean
  emit(feed: EngineFeed): void
  emitContainer(c: Container, action: string): void
  emitKind(kind: 'image' | 'volume' | 'network', action: string, id: string): void
  find(idOrName: string): Container
  /** ¿La conexión activa es remota? (avisos RemoteBind). */
  isRemote(): boolean
  /** Se invoca cuando un contenedor se detiene (cierra sus sesiones de terminal). */
  onContainerStopped(cb: (id: string) => void): void
  notifyStopped(id: string): void
}

export function apiError(code: ApiError['code'], message: string, cause?: ApiError['cause']): ApiError {
  return cause ? { code, message, cause } : { code, message }
}
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
export const isRunning = (c: Container): boolean => c.state === 'running'
