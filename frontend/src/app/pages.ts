// Mapa ruta -> página con CODE-SPLITTING (React.lazy): cada vista es un chunk aparte. Cada archivo de página mantiene
// `export default` de un componente. AppShell envuelve el render en <Suspense fallback={<PageFallback/>}>.
import { lazy, type ComponentType } from 'react'
import type { RouteId } from './routes'

export const PAGES: Record<RouteId, ComponentType> = {
  containers: lazy(() => import('@/features/containers/ContainersPage')),
  detail: lazy(() => import('@/features/containers/ContainerDetailPage')),
  create: lazy(() => import('@/features/containers/CreateContainerPage')),
  images: lazy(() => import('@/features/images/ImagesPage')),
  pull: lazy(() => import('@/features/images/PullPage')),
  volumes: lazy(() => import('@/features/volumes/VolumesPage')),
  networks: lazy(() => import('@/features/networks/NetworksPage')),
  stacks: lazy(() => import('@/features/stacks/StacksPage')),
  'stack-edit': lazy(() => import('@/features/stacks/StackEditPage')),
  settings: lazy(() => import('@/features/settings/SettingsPage')),
  'conn-new': lazy(() => import('@/features/settings/ConnNewPage')),
}
