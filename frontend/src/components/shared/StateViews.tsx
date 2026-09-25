// VISTAS DE ESTADO (contratos en la cabecera de cada componente):
//   EmptyState{icon,title,text,actions?}          vacío
//   AlertBox{kind:'info'|'warn'|'error',icon,title,text,actions?}
//   SkeletonTable{cols,rows}                       carga (aria-busy)
//   ErrorPanel{diagnostic,connectionName,target,onRetry,onChangeConnection}   permission denied / daemon apagado / SSH
//   LostBanner{onRetry,onChangeConnection,since?}  desconectado durante el uso (se conservan los datos)
//   ComposeMissing{onRecheck}                      Docker Compose ausente
//   SimulatedTag                                   «No conectado aún»
//   ConnectionGate{children, loading?}             aplica automáticamente error/lost/connecting a una vista de datos
import { useState, type ReactNode } from 'react'
import { useUiStore } from '@/app/uiStore'
import { useConnection } from '@/data/store/hooks'
import { fixCommandOf } from '@/data/diagnostics'
import type { Diagnostic } from '@/data/types'
import { toast } from '@/lib/toastStore'
import { Button } from '@/components/ui/button'
import { Icon } from './Icon'
import type { IconName } from './iconNames'

export function EmptyState({ icon, title, text, actions }: { icon: IconName; title: string; text: string; actions?: ReactNode }) {
  return (
    <div className="card">
      <div className="state">
        <span className="state-ico"><Icon name={icon} size="lg" /></span>
        <h2>{title}</h2>
        <p>{text}</p>
        {actions ? <div className="btns">{actions}</div> : null}
      </div>
    </div>
  )
}

export function AlertBox({ kind, icon, title, text, actions }: { kind: 'info' | 'warn' | 'error'; icon: IconName; title: string; text: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon name={icon} />
      <div>
        <b>{title}</b>
        <p>{text}</p>
        {actions ? <div className="btns">{actions}</div> : null}
      </div>
    </div>
  )
}

