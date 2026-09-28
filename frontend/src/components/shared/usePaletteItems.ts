// Elementos de la paleta de comandos (vistas, acciones y contenedores según lo escrito). Separado de CommandPalette.tsx: solo componentes allí.
import { useMemo } from 'react'
import { useHashRoute } from '@/app/useHashRoute'
import { NAV } from '@/app/routes'
import { useUiStore } from '@/app/uiStore'
import { devFlagsEnabled } from '@/app/devFlags'
import { containerName } from '@/data/store/engineStore'
import { useContainers, useEngineApi, useEngineStoreApi } from '@/data/store/hooks'
import { safeText } from '@/lib/safeText'
import { useTheme } from '@/theme/useTheme'
import { useBlockedDialog } from './confirmApi'
import type { IconName } from './iconNames'

export interface PaletteItem { id: string; title: string; icon: IconName; kind: 'Vista' | 'Acción' | 'Bloqueado' | 'Contenedor' | 'Plantilla'; run(): void }

export function usePaletteItems(query = ''): PaletteItem[] {
  const route = useHashRoute()
  const { toggle } = useTheme()
  const blocked = useBlockedDialog()
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const { list } = useContainers()
  const setCollapsed = useUiStore((s) => s.setCollapsed)
  const collapsed = useUiStore((s) => s.collapsed)
  const q = query.trim().toLowerCase()

  return useMemo(() => {
    const items: PaletteItem[] = [
      ...NAV.map((n): PaletteItem => ({ id: `go-${n.id}`, title: `Ir a ${n.label}`, icon: n.icon, kind: 'Vista', run: () => route.go(n.id) })),
      { id: 'new-container', title: 'Nuevo contenedor…', icon: 'plus', kind: 'Acción', run: () => route.go('create') },
      { id: 'pull-image', title: 'Descargar imagen…', icon: 'download', kind: 'Acción', run: () => route.go('pull') },
      { id: 'build-image', title: 'Construir imagen…', icon: 'layers', kind: 'Acción', run: () => route.go('build') },
      { id: 'theme', title: 'Cambiar tema claro/oscuro', icon: 'sun', kind: 'Acción', run: toggle },
      { id: 'sidebar', title: 'Colapsar o expandir barra lateral', icon: 'panel', kind: 'Acción', run: () => setCollapsed(!collapsed) },
      { id: 'prune-system', title: 'Limpiar todo el sistema', icon: 'ban', kind: 'Bloqueado', run: () => void blocked() },
    ]
    if (devFlagsEnabled(api)) {
      items.push({ id: 'dev-error', title: 'Ver estado: error de conexión', icon: 'alert', kind: 'Plantilla', run: () => { store.getState().previewConnection('permission'); route.go('containers') } })
    }
    if (q) {
      for (const c of list) {
        const name = safeText(containerName(c), { singleLine: true })
        if (!name.toLowerCase().includes(q)) continue
        items.push({ id: `c-${c.id}`, title: `Ir al contenedor ${name}`, icon: 'box', kind: 'Contenedor', run: () => route.go('detail', { c: name }) })
        const on = c.state === 'running' || c.state === 'paused' || c.state === 'restarting'
        items.push({ id: `op-${c.id}`, title: `${on ? 'Detener' : 'Iniciar'} ${name}`, icon: on ? 'square' : 'play', kind: 'Contenedor', run: () => void store.getState().runContainerOp(c.id, on ? 'stop' : 'start') })
      }
    }
    return items.filter((i) => !q || i.title.toLowerCase().includes(q)).slice(0, 40)
  }, [route, toggle, blocked, api, store, list, setCollapsed, collapsed, q])
}
