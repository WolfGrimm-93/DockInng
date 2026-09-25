// Vista «Descargar imagen» (#pull?image=&pull=running|done|canceled|error). SIMULADA: la descarga aún no está conectada
// al motor (marca «No conectado aún»); en Tauri no descarga nada y lo dice. Progreso por capa con <LayerProgress/>.
import { safeText } from '@/lib/safeText'
import { useEffect, useRef, useState } from 'react'
import { devFlagsEnabled } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { Icon } from '@/components/shared/Icon'
import { LayerProgress } from '@/components/shared/LayerProgress'
import { PageHeader } from '@/components/shared/PageHeader'
import { AlertBox, EmptyState } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { useEngineApi, useIsSimulatedWorld } from '@/data/store/hooks'
import type { PullProgress } from '@/data/types'
import { toast } from '@/lib/toastStore'
import { useViewGate } from '../common/gate'
import { LinkButton } from '../common/LinkButton'

type PullState = 'idle' | 'pulling' | 'canceled' | 'error' | 'done'
type Layer = PullProgress['layers'][number]

/** Capas de ejemplo de la plantilla (id, MB) para los estados de vista previa. */
const SAMPLE: [string, number][] = [['a3b8c1d92e07', 30.4], ['5f1e9a7b3c42', 12.1], ['9d02c6e8f1a5', 88.7], ['c47b2e0d9a13', 5.6], ['e18f4a6b7c90', 41.2]]
const preset = (pct: number[]): Layer[] => SAMPLE.map(([id, total], i) => ({ id, total, done: (total * pct[i]) / 100 }))

export default function PullPage() {
  const route = useHashRoute()
  const api = useEngineApi()
  const gate = useViewGate(4, 6)
  const browserWorld = useIsSimulatedWorld()
  const dev = devFlagsEnabled(api)
  const presetName = dev ? route.params.get('pull') : null

  const [ref, setRef] = useState(() => route.params.get('image') ?? 'postgres:16.4')
  const [st, setSt] = useState<PullState>(() => (presetName === 'running' ? 'pulling' : presetName === 'done' ? 'done' : presetName === 'canceled' ? 'canceled' : presetName === 'error' ? 'error' : 'idle'))
  const [layers, setLayers] = useState<Layer[]>(() =>
    presetName === 'running' ? preset([100, 100, 62, 18, 0]) : presetName === 'done' ? preset([100, 100, 100, 100, 100]) : presetName === 'canceled' ? preset([100, 100, 34, 0, 0]) : presetName === 'error' ? preset([100, 100, 12, 0, 0]) : [])
  const [error, setError] = useState<string | null>(() => (presetName === 'error' ? 'El registro respondió 429 (demasiadas peticiones). Espera unos minutos o inicia sesión en el registro.' : null))
  const stop = useRef<(() => void) | null>(null)
  const refInput = useRef<HTMLInputElement>(null)

  const start = () => {
    stop.current?.()
    const target = ref.trim() || 'postgres:16.4'
    setRef(target)
    setError(null)
    setSt('pulling')
    stop.current = api.pull.start(target, (p) => {
      setLayers(p.layers)
      if (p.state === 'done') {
        setSt('done')
        if (browserWorld) toast.ok(`${safeText(target, { singleLine: true })} descargada`)
        else toast.warn('Simulado — no conectado aún', { sub: `No se descargó «${safeText(target, { singleLine: true })}»: la descarga todavía no está conectada al motor.` })
      } else if (p.state === 'error') {
        setSt('error')
        setError(p.error ?? 'La descarga falló.')
      }
    })
  }
  const cancel = () => {
    stop.current?.()
    stop.current = null
    setSt('canceled')
  }
  useEffect(() => {
    // ?pull=running reproduce el estado CONGELADO de la plantilla (sin iniciar ninguna descarga simulada).
    return () => stop.current?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const head = <PageHeader title="Descargar imagen" back={{ href: route.href('images'), label: 'Imágenes' }} simulated />
  if (gate.blocked) return <>{head}{gate.blocked}</>

  const pulling = st === 'pulling'
  const done = layers.reduce((a, l) => a + l.done, 0)
  const all = layers.reduce((a, l) => a + l.total, 0)
  return (
    <>
      {head}
      <div className="toolbar">
        <label className="field" style={{ flex: '1 1 320px', maxWidth: 520 }}>
          <Icon name="download" />
          <input ref={refInput} className="input" id="pullRef" value={ref} aria-label="Imagen a descargar" placeholder="registro/nombre:etiqueta" disabled={pulling}
            onChange={(e) => setRef(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !pulling && !gate.locked) start() }} />
        </label>
        {pulling ? (
          <Button variant="secondary" locked={gate.locked} onClick={cancel}><Icon name="x" />Cancelar descarga</Button>
        ) : (
          <Button variant="primary" locked={gate.locked} onClick={start}><Icon name="download" />{st === 'idle' ? 'Descargar' : 'Descargar de nuevo'}</Button>
        )}
      </div>
      <div className="view-body">
        {gate.lostBanner}
        {st === 'canceled' ? <AlertBox kind="info" icon="info" title="Descarga cancelada" text="Las capas ya descargadas se conservan en caché: si vuelves a descargar, se reanuda desde ahí." /> : null}
        {st === 'error' ? (
          <AlertBox kind="error" icon="alert" title={`No se pudo descargar ${safeText(ref, { singleLine: true })}`} text={safeText(error)} actions={<Button variant="secondary" size="sm" locked={gate.locked} onClick={start}><Icon name="refresh" size="sm" />Reintentar</Button>} />
        ) : null}
        {st === 'done' ? (
          <AlertBox
            kind="info"
            icon="check"
            title={browserWorld ? `${safeText(ref, { singleLine: true })} descargada` : `Descarga simulada de ${safeText(ref, { singleLine: true })}`}
            text={browserWorld ? 'Ya puedes crear un contenedor con esta imagen.' : 'No se descargó ninguna imagen real: esta pantalla todavía no está conectada al motor de Docker.'}
            actions={<LinkButton variant="primary" size="sm" href={route.href('create', { image: ref })}><Icon name="play" size="sm" fill />Ejecutar</LinkButton>}
          />
        ) : null}
        {st === 'idle' ? (
          <EmptyState icon="download" title="Elige qué imagen descargar" text="Escribe el nombre con su etiqueta. Verás el avance de cada capa y podrás cancelar en cualquier momento." />
        ) : (
          <section className="card" aria-label="Progreso por capa">
            <header style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <b className="mono">{safeText(ref, { singleLine: true })}</b>
              <span className="muted" style={{ marginLeft: 'auto' }} id="pullTotal" aria-live="off">{done.toFixed(1)} de {all.toFixed(1)} MB</span>
            </header>
            <div id="layers"><LayerProgress layers={layers} pulling={pulling} /></div>
          </section>
        )}
      </div>
    </>
  )
}
