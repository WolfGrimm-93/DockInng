// Vista «Descargar imagen» (#pull?image=&pull=running|done|canceled|error). Descarga REAL por capas (subscribe_pull).
// El estado vive en el store (`pulls[referencia]`): la descarga SIGUE EN SEGUNDO PLANO al salir de la pantalla y avisa por toast al terminar.
// Cancelar = abort del stream en el daemon (las capas ya descargadas se conservan en caché).
import { safeText } from '@/lib/safeText'
import { useEffect, useMemo, useRef, useState } from 'react'
import { devFlagsEnabled } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { Icon } from '@/components/shared/Icon'
import { LayerProgress } from '@/components/shared/LayerProgress'
import { PageHeader } from '@/components/shared/PageHeader'
import { AlertBox, EmptyState } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { useCapability, useEngineApi, useEngineStore, useEngineStoreApi, usePull } from '@/data/store/hooks'
import type { ApiError, PullLayer, PullOp } from '@/data/types'
import { formatBytesPrecise } from '@/lib/format'
import { hasExplicitTag, registryOf, validateImageRef } from '@/lib/imageRef'
import { pullErrorText } from '@/lib/resourceNames'
import { useViewGate } from '../common/gate'
import { LinkButton } from '../common/LinkButton'

const MB = 1024 * 1024
/** Capas de ejemplo de la plantilla (id, MB) para los estados de vista previa (?pull=). */
const SAMPLE: [string, number][] = [['a3b8c1d92e07', 30.4], ['5f1e9a7b3c42', 12.1], ['9d02c6e8f1a5', 88.7], ['c47b2e0d9a13', 5.6], ['e18f4a6b7c90', 41.2]]
function preset(pct: number[], state: PullOp['state'], error: ApiError | null = null): PullOp {
  const layers: PullLayer[] = SAMPLE.map(([id, mb], i) => ({ id, total: Math.round(mb * MB), done: Math.round((mb * MB * pct[i]) / 100), phase: pct[i] >= 100 ? 'complete' : pct[i] > 0 ? 'downloading' : 'waiting' }))
  return { reference: 'postgres:16.4', state, layers, doneBytes: layers.reduce((a, l) => a + l.done, 0), totalBytes: layers.reduce((a, l) => a + l.total, 0), upToDate: false, digest: null, error }
}
const PRESETS: Record<string, PullOp> = {
  running: preset([100, 100, 62, 18, 0], 'pulling'),
  done: preset([100, 100, 100, 100, 100], 'done'),
  canceled: preset([100, 100, 34, 0, 0], 'canceled'),
  error: preset([100, 100, 12, 0, 0], 'error', { code: 'engine', message: 'toomanyrequests: el registro respondió 429 (demasiadas peticiones).' }),
}

