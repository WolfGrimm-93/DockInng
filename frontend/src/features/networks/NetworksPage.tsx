// Vista «Redes». Datos REALES: listar y eliminar. Las redes del sistema o con contenedores conectados no se eliminan.
// «Nueva red» es SIMULADO (aún sin comando de creación): avisa con un toast «No conectado aún».
import { safeText } from '@/lib/safeText'
import { useRef } from 'react'
import { usePreviewState } from '@/app/devFlags'
import { useGuardedAction } from '@/components/shared/ConfirmDialog'
import { Icon } from '@/components/shared/Icon'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyState } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { useEngineStoreApi, useNetworks } from '@/data/store/hooks'
import type { Network } from '@/data/types'
import { toast } from '@/lib/toastStore'
import { useViewGate } from '../common/gate'
import { resourceState } from '../common/listStates'
import { VirtualTable } from '../common/VirtualTable'

const COLS = 5
const newNetwork = () => toast.warn('Simulado — no conectado aún', { sub: 'Crear redes todavía no está conectado al motor de Docker: no se creó nada.' })

export default function NetworksPage() {
  const { list, status, error } = useNetworks()
  const store = useEngineStoreApi()
  const guard = useGuardedAction()
  const gate = useViewGate(COLS, 6)
  const preview = usePreviewState()
  const scrollRef = useRef<HTMLDivElement>(null)

  const remove = async (n: Network) => {
    const r = await guard({ type: 'remove_network', id: n.id })
    if (r.status === 'done') {
      void store.getState().refresh('networks')
      document.getElementById('viewTitle')?.focus({ preventScroll: true })
    }
  }

  const head = (
    <PageHeader
      title="Redes"
      count={gate.isError ? null : list.length}
      primary={<Button variant="primary" locked={gate.locked} title="Todavía no conectado al motor (simulado)" onClick={newNetwork}><Icon name="plus" />Nueva red</Button>}
    />
  )
  if (gate.blocked) return <>{head}{gate.blocked}</>
  const st = resourceState({ status, hasRows: list.length > 0, preview, error, refresh: () => void store.getState().refresh('networks'), what: 'las redes', cols: COLS, rows: 6 })
  if (st) return <>{head}{st}</>
  if (preview === 'empty' || (status === 'ready' && list.length === 0)) {
    return (
      <>
        {head}
        <div className="view-body">
          <EmptyState icon="network" title="No hay redes personalizadas" text="Crea una red para que tus contenedores se encuentren por nombre."
            actions={<Button variant="primary" onClick={newNetwork}><Icon name="plus" />Nueva red</Button>} />
        </div>
      </>
    )
  }

  return (
    <>
      {head}
      <div className="view-body" ref={scrollRef}>
        {gate.lostBanner}
        <VirtualTable
          caption="Lista de redes"
          cols={COLS}
          scrollRef={scrollRef}
          rows={list}
          rowKey={(n) => n.id}
          head={
            <tr aria-rowindex={1}>
              <th scope="col" className="cell-name">Nombre</th>
              <th scope="col" className="col-subnet">Subred</th>
              <th scope="col" className="num">Contenedores</th>
              <th scope="col"><span className="sr-only">Tipo</span></th>
              <th scope="col" className="col-actions"><span className="sr-only">Acciones</span></th>
            </tr>
          }
          renderRow={(n, { index, measure }) => {
            const subnet = n.subnets.length ? n.subnets.join(', ') : '—'
            return (
              <tr ref={measure} data-index={index} aria-rowindex={index + 2}>
                <td className="cell-name">
                  <div className="name-cell">
                    <b title={safeText(n.name, { singleLine: true })}>{safeText(n.name, { singleLine: true })}</b>
                    <small className="mono">{safeText(n.driver, { singleLine: true })} · {safeText(n.scope, { singleLine: true })}</small>
                    <small className="sub-extra">{safeText(subnet, { singleLine: true })}</small>
                  </div>
                </td>
                <td className="mono col-subnet">{safeText(subnet, { singleLine: true })}</td>
                <td className="num">{n.connected.length}</td>
                <td>{n.system ? <span className="tag"><Icon name="lock" size="sm" />Del sistema</span> : null}</td>
                <td className="col-actions">
                  <div className="row-actions">
                    <Button variant="ghost" size="icon" className="btn-del" locked={gate.locked} disabled={n.system || n.connected.length > 0} aria-label={`Eliminar red ${safeText(n.name, { singleLine: true })}`} onClick={() => void remove(n)}><Icon name="trash" /></Button>
                  </div>
                </td>
              </tr>
            )
          }}
        />
        <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>Las redes del sistema y las que tienen contenedores conectados no se pueden eliminar.</p>
      </div>
    </>
  )
}