export function SkeletonTable({ cols, rows }: { cols: number; rows: number }) {
  return (
    <div className="table-wrap" aria-busy="true" role="status" aria-label="Cargando datos">
      <table>
        <thead>
          <tr>
            {Array.from({ length: cols }, (_, i) => (
              <th key={i}><span className="skeleton" style={{ width: 40 + ((i * 13) % 40), height: 10 }} /></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r} className="sk-row">
              {Array.from({ length: cols }, (_, j) => (
                <td key={j}><span className="skeleton" style={{ width: j === 1 ? 140 : 50 + (((r + j) * 17) % 50) }} /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

async function copyCommand(cmd: string) {
  try {
    await navigator.clipboard.writeText(cmd)
    toast.ok('Comando copiado', { sub: cmd })
  } catch {
    toast.warn('No se pudo copiar', { sub: cmd })
  }
}

export function ErrorPanel({ diagnostic, connectionName, target, onRetry, onChangeConnection }: {
  diagnostic: Diagnostic
  connectionName: string
  target: string
  onRetry(): void
  onChangeConnection(): void
}) {
  const fix = fixCommandOf(diagnostic)
  void connectionName
  void target // ya incluidos en diagnostic.lead
  return (
    <div className="card error-panel" role="alert">
      <header>
        <Icon name="alert" size="lg" />
        <div>
          <h2>{diagnostic.title}</h2>
          <p>{diagnostic.lead}</p>
        </div>
      </header>
      <ol className="diag">
        {diagnostic.steps.map((s, i) => (
          <li key={i} className={s.state === 'skip' ? 'skip-step' : s.state}>
            <span className="step-ico"><Icon name={s.state === 'ok' ? 'check' : s.state === 'fail' ? 'x' : 'dots'} size="sm" /></span>
            <div>
              <b>{i + 1}. {s.title}</b>
              <p>{s.detail}</p>
              {s.command ? <code>{s.command}</code> : null}
              {s.hint ? <p style={{ marginTop: 6 }}>{s.hint}</p> : null}
            </div>
            <span className="tag" style={s.state === 'fail' ? { color: 'var(--status-dead)' } : undefined}>{s.tag}</span>
          </li>
        ))}
      </ol>
      <footer>
        <Button variant="primary" onClick={onRetry}><Icon name="refresh" />Reintentar conexión</Button>
        {fix ? <Button variant="secondary" onClick={() => void copyCommand(fix)}><Icon name="copy" />Copiar comando</Button> : null}
        <Button variant="ghost" onClick={onChangeConnection}>Cambiar de conexión</Button>
      </footer>
    </div>
  )
}

export function LostBanner({ onRetry, onChangeConnection, since }: { onRetry(): void; onChangeConnection(): void; since?: number }) {
  // La antigüedad se calcula al montar (no en cada render): «hace N s» es orientativo.
  const [secs] = useState(() => (since ? Math.max(1, Math.round((Date.now() - since) / 1000)) : 12))
  return (
    <AlertBox
      kind="error"
      icon="alert"
      title="Se perdió la conexión con el motor"
      text={`Mostrando los últimos datos conocidos (hace ${secs} s). Las acciones están desactivadas hasta reconectar.`}
      actions={
        <>
          <Button variant="secondary" size="sm" onClick={onRetry}><Icon name="refresh" size="sm" />Reconectar</Button>
          <Button variant="ghost" size="sm" onClick={onChangeConnection}>Cambiar de conexión</Button>
        </>
      }
    />
  )
}

export function ComposeMissing({ onRecheck }: { onRecheck(): void }) {
  return (
    <div className="card error-panel is-info" role="status">
      <header>
        <Icon name="warn" size="lg" />
        <div>
          <h2>Docker Compose no está instalado</h2>
          <p>DockInng necesita el plugin <code>docker compose</code> para levantar, bajar y editar stacks. Los contenedores y las imágenes siguen funcionando.</p>
        </div>
      </header>
      <ol className="diag">
        <li className="fail">
          <span className="step-ico"><Icon name="x" size="sm" /></span>
          <div>
            <b>docker compose version</b>
            <p>Comando no encontrado.</p>
            <code>sudo pacman -S docker-compose</code>
            <p style={{ marginTop: 6 }}>En Debian o Ubuntu: <code style={{ display: 'inline', padding: '0 4px', margin: 0 }}>sudo apt install docker-compose-plugin</code></p>
          </div>
          <span className="tag" style={{ color: 'var(--status-dead)' }}>Falta</span>
        </li>
      </ol>
      <footer>
        <Button variant="primary" onClick={onRecheck}><Icon name="refresh" />Volver a comprobar</Button>
        <Button variant="secondary" onClick={() => void copyCommand('sudo pacman -S docker-compose')}><Icon name="copy" />Copiar comando</Button>
      </footer>
    </div>
  )
}

export function SimulatedTag() {
  return (
    <span className="tag" title="Esta sección usa datos de ejemplo: todavía no está conectada al motor.">
      <Icon name="flask" size="sm" />
      No conectado aún
    </span>
  )
}

/** Aplica el estado global de conexión a una vista de datos. Configuración NO lo usa (siempre funciona). */
export function ConnectionGate({ children, loading }: { children: ReactNode; loading?: ReactNode }) {
  const c = useConnection()
  const openMenu = () => useUiStore.getState().openCtxMenu(true)
  if (c.state.status === 'error') {
    const target = c.profile.remote ? c.profile.target : c.state.diagnostic.lead
    return (
      <div className="view-body">
        <ErrorPanel diagnostic={c.state.diagnostic} connectionName={c.profile.name} target={target} onRetry={c.retry} onChangeConnection={openMenu} />
      </div>
    )
  }
  if (c.state.status === 'connecting') return <div className="view-body">{loading ?? <SkeletonTable cols={7} rows={8} />}</div>
  return (
    <>
      {c.state.status === 'lost' ? <LostBanner since={c.state.since} onRetry={c.retry} onChangeConnection={openMenu} /> : null}
      {children}
    </>
  )
}
