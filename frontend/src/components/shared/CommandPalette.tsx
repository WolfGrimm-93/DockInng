// PALETA DE COMANDOS (Ctrl+K), propia sobre Dialog (sin cmdk). Contrato:
//   <CommandPalette/> se monta una vez (providers). Abre con Ctrl/Cmd+K o botón; se IGNORA si ya hay un diálogo abierto.
//   usePaletteItems(): PaletteItem[]  — vistas (NAV) + acciones + [dev] estado de error + «Ir al contenedor…» / «Iniciar|Detener …» (al escribir)
//   PaletteItem { id; title; icon; kind:'Vista'|'Acción'|'Bloqueado'|'Contenedor'|'Plantilla'; run() }
//   ARIA: input role=combobox (aria-expanded, aria-controls, aria-activedescendant, aria-autocomplete=list) + ul role=listbox + li role=option.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useHashRoute } from '@/app/useHashRoute'
import { NAV } from '@/app/routes'
import { useUiStore } from '@/app/uiStore'
import { devFlagsEnabled } from '@/app/devFlags'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { containerName } from '@/data/store/engineStore'
import { useContainers, useEngineApi, useEngineStoreApi } from '@/data/store/hooks'
import { safeText } from '@/lib/safeText'
import { useTheme } from '@/theme/useTheme'
import { useBlockedDialog } from './ConfirmDialog'
import { Icon } from './Icon'
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

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen)
  const setOpen = useUiStore((s) => s.openPalette)
  const [query, setQuery] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const items = usePaletteItems(query)
  const active = Math.min(idx, Math.max(0, items.length - 1))

  // Ctrl/Cmd+K: abre; se ignora si hay un diálogo abierto (confirmación, bloqueado…).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (useUiStore.getState().paletteOpen) return
        if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
        setQuery('')
        setIdx(0)
        setOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setOpen])

  useEffect(() => {
    document.getElementById(`pal-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, items.length])

  const run = (i: number) => {
    const it = items[i]
    if (!it) return
    setOpen(false)
    it.run()
  }
  const has = items.length > 0

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) { setQuery(''); setIdx(0) } }}>
      <DialogContent className="palette" aria-label="Paleta de comandos" initialFocus={inputRef}>
        <div className="palette-in">
          <Icon name="search" />
          <input
            ref={inputRef}
            id="palIn"
            type="text"
            placeholder="Buscar vista o acción…"
            aria-label="Buscar comando"
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={has}
            aria-controls="palList"
            aria-activedescendant={has ? `pal-${active}` : undefined}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setIdx(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(Math.min(items.length - 1, active + 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(Math.max(0, active - 1)) }
              else if (e.key === 'Enter') { e.preventDefault(); run(active) }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette-list" id="palList" role="listbox" aria-label="Resultados" hidden={!has}>
          {items.map((x, i) => (
            <li key={x.id} role="option" id={`pal-${i}`} aria-selected={i === active} onClick={() => run(i)}>
              <Icon name={x.icon} />
              {x.title}
              <small>{x.kind}</small>
            </li>
          ))}
        </ul>
        {!has ? <div className="palette-empty" role="status">Sin resultados</div> : null}
      </DialogContent>
    </Dialog>
  )
}
