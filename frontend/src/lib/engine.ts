// Capa de acceso al backend. La UI nunca habla con Docker: solo invoca comandos de Tauri.
import { invoke } from '@tauri-apps/api/core'

// Espejo de `engine_core::Container` (serde en snake_case).
export type ContainerState =
  | 'created'
  | 'running'
  | 'paused'
  | 'restarting'
  | 'removing'
  | 'exited'
  | 'dead'
  | 'unknown'

export interface Container {
  id: string
  names: string[]
  image: string
  state: ContainerState
  status: string
  compose_project: string | null
}

/** True cuando corre dentro de la app de escritorio (Tauri); false en `pnpm dev` del navegador. */
export const isDesktop = '__TAURI_INTERNALS__' in window

// Datos de muestra solo para desarrollar la UI en el navegador, sin backend.
const DEMO: Container[] = [
  { id: 'a1b2c3d4e5f6', names: ['demo-web'], image: 'nginx:latest', state: 'running', status: 'Up 2 hours', compose_project: 'demo' },
  { id: 'f6e5d4c3b2a1', names: ['demo-db'], image: 'postgres:16', state: 'exited', status: 'Exited (0) 1 day ago', compose_project: 'demo' },
]

export async function listContainers(all: boolean): Promise<Container[]> {
  if (!isDesktop) return DEMO.filter((c) => all || c.state === 'running')
  return invoke<Container[]>('list_containers', { all })
}
