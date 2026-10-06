// Vista «Stacks (Compose)». Datos REALES: la lista sale del store (FUENTE ÚNICA, igual que el contador del menú).
// Levantar/Reiniciar con progreso en vivo (store.stackOps); «Bajar…» y «Eliminar stack…» pasan por la política (confirmación escrita con el nombre).
// Sin Docker Compose: la lista sigue visible con las acciones desactivadas (aviso compacto); sin stacks, panel a página completa.
import { safeText } from '@/lib/safeText'
import { useState } from 'react'
import { devFlagsEnabled, getDevFlags, setComposeMissing, useComposeMissing, usePreviewState } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { useGuardedAction } from '@/components/shared/useGuardedAction'
import { Icon } from '@/components/shared/Icon'
import { PageHeader } from '@/components/shared/PageHeader'
import { AlertBox, ComposeMissing, EmptyState } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { apiErrorMessage } from '@/data/errors'
import { useCapability, useConnection, useContainers, useEngineApi, useEngineStore, useEngineStoreApi } from '@/data/store/hooks'
import type { StackSummary } from '@/data/types'
import { toast } from '@/lib/toastStore'
import { useStartupOnce } from '../common/devOnce'
import { useViewGate } from '../common/gate'
import { LinkStackDialog } from './LinkStackDialog'
import { NewStackDialog } from './NewStackDialog'
import { StackCard } from './StackCard'
import { useStacks } from './useStacks'

