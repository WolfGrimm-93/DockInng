// Estado del motor en el pie del sidebar. role="status" + aria-label completo (en el riel solo se ve el icono).
// Contrato: <EngineStatus/> (lee useConnection). Textos: «Motor conectado» / «Sin conexión» / «Conexión perdida» / «Conectando…».
import { Tooltip } from '@/components/ui/tooltip'
import { Icon } from '@/components/shared/Icon'
import { useConnection } from '@/data/store/hooks'
import { useUiStore } from '@/app/uiStore'
import { safeText } from '@/lib/safeText'

export function EngineStatus() {
  const c = useConnection()
  const collapsed = useUiStore((s) => s.collapsed)
  const bad = c.state.status === 'error' || c.state.status === 'lost'
  const info = c.state.status === 'connected' || c.state.status === 'lost' ? c.state.info : null
  const version = info ? `Docker ${info.version} · API ${info.api_version}` : c.profile.version
  const title = c.state.status === 'lost' ? 'Conexión perdida' : c.state.status === 'error' ? 'Sin conexión' : c.state.status === 'connecting' ? 'Conectando…' : 'Motor conectado'
  const sub = bad ? c.profile.target : c.state.status === 'connecting' ? c.profile.target : version || 'Docker'
  const aria = safeText(`${title}. ${sub}${bad ? '' : `. Conexión ${c.profile.name}`}`, { singleLine: true })
  return (
    <Tooltip label={<><b>{title}</b><br />{sub}</>} side="right" disabled={!collapsed} delay={0}>
      <div className={`engine${bad ? ' is-error' : ''}`} role="status" tabIndex={0} aria-label={aria}>
        <span className="engine-ico"><Icon name={bad ? 'x' : 'check'} /></span>
        <span className="engine-text">
          <strong>{title}</strong>
          <small>{sub}</small>
        </span>
      </div>
    </Tooltip>
  )
}