export default function PullPage() {
  const route = useHashRoute()
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const gate = useViewGate(4, 6)
  const cap = useCapability('pull')
  const dev = devFlagsEnabled(api)
  const presetOp = dev ? PRESETS[route.params.get('pull') ?? ''] ?? null : null
  const activeRef = useEngineStore((s) => Object.values(s.pulls).find((p) => p.state === 'pulling')?.reference ?? null)

  const [ref, setRef] = useState(() => route.params.get('image') ?? activeRef ?? 'postgres:16.4')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PullOp | null>(presetOp)
  const storeOp = usePull(ref)
  const op = storeOp ?? preview
  const refInput = useRef<HTMLInputElement>(null)

  const target = ref.trim()
  const pulling = op?.state === 'pulling'
  const start = () => {
    const bad = validateImageRef(target)
    setFieldError(bad)
    if (bad) { refInput.current?.focus(); return }
    setPreview(null)
    setRef(target)
    store.getState().dismissPull(target) // «Descargar de nuevo» parte de cero
    store.getState().startPull(target)
  }
  const cancel = () => {
    if (preview) setPreview({ ...preview, state: 'canceled' })
    else store.getState().cancelPull(target)
  }

  // Anuncio para lectores de pantalla SOLO en hitos (inicio, 50 %, fin, error): las capas no son aria-live.
  const pct = op && op.totalBytes > 0 ? (op.doneBytes / op.totalBytes) * 100 : 0
  const [announce, setAnnounce] = useState('')
  const last = useRef<string>('')
  const errText = op?.error ? pullErrorText(target, op.error) : ''
  useEffect(() => {
    if (!op) return
    const key = op.state === 'pulling' ? (pct >= 50 ? 'half' : 'start') : op.state
    if (key === last.current) return
    last.current = key
    setAnnounce(
      key === 'start' ? `Descargando ${target}` : key === 'half' ? 'Descarga al 50 %' : key === 'done' ? `${target} descargada` : key === 'canceled' ? 'Descarga cancelada' : `Error al descargar: ${errText}`,
    )
  }, [op, pct, target, errText])

  const head = <PageHeader title="Descargar imagen" back={{ href: route.href('images'), label: 'Imágenes' }} simulated={cap !== 'live'} />
  const summary = useMemo(() => {
    if (!op) return ''
    if (op.totalBytes > 0 && op.layers.every((l) => l.total > 0)) return `${formatBytesPrecise(op.doneBytes)} de ${formatBytesPrecise(op.totalBytes)}`
    return `${formatBytesPrecise(op.doneBytes)} descargados`
  }, [op])
  if (gate.blocked) return <>{head}{gate.blocked}</>

  return (
    <>
      {head}
      <div className="toolbar">
        <label className="field" style={{ flex: '1 1 320px', maxWidth: 520 }}>
          <Icon name="download" />
          <input ref={refInput} className="input" id="pullRef" value={ref} aria-label="Imagen a descargar" placeholder="registro/nombre:etiqueta" disabled={pulling}
            aria-invalid={!!fieldError} aria-describedby={fieldError ? 'pullErr' : 'pullHint'}
            onChange={(e) => { setRef(e.target.value); setFieldError(null); setPreview(null) }} onKeyDown={(e) => { if (e.key === 'Enter' && !pulling && !gate.locked) start() }} />
        </label>
        {pulling ? (
          <Button variant="secondary" locked={gate.locked} onClick={cancel}><Icon name="x" />Cancelar descarga</Button>
        ) : (
          <Button variant="primary" locked={gate.locked} onClick={start}><Icon name="download" />{!op ? 'Descargar' : 'Descargar de nuevo'}</Button>
        )}
      </div>
      <div className="view-body">
        {gate.lostBanner}
        {fieldError ? <span className="f-error" id="pullErr"><Icon name="alert" size="sm" />{fieldError}</span> : (
          <span className="f-hint" id="pullHint">{target && !hasExplicitTag(target) ? `Sin etiqueta: se descargará :latest de «${safeText(target, { singleLine: true })}».` : 'Formato «nombre:etiqueta» o «registro/nombre:etiqueta».'}</span>
        )}
        <div className="sr-only" role="status" aria-live="polite">{announce}</div>
        {op?.state === 'canceled' ? <AlertBox kind="info" icon="info" title="Descarga cancelada" text="Las capas ya descargadas se conservan en caché: si vuelves a descargar, se reanuda desde ahí." /> : null}
        {op?.state === 'error' ? (
          <AlertBox kind="error" icon="alert" title={`No se pudo descargar ${safeText(target, { singleLine: true })}`} text={safeText(errText)} actions={<><Button variant="secondary" size="sm" locked={gate.locked} onClick={start}><Icon name="refresh" size="sm" />Reintentar</Button>{op.error?.code === 'auth_required' ? <LinkButton variant="primary" size="sm" href={route.href('settings', { tab: 'registries', registry: registryOf(target) })}><Icon name="lock" size="sm" />Añadir credenciales del registro</LinkButton> : null}</>} />
        ) : null}
        {op?.state === 'done' ? (
          <AlertBox
            kind="info"
            icon="check"
            title={op.upToDate ? `${safeText(target, { singleLine: true })} ya estaba al día` : `${safeText(target, { singleLine: true })} descargada`}
            text={op.upToDate ? 'No había una versión más nueva en el registro.' : 'Ya puedes crear un contenedor con esta imagen.'}
            actions={<LinkButton variant="primary" size="sm" href={route.href('create', { image: target })}><Icon name="play" size="sm" fill />Ejecutar</LinkButton>}
          />
        ) : null}
        {!op ? (
          <EmptyState icon="download" title="Elige qué imagen descargar" text="Escribe el nombre con su etiqueta. Verás el avance de cada capa y podrás cancelar en cualquier momento; la descarga continúa aunque cambies de pantalla." />
        ) : (
          <section className="card" aria-label="Progreso por capa">
            <header style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <b className="mono">{safeText(target, { singleLine: true })}</b>
              <span className="muted" style={{ marginLeft: 'auto' }} id="pullTotal" aria-live="off">{op.layers.length ? summary : op.state === 'pulling' ? 'Conectando con el registro…' : ''}</span>
            </header>
            <div id="layers">
              {op.layers.length === 0 && pulling ? <div className="layer"><span className="muted">Esperando las capas…</span></div> : <LayerProgress layers={op.layers} pulling={pulling} />}
            </div>
          </section>
        )}
      </div>
    </>
  )
}
