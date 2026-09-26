// Vista «Volúmenes». Datos REALES: listar y eliminar (confirmación con nombre / ELIMINAR según el motor de política).
// «Nuevo volumen» es REAL (create_volume): diálogo con validación; la fila nueva se resalta unos segundos.
import { safeText } from '@/lib/safeText'
import { useEffect, useMemo, useRef, useState } from 'react'
import { devFlagsEnabled, getDevFlags, usePreviewState } from '@/app/devFlags'
import { useGuardedAction } from '@/components/shared/ConfirmDialog'
import { Icon } from '@/components/shared/Icon'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyState } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { useEngineApi, useEngineStoreApi, useVolumes } from '@/data/store/hooks'
import type { Volume } from '@/data/types'
import { formatBytes } from '@/lib/format'
import { toast } from '@/lib/toastStore'
import { useStartupOnce } from '../common/devOnce'
import { useViewGate } from '../common/gate'
import { resourceState } from '../common/listStates'
import { VirtualTable } from '../common/VirtualTable'
import { NewVolumeDialog } from './NewVolumeDialog'

const COLS = 4


export default function VolumesPage() {
  const { list, status, error } = useVolumes()
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const guard = useGuardedAction()
  const gate = useViewGate(COLS, 6)
  const preview = usePreviewState()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 2200)
    return () => clearTimeout(t)
  }, [flash])
  const newVolume = () => setNewOpen(true)
  const dialog = <NewVolumeDialog open={newOpen} existing={list.map((v) => v.name)} onClose={() => setNewOpen(false)} onCreated={(v) => { setNewOpen(false); setFlash(v.name) }} />
  const total = useMemo(() => list.reduce((a, v) => a + (v.size_bytes ?? 0), 0), [list])

  const after = () => {
    void store.getState().refresh('volumes')
    document.getElementById('viewTitle')?.focus({ preventScroll: true })
  }
  const remove = async (v: Volume) => {
    const r = await guard({ type: 'remove_volume', name: v.name })
    if (r.status === 'done') after()
  }
  const prune = async () => {
    if (!list.some((v) => v.used_by.length === 0)) {
      toast.ok('No hay volúmenes sin usar')
      return
    }
    const r = await guard({ type: 'prune_volumes' })
    if (r.status === 'done') after()
  }

  // ?dialog=volume | prune-volumes (solo simulado/DEV)
  const ready = status === 'ready' && list.length > 0 && !preview && devFlagsEnabled(api)
  useStartupOnce('volumes.dialog', ready, () => {
    const d = getDevFlags().dialog
    if (d === 'volume' && list[5]) void remove(list[5])
    else if (d === 'prune-volumes') void prune()
  })

  const head = (
    <PageHeader
      title="Volúmenes"
      count={gate.isError ? null : `${list.length} · ${formatBytes(total)}`}
      secondary={<Button variant="outline-destructive" locked={gate.locked} onClick={() => void prune()}><Icon name="trash" />Eliminar sin usar…</Button>}
      primary={<Button variant="primary" locked={gate.locked} onClick={newVolume}><Icon name="plus" />Nuevo volumen</Button>}
    />
  )
  if (gate.blocked) return <>{head}{gate.blocked}</>
  const st = resourceState({ status, hasRows: list.length > 0, preview, error, refresh: () => void store.getState().refresh('volumes'), what: 'los volúmenes', cols: COLS, rows: 6 })
  if (st) return <>{head}{st}{dialog}</>
  if (preview === 'empty' || (status === 'ready' && list.length === 0)) {
    return (
      <>
        {head}
        <div className="view-body">
          <EmptyState icon="database" title="No hay volúmenes" text="Los volúmenes guardan datos que sobreviven a los contenedores, como una base de datos."
            actions={<Button variant="primary" locked={gate.locked} onClick={newVolume}><Icon name="plus" />Nuevo volumen</Button>} />
        </div>
        {dialog}
      </>
    )
  }

  return (
    <>
      {head}
      <div className="view-body" ref={scrollRef}>
        {gate.lostBanner}
        <VirtualTable
          caption="Lista de volúmenes"
          cols={COLS}
          scrollRef={scrollRef}
          rows={list}
          rowKey={(v) => v.name}
          head={
            <tr aria-rowindex={1}>
              <th scope="col" className="cell-name">Nombre</th>
              <th scope="col" className="num col-size">Tamaño</th>
              <th scope="col">Usado por</th>
              <th scope="col" className="col-actions"><span className="sr-only">Acciones</span></th>
            </tr>
          }
          renderRow={(v, { index, measure }) => (
            <tr ref={measure} data-index={index} aria-rowindex={index + 2} className={flash === v.name ? 'row-flash' : undefined}>
              <td className="cell-name">
                <div className="name-cell">
                  <b title={safeText(v.name, { singleLine: true })}>{safeText(v.name, { singleLine: true })}</b>
                  <small className="mono" title={safeText(v.mountpoint, { singleLine: true })}>{safeText(v.driver, { singleLine: true })} · {safeText(v.mountpoint, { singleLine: true })}</small>
                </div>
              </td>
              <td className="num col-size">{v.size_bytes == null ? '—' : formatBytes(v.size_bytes)}</td>
              <td>
                {v.used_by.length ? (
                  <span className="tag" title={safeText(v.used_by.join(', '), { singleLine: true })}><Icon name="check" size="sm" />{safeText(v.used_by[0], { singleLine: true })}{v.used_by.length > 1 ? ` +${v.used_by.length - 1}` : ''}</span>
                ) : <span className="tag">Sin usar</span>}
              </td>
              <td className="col-actions">
                <div className="row-actions">
                  <Button variant="ghost" size="icon" className="btn-del" locked={gate.locked} disabled={v.used_by.length > 0} aria-label={`Eliminar volumen ${safeText(v.name, { singleLine: true })}`} onClick={() => void remove(v)}><Icon name="trash" /></Button>
                </div>
              </td>
            </tr>
          )}
        />
        <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>Los volúmenes en uso no se pueden eliminar: elimina primero el contenedor que los usa. Eliminar un volumen pide escribir su nombre.</p>
      </div>
      {dialog}
    </>
  )
}
