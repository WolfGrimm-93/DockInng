// SIDEBAR FLOTANTE PROPIO (no el `Sidebar` de shadcn: no encaja con el shell flex de la plantilla). Contrato:
//   <FloatingSidebar collapsed onToggleCollapsed nav counts current onOpenPalette />
//   - 240 px (216 bajo 1000 px) ↔ riel de 64 px; la clase `is-collapsed` vive en <html> (uiStore.setCollapsed la aplica).
//   - Sin navbar superior. Riel: tooltips de Base UI a la derecha (solo activos si colapsado). Pie: estado del motor + tema + colapsar + paleta.
//   - Nav: enlaces <a href="#id"> con aria-current="page" en el ítem resaltado (NAV_OF de la ruta actual).
import { Fragment } from 'react'
import logoMark from '@/assets/brand/logo-mark.svg'
import { NAV, type NavId, type NavItemDef } from '@/app/routes'
import { Icon } from '@/components/shared/Icon'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { useTheme } from '@/theme/useTheme'
import { ConnectionSwitcher } from './ConnectionSwitcher'
import { EngineStatus } from './EngineStatus'

export interface FloatingSidebarProps {
  collapsed: boolean
  onToggleCollapsed(): void
  nav?: NavItemDef[]
  counts: Record<string, string | number>
  current: NavId
  onOpenPalette(): void
}

function NavItem({ item, count, current, collapsed }: { item: NavItemDef; count?: string | number; current: boolean; collapsed: boolean }) {
  return (
    <Tooltip label={item.label} side="right" disabled={!collapsed} delay={0}>
      <a className="nav-item" href={`#${item.id}`} aria-label={item.label} aria-current={current ? 'page' : undefined}>
        <Icon name={item.icon} />
        <span className="nav-text">{item.label}</span>
        {count != null ? <span className="badge-count" aria-hidden="true">{count}</span> : null}
      </a>
    </Tooltip>
  )
}

export function FloatingSidebar({ collapsed, onToggleCollapsed, nav = NAV, counts, current, onOpenPalette }: FloatingSidebarProps) {
  const { resolvedMode, toggle } = useTheme()
  const dark = resolvedMode === 'dark'
  const groups: NavItemDef['group'][] = ['Docker', 'Aplicación']
  const collapseLabel = collapsed ? 'Expandir barra lateral' : 'Colapsar barra lateral'
  return (
    <aside className="sidebar" aria-label="Barra lateral">
      <div className="brand">
        <img src={logoMark} alt="" width={28} height={28} />
        <span className="brand-name"><b>Dock</b><span>Inng</span></span>
      </div>

      <ConnectionSwitcher />

      <nav className="nav" aria-label="Secciones">
        {groups.map((g) => (
          <Fragment key={g}>
            <div className="nav-label">{g}</div>
            {nav.filter((n) => n.group === g).map((n) => (
              <NavItem key={n.id} item={n} count={counts[n.id]} current={current === n.id} collapsed={collapsed} />
            ))}
          </Fragment>
        ))}
      </nav>

      <div className="sidebar-foot">
        <EngineStatus />
        <div className="foot-row">
          <Tooltip label="Cambiar tema" side={collapsed ? 'right' : 'top'} delay={0}>
            <Button variant="ghost" size="icon-sm" aria-label={dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'} onClick={toggle}>
              <Icon name={dark ? 'sun' : 'moon'} />
            </Button>
          </Tooltip>
          <Tooltip label={collapseLabel} side={collapsed ? 'right' : 'top'} delay={0}>
            <Button variant="ghost" size="icon-sm" aria-label={collapseLabel} aria-expanded={!collapsed} onClick={onToggleCollapsed}>
              <Icon name="panel" />
            </Button>
          </Tooltip>
          <Tooltip label="Paleta de comandos (Ctrl+K)" side={collapsed ? 'right' : 'top'} delay={0}>
            <Button variant="ghost" size="icon-sm" aria-label="Abrir paleta de comandos (Ctrl+K)" onClick={onOpenPalette}>
              <Icon name="command" />
            </Button>
          </Tooltip>
        </div>
      </div>
    </aside>
  )
}