export default function StacksPage() {
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const route = useHashRoute()
  const guard = useGuardedAction()
  const gate = useViewGate(4, 6)
  const connected = useConnection().state.status === 'connected'
  const preview = usePreviewState()
  const composeFlag = useComposeMissing()
  const cap = useCapability('stacks')
  const { list, status, available, compose, reload, recheck } = useStacks()
  const ops = useEngineStore((s) => s.stackOps)
  const { list: containers } = useContainers()
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [newOpen, setNewOpen] = useState(false)
  const [link, setLink] = useState<{ open: boolean; path: string }>({ open: false, path: '' })
  const missing = composeFlag || available === false

  const withBusy = async (name: string, fn: () => Promise<void>) => {
    setBusy((b) => ({ ...b, [name]: true }))
    try { await fn() } finally { setBusy((b) => ({ ...b, [name]: false })) }
  }
  const down = (s: StackSummary) => withBusy(s.name, async () => {
    const r = await guard({ type: 'stack_down', project: s.name })
    if (r.status === 'done') {
      store.getState().noteStackDown(s.name)
      document.getElementById('viewTitle')?.focus({ preventScroll: true })
    }
  })
  const del = (s: StackSummary) => withBusy(s.name, async () => {
    const r = await guard({ type: 'stack_delete', name: s.name })
    if (r.status === 'done') {
      void store.getState().refresh('stacks')
      document.getElementById('viewTitle')?.focus({ preventScroll: true })
    }
  })
  const unlink = (s: StackSummary) => withBusy(s.name, async () => {
    try {
      await api.stacks.unlink(s.name)
      toast.ok(`Stack ${safeText(s.name, { singleLine: true })} desvinculado`, { sub: 'No se borró ningún archivo.' })
      await store.getState().refresh('stacks')
    } catch (e) {
      const m = apiErrorMessage(e)
      toast.err(m.title, { sub: m.detail })
    }
  })
  const onRecheck = async () => {
    setComposeMissing(false)
    const ok = await recheck()
    if (ok) toast.ok('Docker Compose disponible')
    else {
      setComposeMissing(true)
      toast.err('Docker Compose sigue sin encontrarse', { sub: compose?.flavor === 'standalone' && !compose.supported ? 'Solo se admite Docker Compose v2.' : 'docker compose version no devolvió nada.' })
    }
  }
  const serviceHref = (s: StackSummary) => (svc: string): string | undefined => {
    const c = containers.find((x) => x.compose_project === s.name && x.compose_service === svc)
    return c ? route.href('detail', { c: c.names[0] }) : undefined
  }

  // ?dialog=stack-down (solo simulado/DEV)
  const ready = connected && status === 'ready' && list.length > 0 && !preview && devFlagsEnabled(api)
  useStartupOnce('stacks.dialog', ready, () => {
    const first = list.find((s) => s.containers > 0)
    if (getDevFlags().dialog === 'stack-down' && first) void down(first)
  })

  const head = (
    <PageHeader
      title="Stacks (Compose)"
      count={gate.isError ? null : list.length}
      simulated={cap !== 'live'}
      secondary={<Button variant="secondary" locked={gate.locked} onClick={() => setNewOpen(true)}><Icon name="plus" />Nuevo stack</Button>}
      primary={<Button variant="primary" locked={gate.locked} onClick={() => setLink({ open: true, path: '' })}><Icon name="file" />Abrir archivo Compose</Button>}
    />
  )
  const dialogs = (
    <>
      <NewStackDialog open={newOpen} existing={list.map((s) => s.name)} onClose={() => setNewOpen(false)} onCreated={(s) => { setNewOpen(false); route.go('stack-edit', { stack: s.name }) }} />
      <LinkStackDialog open={link.open} initialPath={link.path} onClose={() => setLink({ open: false, path: '' })} onLinked={(s) => { setLink({ open: false, path: '' }); route.go('stack-edit', { stack: s.name }) }} />
    </>
  )
  if (gate.blocked) return <>{head}{gate.blocked}</>
  if (missing && list.length === 0 && status !== 'loading') return <>{head}<div className="view-body">{gate.lostBanner}<ComposeMissing detail={compose?.flavor === 'standalone' && !compose.supported ? 'Se encontró Docker Compose v1, que no es compatible: instala Compose v2.' : null} onRecheck={() => void onRecheck()} /></div>{dialogs}</>
  if (preview === 'loading' || status === 'loading') {
    return (
      <>
        {head}
        <div className="view-body" aria-busy="true">
          <div className="card card-pad" role="status" aria-label="Cargando stacks">
            <span className="skeleton w-40 mb-3.5"  />
            <span className="skeleton w-full mb-2.5"  />
            <span className="skeleton w-[90%] mb-2.5"  />
            <span className="skeleton w-[70%]"  />
          </div>
        </div>
      </>
    )
  }
  if (status === 'error' && list.length === 0) {
    return <>{head}<div className="view-body"><AlertBox kind="error" icon="alert" title="No se pudieron cargar los stacks" text="Reintenta en unos segundos." actions={<Button variant="secondary" size="sm" onClick={() => void reload()}><Icon name="refresh" size="sm" />Reintentar</Button>} /></div></>
  }
  if (preview === 'empty' || list.length === 0) {
    return (
      <>
        {head}
        <div className="view-body">
          <EmptyState icon="grid" title="No hay stacks todavía" text="DockInng encuentra los stacks a partir de los contenedores creados con docker compose y de los que crees aquí."
            actions={<><Button variant="primary" locked={gate.locked} onClick={() => setNewOpen(true)}><Icon name="plus" />Nuevo stack</Button><Button variant="secondary" locked={gate.locked} onClick={() => setLink({ open: true, path: '' })}><Icon name="file" />Abrir archivo Compose</Button></>} />
        </div>
        {dialogs}
      </>
    )
  }

  return (
    <>
      {head}
      <div className="view-body">
        {gate.lostBanner}
        {missing ? <ComposeMissing compact detail={compose?.flavor === 'standalone' && !compose.supported ? 'Se encontró Docker Compose v1, que no es compatible.' : null} onRecheck={() => void onRecheck()} /> : null}
        {list.map((s) => (
          <StackCard
            key={s.name} stack={s} op={ops[s.name]} locked={gate.locked} composeMissing={missing} policyBusy={!!busy[s.name]}
            editHref={route.href('stack-edit', { stack: s.name })} serviceHref={serviceHref(s)}
            onUp={() => store.getState().runStackOp(s.name, 'up')} onRestart={() => store.getState().runStackOp(s.name, 'restart')} onStop={() => store.getState().runStackOp(s.name, 'stop')} onStart={() => store.getState().runStackOp(s.name, 'start')} onPull={() => store.getState().runStackOp(s.name, 'pull')}
            onDown={() => void down(s)} onDelete={() => void del(s)} onUnlink={() => void unlink(s)}
            onLink={() => setLink({ open: true, path: s.config_files[0] ?? '' })}
            onCancelOp={() => store.getState().cancelStackOp(s.name)} onDismissOp={() => store.getState().dismissStackOp(s.name)}
          />
        ))}
      </div>
      {dialogs}
    </>
  )
}
