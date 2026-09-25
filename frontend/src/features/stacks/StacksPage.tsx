// Vista «Stacks (Compose)». SIMULADA: la gestión Compose todavía no está conectada al motor (marca «No conectado aún»).
// «Bajar…» sí pasa por el flujo de política (confirmación escrita con el nombre del stack).
import { safeText } from '@/lib/safeText'
import { useState } from 'react'
import { devFlagsEnabled, getDevFlags, setComposeMissing, usePreviewState, useComposeMissing } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { useGuardedAction } from '@/components/shared/ConfirmDialog'
import { Icon } from '@/components/shared/Icon'
import { PageHeader } from '@/components/shared/PageHeader'
import { AlertBox, ComposeMissing, EmptyState } from '@/components/shared/StateViews'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { Button } from '@/components/ui/button'
import { useConnection, useEngineApi, useEngineStoreApi, useIsSimulatedWorld } from '@/data/store/hooks'
import type { StackSummary } from '@/data/types'
import { toast } from '@/lib/toastStore'
import { useStartupOnce } from '../common/devOnce'
import { useViewGate } from '../common/gate'
import { LinkButton } from '../common/LinkButton'
import { useStacks } from './useStacks'

const HEALTH: Record<string, string> = { running: 'var(--status-running)', paused: 'var(--status-paused)', restarting: 'var(--status-restarting)' }

