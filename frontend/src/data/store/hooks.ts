// HOOKS de datos (firma congelada; FrontViews solo importa de aquí). Contrato:
//   useEngineApi(): EngineApi                       · useEngineStore(selector)
//   useConnection(): { state, issue, profile, profiles, retry(), select(id), isLost, isBlocked }
//   useContainers(): { list, status, counts:{total,running,stopped}, error }
//   useContainer(nameOrId): Container | undefined
//   useImages(): { list, status, totalBytes, error }  · useVolumes(): { list, status, error } · useNetworks(): { list, status, error }
//   useStats(id): ContainerStats | undefined          · useRowOps(id): RowOp
//   useNavCounts(): Record<string, string|number>     · useCapability(f): 'live'|'simulated'
//   useIsSimulatedWorld(): boolean (true en navegador: todo el mundo es de ejemplo)
import { useContext, useMemo } from 'react'
import { useStore } from 'zustand'
import type { EngineApi, Capability, Feature } from '../api'
import { EngineContext } from '../EngineProvider'
import type { ComposeInfo, ConnectionIssue, ConnectionProfile, ConnectionState, Container, ContainerStats, GpuInfo, PullOp, StackOpState, SystemUsage } from '../types'
import type { EngineStore, EngineStoreState, RowOp } from './engineStore'
import { containerCounts, findContainer, listOf, navCounts, totalImageBytes } from './selectors'

function useCtx() {
  const c = useContext(EngineContext)
  if (!c) throw new Error('EngineProvider ausente: envuelve la app con <EngineProvider>.')
  return c
}
export const useEngineApi = (): EngineApi => useCtx().api
export const useEngineStoreApi = (): EngineStore => useCtx().store
export function useEngineStore<T>(selector: (s: EngineStoreState) => T): T {
  return useStore(useCtx().store, selector)
}

const FALLBACK_PROFILE: ConnectionProfile = { id: 'local', name: 'Local', target: 'unix:///var/run/docker.sock', kind: 'local', icon: 'monitor', remote: false, version: '', simulated: false }

export function useConnection(): {
  state: ConnectionState
  issue: ConnectionIssue | null
  profile: ConnectionProfile
  profiles: ConnectionProfile[]
  retry(): void
  select(id: string): void
  /** conexión perdida: hay datos, pero las acciones deben quedar bloqueadas (aria-disabled + .is-locked). */
  isLost: boolean
  /** true si no se puede actuar (perdida, error o conectando). */
  isBlocked: boolean
} {
  const store = useEngineStoreApi()
  const state = useStore(store, (s) => s.connection)
  const profiles = useStore(store, (s) => s.profiles)
  const activeId = useStore(store, (s) => s.activeProfileId)
  const profile = profiles.find((p) => p.id === activeId) ?? profiles[0] ?? FALLBACK_PROFILE
  const issue: ConnectionIssue | null = state.status === 'error' ? state.issue : state.status === 'lost' ? 'lost' : null
  return {
    state, issue, profile, profiles,
    retry: () => void store.getState().retry(),
    select: (id) => void store.getState().selectProfile(id),
    isLost: state.status === 'lost',
    isBlocked: state.status !== 'connected',
  }
}

export function useContainers() {
  const entity = useEngineStore((s) => s.containers)
  return useMemo(
    () => ({ list: listOf(entity), status: entity.status, error: entity.error, counts: containerCounts({ containers: entity }) }),
    [entity],
  )
}
export function useContainer(nameOrId: string | null | undefined): Container | undefined {
  const entity = useEngineStore((s) => s.containers)
  return useMemo(() => findContainer({ containers: entity }, nameOrId), [entity, nameOrId])
}
export function useImages() {
  const e = useEngineStore((s) => s.images)
  return useMemo(() => {
    const list = listOf(e)
    return { list, status: e.status, error: e.error, totalBytes: totalImageBytes(list) }
  }, [e])
}
export function useVolumes() {
  const e = useEngineStore((s) => s.volumes)
  return useMemo(() => ({ list: listOf(e), status: e.status, error: e.error }), [e])
}
export function useNetworks() {
  const e = useEngineStore((s) => s.networks)
  return useMemo(() => ({ list: listOf(e), status: e.status, error: e.error }), [e])
}
export function useStackList() {
  const e = useEngineStore((s) => s.stacks)
  return useMemo(() => ({ list: listOf(e), status: e.status, error: e.error }), [e])
}
export const useStackOp = (project: string): StackOpState | undefined => useEngineStore((s) => s.stackOps[project])
export const usePull = (reference: string): PullOp | undefined => useEngineStore((s) => s.pulls[reference.trim()])
/** Estado de Docker Compose (null = aún no comprobado). */
export const useCompose = (): ComposeInfo | null => useEngineStore((s) => s.compose)
export const useStats = (id: string): ContainerStats | undefined => useEngineStore((s) => s.stats[id])
/** Todas las muestras de CPU/memoria por id de contenedor (la franja de consumo y las cabeceras de stack las suman). */
export const useAllStats = (): Record<string, ContainerStats> => useEngineStore((s) => s.stats)
/** CPU/RAM del equipo y disco de Docker; null = aún no cargado. */
export const useSystemUsage = (): SystemUsage | null => useEngineStore((s) => s.system)
/** GPU del equipo (vacío = sin GPU detectada). */
export const useGpu = (): GpuInfo[] => useEngineStore((s) => s.gpu)
const NO_OP: RowOp = {}
export const useRowOps = (id: string): RowOp => useEngineStore((s) => s.rowOps[id] ?? NO_OP)

export function useNavCounts(): Record<string, string | number> {
  const containers = useEngineStore((s) => s.containers)
  const images = useEngineStore((s) => s.images)
  const volumes = useEngineStore((s) => s.volumes)
  const networks = useEngineStore((s) => s.networks)
  const stacks = useEngineStore((s) => s.stacks)
  return useMemo(
    () => navCounts({ containers, images, volumes, networks, stacks }),
    [containers, images, volumes, networks, stacks],
  )
}
export function useCapability(f: Feature): Capability {
  return useEngineApi().capabilities[f]
}
export const useIsSimulatedWorld = (): boolean => useEngineApi().mode === 'browser'
