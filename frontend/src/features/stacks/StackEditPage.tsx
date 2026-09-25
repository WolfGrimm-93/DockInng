// Editor de stack (#stack-edit?stack=<nombre>): compose.yaml + .env con validación en vivo (lib/yamlCheck).
// SIMULADO: leer/guardar/levantar aún no están conectados al motor (marca «No conectado aún» en la cabecera).
import { safeText } from '@/lib/safeText'
import { Fragment, useEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { devFlagsEnabled, useComposeMissing, setComposeMissing } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { Icon } from '@/components/shared/Icon'
import { ServiceProgress } from '@/components/shared/LayerProgress'
import { PageHeader } from '@/components/shared/PageHeader'
import { Segmented } from '@/components/shared/Segmented'
import { AlertBox, ComposeMissing } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { apiErrorMessage } from '@/data/errors'
import { useEngineApi, useIsSimulatedWorld } from '@/data/store/hooks'
import type { UpProgress } from '@/data/types'
import { toast } from '@/lib/toastStore'
import { validateCompose } from '@/lib/yamlCheck'
import { useViewGate } from '../common/gate'

type FileId = 'yaml' | 'env'

export default function StackEditPage() {
  const route = useHashRoute()
  const api = useEngineApi()
  const dev = devFlagsEnabled(api)
  const name = route.params.get('stack') ?? 'tienda-nuevo'
  return <Editor key={name} name={name} broken={dev && route.params.get('yaml') === 'broken'} run={dev ? (route.params.get('run') as 'up' | 'done' | null) : null} startFile={dev && route.params.get('file') === 'env' ? 'env' : 'yaml'} />
}

function Editor({ name, broken, run, startFile }: { name: string; broken: boolean; run: 'up' | 'done' | null; startFile: FileId }) {
  const api = useEngineApi()
  const route = useHashRoute()
  const gate = useViewGate(4, 6)
  const browserWorld = useIsSimulatedWorld()
  const composeFlag = useComposeMissing()
  const [yaml, setYaml] = useState('')
  const [env, setEnv] = useState('')
  const [dir, setDir] = useState(`~/proyectos/${name}/`)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [file, setFile] = useState<FileId>(startFile)
  const [up, setUp] = useState<UpProgress | null>(null)
  const [composeOk, setComposeOk] = useState(true)
  const stopUp = useRef<(() => void) | null>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const missing = composeFlag || !composeOk

  useEffect(() => {
    let alive = true
    Promise.all([api.stacks.read(broken ? 'broken' : name), api.stacks.composeAvailable()]).then(
      ([r, a]) => { if (alive) { setYaml(r.yaml); setEnv(r.env); setDir(broken ? `~/proyectos/${name}/` : r.path); setComposeOk(a); setLoaded(true) } },
      (e) => { if (alive) setLoadError(apiErrorMessage(e).detail) },
    )
    return () => { alive = false }
  }, [api, name, broken])

  const startUp = () => {
    stopUp.current?.()
    stopUp.current = api.stacks.up(name, (p) => {
      setUp(p)
      if (p.state === 'done') {
        if (browserWorld) toast.ok('Stack levantado', { sub: `${p.services.length} servicios en ejecución` })
        else toast.warn('Simulado — no conectado aún', { sub: 'No se levantó ningún servicio real.' })
      }
    })
  }
  useEffect(() => {
    if (!loaded || !run) return
    if (run === 'done') setUp({ state: 'done', services: ['postgres', 'redis', 'api', 'web'].map((s) => ({ name: s, percent: 100, phase: 'started' as const })) })
    else startUp()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, run])
  useEffect(() => () => stopUp.current?.(), [])

  const check = useMemo(() => validateCompose(yaml, env), [yaml, env])
  const shown = file === 'yaml' ? { n: check.n, bad: check.bad } : { n: env.split('\n').length, bad: {} as Record<number, 1> }
  const upRunning = up?.state === 'running'

  const save = async () => {
    await api.stacks.save(name, { yaml, env })
    if (browserWorld) toast.ok(file === 'yaml' ? 'compose.yaml guardado' : '.env guardado')
    else toast.warn('Simulado — no conectado aún', { sub: 'No se escribió ningún archivo en el disco.' })
  }
  const onScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-e.currentTarget.scrollTop}px)`
  }

  const head = (
    <PageHeader
      title={`Editar stack ${safeText(name, { singleLine: true })}`}
      back={{ href: route.href('stacks'), label: 'Stacks' }}
      simulated
      secondary={<Button variant="secondary" locked={gate.locked} disabled={!loaded} onClick={() => void save()}><Icon name="check" />Guardar</Button>}
      primary={<Button variant="primary" id="upBtn" locked={gate.locked} disabled={!loaded || check.hasBad || upRunning} onClick={startUp}><Icon name="play" fill />Levantar</Button>}
    />
  )
  if (gate.blocked) return <>{head}{gate.blocked}</>
  if (missing) {
    return <>{head}<div className="view-body">{gate.lostBanner}<ComposeMissing onRecheck={() => {
      setComposeMissing(false)
      void api.stacks.composeAvailable().then((a) => {
        setComposeOk(a)
        if (a) toast.ok('Docker Compose disponible')
        else { setComposeMissing(true); toast.err('Docker Compose sigue sin encontrarse', { sub: 'docker compose version no devolvió nada.' }) }
      })
    }} /></div></>
  }
  if (loadError) return <>{head}<div className="view-body"><AlertBox kind="error" icon="alert" title="No se pudo leer el stack" text={loadError} /></div></>

  const text = file === 'yaml' ? yaml : env
  return (
    <>
      {head}
      <div className="view-body">
        {gate.lostBanner}
        <div className="toolbar" style={{ paddingBottom: 0 }}>
          <Segmented<FileId> ariaLabel="Archivo" value={file} onChange={setFile} options={[{ value: 'yaml', label: 'compose.yaml' }, { value: 'env', label: '.env' }]} />
          <span className="muted">{safeText(dir, { singleLine: true })}</span>
        </div>
        <div className="editor">
          <div className="code-wrap">
            <div className="gutter" id="gutter" aria-hidden="true" ref={gutterRef}>
              {Array.from({ length: shown.n }, (_, i) => (
                <Fragment key={i}>{shown.bad[i + 1] ? <span className="bad">{i + 1}</span> : i + 1}{i < shown.n - 1 ? '\n' : ''}</Fragment>
              ))}
            </div>
            <label className="sr-only" htmlFor="editor">Contenido de {file === 'yaml' ? 'compose.yaml' : '.env'}</label>
            <Textarea id="editor" spellCheck={false} wrap="off" rows={18} style={{ tabSize: 8 }} value={text} disabled={!loaded} onScroll={onScroll} onChange={(e) => (file === 'yaml' ? setYaml(e.target.value) : setEnv(e.target.value))} />
          </div>
          <section className="card" aria-label="Validación">
            <h2 className="section-title" style={{ padding: '12px 14px 0' }}>Validación en vivo</h2>
            <ul className="checks" id="checks" aria-live="polite">
              {check.list.map((o, i) => (
                <li key={i}>
                  <span className={o.l}><Icon name={o.l === 'ok' ? 'check' : o.l === 'warn' ? 'warn' : 'xcircle'} size="sm" /></span>
                  <span>{o.msg}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
        {up ? (
          <section className="card" id="upcard" aria-label="Progreso de levantar el stack">
            <header style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <b>docker compose up</b>
              <span className="muted" id="upState" style={{ marginLeft: 'auto' }}>{up.state === 'done' ? 'Stack levantado' : 'Levantando…'}</span>
            </header>
            <div id="upbox"><ServiceProgress services={up.services} /></div>
          </section>
        ) : null}
      </div>
    </>
  )
}