export default function StacksPage() {
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const route = useHashRoute()
  const guard = useGuardedAction()
  const gate = useViewGate(4, 6)
  const connected = useConnection().state.status === 'connected'
  const preview = usePreviewState()
  const composeFlag = useComposeMissing()
  const browserWorld = useIsSimulatedWorld()
  const { list, status, available, reload, recheck } = useStacks()
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const missing = composeFlag || available === false

  const down = async (s: StackSummary) => {
    if (missing) { toast.err('Docker Compose no está instalado', { sub: 'Instálalo para levantar o bajar stacks.' }); return }
    const r = await guard({ type: 'stack_down', project: s.name })
    if (r.status === 'done') {
      void store.getState().refresh('all')
      void reload()
      document.getElementById('viewTitle')?.focus({ preventScroll: true })
    }
  }
  const up = (s: StackSummary) => {
    if (missing) { toast.err('Docker Compose no está instalado', { sub: 'Instálalo para levantar o bajar stacks.' }); return }
    setRunning((r) => ({ ...r, [s.name]: true }))
    api.stacks.up(s.name, (p) => {
      if (p.state === 'done') {
        setRunning((r) => ({ ...r, [s.name]: false }))
        if (browserWorld) toast.ok(`Stack ${safeText(s.name, { singleLine: true })} levantado`)
        else toast.warn(`Simulado — no conectado aún`, { sub: `«${safeText(s.name, { singleLine: true })}» no se levantó: la gestión Compose todavía no está conectada.` })
      }
    })
  }
  const restart = async (s: StackSummary) => {
    if (missing) { toast.err('Docker Compose no está instalado', { sub: 'Instálalo para levantar o bajar stacks.' }); return }
    await api.stacks.restart(s.name)
    if (browserWorld) toast.ok(`Stack ${safeText(s.name, { singleLine: true })} reiniciado`)
    else toast.warn('Simulado — no conectado aún', { sub: `«${safeText(s.name, { singleLine: true })}» no se reinició: la gestión Compose todavía no está conectada.` })
  }
  const onRecheck = async () => {
    setComposeMissing(false)
    const ok = await recheck()
    if (ok) toast.ok('Docker Compose disponible')
    else {
      setComposeMissing(true)
      toast.err('Docker Compose sigue sin encontrarse', { sub: 'docker compose version no devolvió nada.' })
    }
  }

  // ?dialog=stack-down (solo simulado/DEV)
  const ready = connected && status === 'ready' && list.length > 0 && !preview && !missing && devFlagsEnabled(api)
  useStartupOnce('stacks.dialog', ready, () => {
    if (getDevFlags().dialog === 'stack-down') void down(list[0])
  })

  const head = (
    <PageHeader
      title="Stacks (Compose)"
      count={gate.isError ? null : list.length}
      simulated
      primary={<LinkButton variant="primary" locked={gate.locked} href={route.href('stack-edit')}><Icon name="file" />Abrir archivo Compose</LinkButton>}
    />
  )
  if (gate.blocked) return <>{head}{gate.blocked}</>
  if (missing) return <>{head}<div className="view-body">{gate.lostBanner}<ComposeMissing onRecheck={() => void onRecheck()} /></div></>
  if (preview === 'loading' || status === 'loading') {
    return (
      <>
        {head}
        <div className="view-body" aria-busy="true">
          <div className="card card-pad" role="status" aria-label="Cargando stacks">
            <span className="skeleton" style={{ width: 160, marginBottom: 14 }} />
            <span className="skeleton" style={{ width: '100%', marginBottom: 10 }} />
            <span className="skeleton" style={{ width: '90%', marginBottom: 10 }} />
            <span className="skeleton" style={{ width: '70%' }} />
          </div>
        </div>
      </>
    )
  }
  if (status === 'error') {
    return <>{head}<div className="view-body"><AlertBox kind="error" icon="alert" title="No se pudieron cargar los stacks" text="Reintenta en unos segundos." actions={<Button variant="secondary" size="sm" onClick={() => void reload()}><Icon name="refresh" size="sm" />Reintentar</Button>} /></div></>
  }
  if (preview === 'empty' || list.length === 0) {
    return (
      <>
        {head}
        <div className="view-body">
          <EmptyState icon="grid" title="No se detectó ningún stack" text="DockInng encuentra los stacks a partir de los contenedores creados con docker compose. Abre un archivo Compose para levantar el primero."
            actions={<LinkButton variant="primary" href={route.href('stack-edit')}><Icon name="file" />Abrir archivo Compose</LinkButton>} />
        </div>
      </>
    )
  }

  return (
    <>
      {head}
      <div className="view-body">
        {gate.lostBanner}
        {!browserWorld ? <AlertBox kind="info" icon="flask" title="Datos de ejemplo: no conectado aún" text="La gestión de stacks Compose todavía no está conectada al motor. Los stacks de esta lista son una demostración, no los de tu equipo." /> : null}
        {list.map((s) => {
          const okN = s.services.filter((x) => x.state === 'running').length
          const n = s.services.length
          return (
            <section className="card stack-card" aria-label={`Stack ${safeText(s.name, { singleLine: true })}`} key={s.name}>
              <header>
                <div>
                  <h3 style={{ overflowWrap: 'anywhere' }}>{safeText(s.name, { singleLine: true })}</h3>
                  <div className="path" style={{ overflowWrap: 'anywhere' }}>{safeText(s.path, { singleLine: true })}</div>
                </div>
                <span className="spacer">
                  <span className="health" role="img" aria-label={`${okN} de ${n} servicios en ejecución`}>
                    {s.services.map((x) => <i key={x.name} style={{ flex: 1, background: HEALTH[x.state] ?? 'var(--status-exited)' }} />)}
                  </span>
                  <span className="muted" style={{ minWidth: 84, textAlign: 'right' }}>{okN} de {n} activos</span>
                  <LinkButton variant="secondary" size="sm" locked={gate.locked} href={route.href('stack-edit', { stack: s.name })}><Icon name="edit" size="sm" />Editar</LinkButton>
                  <Button variant="secondary" size="sm" locked={gate.locked || !!running[s.name]} onClick={() => up(s)}><Icon name={running[s.name] ? 'loader' : 'play'} size="sm" fill={!running[s.name]} spin={!!running[s.name]} />Levantar</Button>
                  <Button variant="secondary" size="sm" locked={gate.locked} onClick={() => void restart(s)}><Icon name="rotate" size="sm" />Reiniciar</Button>
                  <span className="sep" aria-hidden="true" />
                  <Button variant="outline-destructive" size="sm" locked={gate.locked} onClick={() => void down(s)}><Icon name="square" size="sm" fill />Bajar…</Button>
                </span>
              </header>
              {s.services.map((x) => (
                <div className="svc" key={x.name}>
                  <b>{safeText(x.name, { singleLine: true })}</b>
                  <span><StatusBadge state={x.state} /></span>
                  <span className="mono svc-image" title={safeText(x.image, { singleLine: true })}>{safeText(x.image, { singleLine: true })}</span>
                  <span className="muted" style={{ textAlign: 'right' }} title="Réplicas en ejecución">{x.replicas}</span>
                </div>
              ))}
            </section>
          )
        })}
      </div>
    </>
  )
}
