// Vista «Imágenes». Datos REALES: listar y eliminar (por el flujo de política: plan → confirmación → ejecución).
// «En uso» = nº de contenedores que la usan (dato del motor). Eliminar queda deshabilitado si está en uso.
import { safeText } from '@/lib/safeText'
import { useMemo, useRef, useState } from 'react'
import { usePreviewState } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { useGuardedAction } from '@/components/shared/useGuardedAction'
import { Icon } from '@/components/shared/Icon'
import { PageHeader } from '@/components/shared/PageHeader'
import { SearchField } from '@/components/shared/SearchField'
import { EmptyState } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { useEngineStoreApi, useImages } from '@/data/store/hooks'
import type { Image } from '@/data/types'
import { formatBytes, relativeTimeEs, shortId } from '@/lib/format'
import { toast } from '@/lib/toastStore'
import { useViewGate } from '../common/gate'
import { resourceState } from '../common/listStates'
import { LinkButton } from '../common/LinkButton'
import { NoMatch } from '../common/NoMatch'
import { VirtualTable } from '../common/VirtualTable'

const GIB = 1024 ** 3
const COLS = 5

export default function ImagesPage() {
  const { list, status, error, totalBytes } = useImages()
  const store = useEngineStoreApi()
  const route = useHashRoute()
  const guard = useGuardedAction()
  const gate = useViewGate(COLS, 7)
  const preview = usePreviewState()
  const [q, setQ] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const n = q.trim().toLowerCase()
    return n ? list.filter((i) => `${i.reference} ${i.id}`.toLowerCase().includes(n)) : list
  }, [list, q])

  const remove = async (i: Image) => {
    const r = await guard({ type: 'remove_image', reference: i.reference })
    if (r.status === 'done') {
      void store.getState().refresh('images')
      document.getElementById('viewTitle')?.focus({ preventScroll: true })
    }
  }
  const pruneUnused = async () => {
    if (!list.some((i) => i.containers === 0)) {
      toast.ok('No hay imágenes sin usar')
      return
    }
    const r = await guard({ type: 'prune_images' })
    if (r.status === 'done') {
      void store.getState().refresh('images')
      document.getElementById('viewTitle')?.focus({ preventScroll: true })
    }
  }

  const head = (
    <PageHeader
      title="Imágenes"
      count={gate.isError ? null : `${list.length} · ${(totalBytes / GIB).toFixed(1)} GB`}
      secondary={<><LinkButton variant="secondary" locked={gate.locked} href={route.href('build')}><Icon name="layers" />Construir imagen</LinkButton><Button variant="outline-destructive" locked={gate.locked} onClick={() => void pruneUnused()}><Icon name="trash" />Eliminar sin usar…</Button></>}
      primary={<LinkButton variant="primary" locked={gate.locked} href={route.href('pull')}><Icon name="download" />Descargar imagen</LinkButton>}
    />
  )
  if (gate.blocked) return <>{head}{gate.blocked}</>
  const st = resourceState({ status, hasRows: list.length > 0, preview, error, refresh: () => void store.getState().refresh('images'), what: 'las imágenes', cols: COLS, rows: 7 })
  if (st) return <>{head}{st}</>
  if (preview === 'empty' || (status === 'ready' && list.length === 0)) {
    return (
      <>
        {head}
        <div className="view-body">
          <EmptyState icon="layers" title="No hay imágenes descargadas" text="Descarga una imagen desde un registro para poder crear contenedores con ella."
            actions={<LinkButton variant="primary" href={route.href('pull')}><Icon name="download" />Descargar imagen</LinkButton>} />
        </div>
      </>
    )
  }

  return (
    <>
      {head}
      <div className="toolbar"><SearchField id="q" placeholder="Buscar imagen por nombre o ID" value={q} onChange={setQ} /></div>
      <div className="view-body" ref={scrollRef}>
        {gate.lostBanner}
        <VirtualTable
          caption="Lista de imágenes"
          cols={COLS}
          scrollRef={scrollRef}
          rows={rows}
          rowKey={(i) => i.reference}
          empty={<NoMatch what="Ninguna imagen coincide" onClear={() => setQ('')} />}
          head={
            <tr aria-rowindex={1}>
              <th scope="col" className="cell-name">Imagen</th>
              <th scope="col" className="col-id">ID y fecha</th>
              <th scope="col" className="num col-size">Tamaño</th>
              <th scope="col">Uso</th>
              <th scope="col" className="col-actions"><span className="sr-only">Acciones</span></th>
            </tr>
          }
          renderRow={(i, { index, measure }) => {
            const rel = relativeTimeEs(i.created)
            const id12 = shortId(i.id)
            const runRef = i.dangling ? i.id : i.reference
            return (
              <tr ref={measure} data-index={index} aria-rowindex={index + 2}>
                <td className="cell-name">
                  <div className="name-cell">
                    <b title={safeText(i.reference, { singleLine: true })}>{safeText(i.repository, { singleLine: true })}</b>
                    <small className="mono" title={safeText(i.tag, { singleLine: true })}>{safeText(i.tag, { singleLine: true })}</small>
                    <small className="sub-extra">{id12} · {rel}</small>
                  </div>
                </td>
                <td className="col-id mono muted">
                  {id12}
                  <div className="muted" style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-xs)' }}>{rel}</div>
                </td>
                <td className="num col-size">{formatBytes(i.size_bytes)}</td>
                <td>{i.containers > 0 ? <span className="tag"><Icon name="check" size="sm" />En uso · {i.containers}</span> : <span className="tag">Sin usar</span>}</td>
                <td className="col-actions">
                  <div className="row-actions">
                    <Tooltip label="Ejecutar">
                      <LinkButton variant="ghost" size="icon" locked={gate.locked} href={route.href('create', { image: runRef })} aria-label={`Ejecutar ${safeText(i.reference, { singleLine: true })}`}><Icon name="play" fill /></LinkButton>
                    </Tooltip>
                    <span className="sep" aria-hidden="true" />
                    <Button variant="ghost" size="icon" className="btn-del" locked={gate.locked} disabled={i.containers > 0} aria-label={`Eliminar ${safeText(i.reference, { singleLine: true })}`} onClick={() => void remove(i)}><Icon name="trash" /></Button>
                  </div>
                </td>
              </tr>
            )
          }}
        />
      </div>
    </>
  )
}
