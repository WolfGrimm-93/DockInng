// Vista «Contenedor» (#detail?c=<nombre>&tab=logs|terminal|stats|inspect). Cabecera con acciones, línea meta y 4 pestañas.
//   Logs / Estadísticas / Inspeccionar / Terminal: datos REALES (la terminal es xterm sobre un exec del motor).
import { safeText } from '@/lib/safeText'
import { useEffect, useMemo, useState } from 'react'
import { useHashRoute } from '@/app/useHashRoute'
import { describePlan } from '@/components/shared/planDescribe'
import { formatBytes } from '@/lib/format'
import { useGuardedAction } from '@/components/shared/useGuardedAction'
import { Icon } from '@/components/shared/Icon'
import type { IconName } from '@/components/shared/iconNames'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyState } from '@/components/shared/StateViews'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { TerminalTab } from './terminal/TerminalTab'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { apiErrorMessage } from '@/data/errors'
import { containerName } from '@/data/store/engineStore'
import { useContainer, useContainers, useEngineApi, useEngineStoreApi, useRowOps, useVolumes } from '@/data/store/hooks'
import type { Container, ContainerDetail } from '@/data/types'
import { statusTextEs } from '@/lib/format'
import { isOn } from '../common/containerUtils'
import { hasMorePorts, mainPortsText, portEntries, totalPorts } from '../common/ports'
import { ContainerInfoDialog, type InfoTab } from './ContainerInfoDialog'
import { endpointsOf } from '../common/netinfo'
import { useViewGate } from '../common/gate'
import { LinkButton } from '../common/LinkButton'
import { InspectTab } from './InspectTab'
import { LogsTab } from './LogsTab'
import { StatsTab } from './StatsTab'

type Tab = 'logs' | 'terminal' | 'stats' | 'inspect'
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'logs', label: 'Logs', icon: 'file' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'stats', label: 'Estadísticas', icon: 'activity' },
  { id: 'inspect', label: 'Inspeccionar', icon: 'braces' },
]
const isTab = (s: string | null): s is Tab => s === 'logs' || s === 'terminal' || s === 'stats' || s === 'inspect'

export default function ContainerDetailPage() {
  const route = useHashRoute()
  const name = route.params.get('c') ?? ''
  const c = useContainer(name)
  const { status } = useContainers()
  const gate = useViewGate(4, 6)
  const back = { href: route.href('containers'), label: 'Contenedores' }

  if (gate.blocked) return <><PageHeader title={safeText(name, { singleLine: true }) || 'Contenedor'} back={back} />{gate.blocked}</>
  if (!c) {
    const loading = status === 'idle' || status === 'loading'
    return (
      <>
        <PageHeader title={safeText(name, { singleLine: true }) || 'Contenedor'} back={back} />
        <div className="view-body">
          {gate.lostBanner}
          {loading ? null : (
            <EmptyState
              icon="box"
              title="No se encontró el contenedor"
              text={name ? 'Puede haberse eliminado o renombrado. Vuelve a la lista para elegir otro.' : 'Falta el nombre del contenedor en la dirección.'}
              actions={<LinkButton variant="primary" href={route.href('containers')}>Ver contenedores</LinkButton>}
            />
          )}
        </div>
      </>
    )
  }
  return <Detail key={c.id} c={c} initialTab={isTab(route.params.get('tab')) ? (route.params.get('tab') as Tab) : 'logs'} />
}

function Detail({ c, initialTab }: { c: Container; initialTab: Tab }) {
  const route = useHashRoute()
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const guard = useGuardedAction()
  const { list: volumes } = useVolumes()
  const gate = useViewGate(4, 6)
  const op = useRowOps(c.id)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [detail, setDetail] = useState<ContainerDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const name = safeText(containerName(c), { singleLine: true })
  const portList = useMemo(() => portEntries(c.ports), [c.ports])
  const [infoTab, setInfoTab] = useState<InfoTab | null>(null)
  const on = isOn(c.state)
  const busy = op.busy
  const locked = gate.locked

  useEffect(() => {
    let alive = true
    api.containers.inspect(c.id).then(
      (d) => { if (alive) { setDetail(d); setDetailError(null) } },
      (e) => { if (alive) setDetailError(apiErrorMessage(e).detail) },
    )
    return () => { alive = false }
  }, [api, c.id, c.state])

  const remove = async () => {
    const req = { type: 'remove_containers' as const, ids: [c.id] }
    const r = await guard(req, (plan) => describePlan(plan, req, { volumeSize: (n) => { const v = volumes.find((x) => x.name === n); return v?.size_bytes != null ? formatBytes(v.size_bytes) : undefined } }))
    if (r.status === 'done') {
      void store.getState().refresh('all')
      route.go('containers')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <header className="view-head" style={{ paddingBottom: 6 }}>
        <div style={{ width: '100%' }}>
          <a className="crumb" href={route.href('containers')}><Icon name="back" size="sm" />Contenedores</a>
        </div>
        <div className="detail-title">
          <h1 id="viewTitle" tabIndex={-1}>{name}</h1>
          <StatusBadge state={c.state} busy={busy} live />
          {c.compose_project ? <span className="tag tag-brand"><Icon name="grid" size="sm" />stack {safeText(c.compose_project, { singleLine: true })}</span> : null}
        </div>
        <div className="view-actions">
          {on ? (
            <Button variant="secondary" locked={locked || !!busy} onClick={() => void store.getState().runContainerOp(c.id, 'stop')}><Icon name="square" fill />Detener</Button>
          ) : (
            <Button variant="primary" locked={locked || !!busy} onClick={() => void store.getState().runContainerOp(c.id, 'start')}><Icon name="play" fill />Iniciar</Button>
          )}
          <Button variant="secondary" disabled={!on || !!busy || locked} onClick={() => void store.getState().runContainerOp(c.id, 'restart')}><Icon name="rotate" />Reiniciar</Button>
          <span className="sep" aria-hidden="true" style={{ margin: '4px 10px' }} />
          <Button variant="outline-destructive" locked={locked || !!busy} onClick={() => void remove()}><Icon name="trash" />Eliminar…</Button>
        </div>
      </header>
      {op.error ? <div className="meta-line"><span className="row-error"><Icon name="alert" size="sm" /> {safeText(op.error)}</span></div> : null}
      <div className="meta-line">
        <span>Imagen <span className="mono" title={safeText(c.image)}>{safeText(c.image, { singleLine: true })}</span></span>
        <span>ID <span className="mono">{c.id.slice(0, 12)}</span></span>
        <span>
          IP <span className="mono">{safeText(detail?.ip_address) || '—'}</span>
          {endpointsOf(c).length > 0 ? (
            <Button variant="ghost" size="icon-sm" className="ports-eye" aria-label={`Ver las IPs de ${name} por red`} aria-haspopup="dialog" onClick={() => setInfoTab('ips')}>
              <Icon name="eye" size="sm" />
            </Button>
          ) : null}
        </span>
        <span>
          Puertos <span className="mono">{safeText(mainPortsText(portList))}</span>
          {hasMorePorts(portList) ? (
            <Button variant="ghost" size="icon-sm" className="ports-eye" aria-label={`Ver los ${totalPorts(portList)} puertos de ${name}`} aria-haspopup="dialog" onClick={() => setInfoTab('ports')}>
              <Icon name="eye" size="sm" />
            </Button>
          ) : null}
        </span>
        <span>{statusTextEs(c.status, c.state)}</span>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <TabsList aria-label="Secciones del contenedor">
          {TABS.map((t) => (
            <TabsTab key={t.id} value={t.id}><Icon name={t.icon} />{t.label}</TabsTab>
          ))}
        </TabsList>
        <TabsPanel value="logs" className="view-body tabpanel">{gate.lostBanner}<LogsTab c={c} /></TabsPanel>
        <TabsPanel value="terminal" className="view-body tabpanel">
          {gate.lostBanner}
          <TerminalTab key={c.id} c={c} name={name} />
        </TabsPanel>
        <TabsPanel value="stats" className="view-body tabpanel">{gate.lostBanner}<StatsTab c={c} detail={detail} /></TabsPanel>
        <TabsPanel value="inspect" className="view-body tabpanel">{gate.lostBanner}<InspectTab name={name} detail={detail} error={detailError} /></TabsPanel>
      </Tabs>
      <ContainerInfoDialog target={infoTab ? { c, tab: infoTab } : null} onClose={() => setInfoTab(null)} />
    </div>
  )
}
