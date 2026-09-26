// Vista «Construir imagen» (#build?context=&tag=). Flujo: formulario → `build_plan` (valida el contexto; un contexto sensible pide confirmación
// con ticket) → `subscribe_build` con progreso «Paso n/m» y las líneas CRUDAS de la construcción (el parser de pasos es de mejor esfuerzo) → cancelar.
// Los VALORES de los ARG no se muestran ni se registran en ningún sitio; los nombres con aspecto de secreto avisan (mejor `--secret`).
// Salir de la vista cancela la construcción en curso (el canal muere con ella).
import { safeText } from '@/lib/safeText'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useHashRoute } from '@/app/useHashRoute'
import { useConfirm } from '@/components/shared/ConfirmDialog'
import { Icon } from '@/components/shared/Icon'
import { LogViewer } from '@/components/shared/LogViewer'
import { PageHeader } from '@/components/shared/PageHeader'
import { AlertBox } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { apiErrorMessage } from '@/data/errors'
import { useCapability, useConnection, useEngineApi, useEngineStoreApi } from '@/data/store/hooks'
import type { BuildPlan, BuildRun, BuildSpec, BuildWarning, LogLine } from '@/data/types'
import { isReservedArgName } from '@/lib/buildArgs'
import { validateImageRef } from '@/lib/imageRef'
import { toast } from '@/lib/toastStore'
import { uuidv7 } from '@/lib/uuid7'
import { useViewGate } from '../common/gate'
import { useUnsavedGuard } from '../stacks/useUnsavedGuard'
import { LinkButton } from '../common/LinkButton'
import { warningText } from './buildWarnings'

const MAX_LINES = 10_000
const SECRET_ARG = /PASSWORD|TOKEN|SECRET|KEY/i
interface ArgRow { id: string; key: string; value: string }
type Errors = Partial<Record<'context' | 'dockerfile' | 'tag' | 'args', string>>

export default function BuildPage() {
  const route = useHashRoute()
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const confirm = useConfirm()
  const gate = useViewGate(4, 6)
  const cap = useCapability('build')
  const [context, setContext] = useState(route.params.get('context') ?? '')
  const [dockerfile, setDockerfile] = useState('')
  const [tag, setTag] = useState(route.params.get('tag') ?? '')
  const [target, setTarget] = useState('')
  const [args, setArgs] = useState<ArgRow[]>([])
  const [noCache, setNoCache] = useState(false)
  const [pull, setPull] = useState(false)
  const [errors, setErrors] = useState<Errors>({})
  const [planning, setPlanning] = useState(false)
  const [warnings, setWarnings] = useState<BuildWarning[]>([])
  const [run, setRun] = useState<BuildRun | null>(null)
  const [announce, setAnnounce] = useState('')
  const stop = useRef<(() => void) | null>(null)
  const buf = useRef<LogLine[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstField = useRef<HTMLInputElement>(null)
  // F2: el foco al primer campo inválido se da DESPUÉS del render (aún no existe aria-invalid al llamar a setErrors).
  const [focusTick, setFocusTick] = useState(0)
  useEffect(() => { if (focusTick > 0) document.querySelector<HTMLElement>('form [aria-invalid="true"]')?.focus() }, [focusTick])
  const running = run?.state === 'running'
  const conn = useConnection()
  const remoteName = conn.profile.remote ? safeText(conn.profile.name, { singleLine: true }) : null
  // M-5: salir de la vista cancela la construcción: se avisa antes (navegación por hash y cierre de ventana).
  useUnsavedGuard(running, { title: 'Hay una construcción en curso', description: 'Si sales ahora, la construcción se cancelará y se perderá su progreso.', okLabel: 'Cancelar y salir', cancelLabel: 'Seguir construyendo', note: 'Puedes quedarte en esta página hasta que termine.' })

  // Al salir de la vista se cancela la construcción (el canal del backend muere con ella).
  useEffect(() => () => { stop.current?.(); if (timer.current) clearTimeout(timer.current) }, [])

  const flush = () => {
    timer.current = null
    const add = buf.current
    buf.current = []
    if (!add.length) return
    setRun((r) => (r ? { ...r, lines: [...r.lines, ...add.map((l) => ({ text: l.message, stream: l.stream === 'stderr' ? 'stderr' as const : 'stdout' as const }))].slice(-MAX_LINES) } : r))
  }
  const pushLine = (text: string, stream: 'stdout' | 'stderr') => {
    buf.current.push({ stream, timestamp: null, message: text, truncated: false })
    if (!timer.current) timer.current = setTimeout(flush, 100) // lotes: una construcción ruidosa no repinta por línea
  }

  const logLines = useMemo<LogLine[]>(() => (run?.lines ?? []).map((l) => ({ stream: l.stream, timestamp: null, message: l.text, truncated: false })), [run?.lines])

  const buildSpec = (): { spec: BuildSpec; errors: null } | { spec: null; errors: Errors } => {
    const e: Errors = {}
    if (!context.trim().startsWith('/')) e.context = 'Indica la ruta ABSOLUTA del directorio de contexto.'
    const df = dockerfile.trim()
    if (df && (df.startsWith('/') || df.split('/').includes('..'))) e.dockerfile = 'Ruta relativa dentro del contexto, sin «..».'
    if (tag.trim()) { const bad = validateImageRef(tag.trim()); if (bad) e.tag = bad }
    const named = args.filter((a) => a.key.trim() || a.value)
    if (named.some((a) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.key.trim()))) e.args = 'Cada argumento necesita un nombre válido (letras, números y _).'
    else if (named.some((a) => isReservedArgName(a.key.trim()))) e.args = 'Ese nombre está reservado (PATH, HOME, DOCKER_*, LD_*, XDG_*, SSH_*, LC_*, *_PROXY): usa otro.'
    else if (named.some((a) => /[\r\n]/.test(a.value))) e.args = 'El valor de un argumento no puede tener saltos de línea.'
    if (Object.keys(e).length) return { spec: null, errors: e }
    return { spec: { context_dir: context.trim(), dockerfile: df || null, tag: tag.trim() || null, build_args: named.map((a): [string, string] => [a.key.trim(), a.value]), target: target.trim() || null, no_cache: noCache, pull }, errors: null }
  }

  const start = (spec: BuildSpec, ticket: string | null) => {
    buf.current = []
    setRun({ state: 'running', step: null, lines: [], imageId: null, error: null })
    setAnnounce('Construyendo la imagen…')
    stop.current = api.images.build(spec, ticket, (f) => {
      if (f.type === 'line') pushLine(f.text, f.stream ?? 'stdout')
      else if (f.type === 'lines') for (const l of f.lines) pushLine(l.text, l.stream ?? 'stdout')
      else if (f.type === 'step') setRun((r) => (r ? { ...r, step: { n: f.n, total: f.total } } : r))
      else {
        if (timer.current) { clearTimeout(timer.current); flush() }
        stop.current = null
        setRun((r) => (r ? { ...r, state: f.outcome === 'ok' ? 'done' : f.outcome === 'canceled' ? 'canceled' : 'error', imageId: f.image_id, error: f.error } : r))
        setAnnounce(f.outcome === 'ok' ? 'Imagen construida' : f.outcome === 'canceled' ? 'Construcción cancelada' : 'La construcción falló')
        if (f.outcome === 'ok') { void store.getState().refresh('images'); toast.ok('Imagen construida', { sub: spec.tag ? safeText(spec.tag, { singleLine: true }) : undefined }) }
      }
    })
  }

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    if (running || planning) return
    const b = buildSpec()
    setErrors(b.errors ?? {})
    if (!b.spec) { setFocusTick((n) => n + 1); return }
    setPlanning(true)
    let plan: BuildPlan
    try { plan = await api.images.planBuild(b.spec) } catch (ex) {
      setPlanning(false)
      const m = apiErrorMessage(ex)
      setErrors((old) => ({ ...old, context: m.detail || m.title }))
      return
    }
    setPlanning(false)
    setWarnings(plan.warnings)
    if (plan.decision.type === 'deny') { toast.err('El motor de seguridad rechazó esta construcción'); return }
    if (plan.decision.type !== 'allow' && plan.ticket) {
      const ok = await confirm({
        level: plan.decision.type === 'confirm_typed' ? 'confirm_typed' : 'confirm', typed: plan.decision.type === 'confirm_typed' ? plan.decision.expected : undefined,
        title: 'Confirmar construcción con contexto sensible',
        description: <><p>Se enviará el contexto <b className="mono">{safeText(b.spec.context_dir, { singleLine: true })}</b> {remoteName ? <>al servidor <b>{remoteName}</b></> : 'al motor'}:</p><ul>{plan.warnings.map((w, i) => <li key={i}>{warningText(w)}</li>)}</ul></>,
        levelNote: <><b>Nivel Confirmar.</b> Todo lo que haya en esa carpeta puede acabar dentro de la imagen.</>, okLabel: 'Construir igualmente', okIcon: 'layers', cancelLabel: 'Revisar',
      })
      if (!ok) return
    }
    start(b.spec, plan.ticket)
  }

  const cancel = () => {
    stop.current?.()
    stop.current = null
    if (timer.current) { clearTimeout(timer.current); flush() }
    setRun((r) => (r ? { ...r, state: 'canceled' } : r))
    setAnnounce('Construcción cancelada')
  }

  const head = <PageHeader title="Construir imagen" back={{ href: route.href('images'), label: 'Imágenes' }} simulated={cap !== 'live'} />
  if (gate.blocked) return <>{head}{gate.blocked}</>
  const locked = gate.locked || running || planning
  const err = (k: keyof Errors, id: string) => (errors[k] ? <span className="f-error" id={id}><Icon name="alert" size="sm" />{errors[k]}</span> : null)
  const inv = (k: keyof Errors, id: string) => ({ 'aria-invalid': errors[k] ? true : undefined, 'aria-describedby': errors[k] ? id : undefined }) as const
  const secretArgs = args.filter((a) => SECRET_ARG.test(a.key))
  const pct = run?.step ? (run.step.n / Math.max(1, run.step.total)) * 100 : 0

  return (
    <>
      {head}
      <div className="view-body">
        {gate.lostBanner}
        <form className="form" noValidate onSubmit={(e) => void submit(e)}>
          <section className="card form-section">
            <h2>Origen</h2>
            <div className="form-body">
              <div className="f-row">
                <label htmlFor="bCtx">Directorio de contexto</label>
                <Input ref={firstField} className="mono" id="bCtx" value={context} placeholder="/home/tu-usuario/proyectos/mi-app" disabled={running} {...inv('context', 'eCtx')} onChange={(e) => setContext(e.target.value)} />
                {err('context', 'eCtx')}
                <span className="f-hint">Ruta absoluta en ESTE equipo: <code>docker build</code> corre aquí y sube el contenido de la carpeta al motor{remoteName ? <> de <b>{remoteName}</b></> : ''}.</span>
                {remoteName ? <span className="f-hint" role="note" style={{ color: 'var(--status-paused)' }}><Icon name="server" size="sm" /> El contenido de esta carpeta se enviará al servidor <b>{remoteName}</b>.</span> : null}
              </div>
              <div className="f-cols">
                <div className="f-row"><label htmlFor="bDf">Dockerfile <span className="muted">(opcional)</span></label><Input className="mono" id="bDf" value={dockerfile} placeholder="Dockerfile" disabled={running} {...inv('dockerfile', 'eDf')} onChange={(e) => setDockerfile(e.target.value)} />{err('dockerfile', 'eDf')}</div>
                <div className="f-row"><label htmlFor="bTag">Etiqueta de la imagen <span className="muted">(opcional)</span></label><Input className="mono" id="bTag" value={tag} placeholder="mi-app:1.0" disabled={running} {...inv('tag', 'eTag')} onChange={(e) => setTag(e.target.value)} />{err('tag', 'eTag')}</div>
                <div className="f-row"><label htmlFor="bTarget">Etapa (target) <span className="muted">(opcional)</span></label><Input className="mono" id="bTarget" value={target} disabled={running} onChange={(e) => setTarget(e.target.value)} /></div>
              </div>
            </div>
          </section>

          <section className="card form-section">
            <h2>Opciones</h2>
            <div className="form-body">
              <label className="check-row"><Checkbox checked={noCache} disabled={running} onChange={(e) => setNoCache(e.target.checked)} /> Sin caché (reconstruye todas las capas)</label>
              <label className="check-row"><Checkbox checked={pull} disabled={running} onChange={(e) => setPull(e.target.checked)} /> Descargar siempre las imágenes base más recientes</label>
              <div className="f-row">
                <span className="f-label" id="lArgs">Argumentos de build (ARG)</span>
                {args.map((a, i) => (
                  <div className="rep two" key={a.id}>
                    <div><label className="sr-only" htmlFor={`bak${i}`}>Nombre del argumento {i + 1}</label><Input className="mono" id={`bak${i}`} value={a.key} placeholder="NOMBRE" disabled={running} onChange={(e) => setArgs((l) => l.map((x) => (x.id === a.id ? { ...x, key: e.target.value } : x)))} /></div>
                    <div><label className="sr-only" htmlFor={`bav${i}`}>Valor del argumento {i + 1}</label><Input className="mono" id={`bav${i}`} type={SECRET_ARG.test(a.key) ? 'password' : 'text'} value={a.value} placeholder="valor" autoComplete="off" disabled={running} onChange={(e) => setArgs((l) => l.map((x) => (x.id === a.id ? { ...x, value: e.target.value } : x)))} /></div>
                    <Button type="button" variant="ghost" size="icon" aria-label={`Quitar el argumento ${i + 1}`} disabled={running} onClick={() => setArgs((l) => l.filter((x) => x.id !== a.id))}><Icon name="x" /></Button>
                  </div>
                ))}
                <div><Button type="button" variant="secondary" size="sm" disabled={running} onClick={() => setArgs((l) => [...l, { id: uuidv7(), key: '', value: '' }])}><Icon name="plus" size="sm" />Añadir argumento</Button></div>
                {err('args', 'eArgs')}
                <span className="f-hint">Los valores no se muestran ni se registran; viajan como variable de entorno del proceso de <code>docker build</code> (no en la línea de comandos). Los nombres tipo PASSWORD/TOKEN/SECRET/KEY se ocultan al escribir.</span>
              </div>
              {secretArgs.length ? <AlertBox kind="warn" icon="warn" title="Un argumento parece un secreto" text={`«${safeText(secretArgs[0].key, { singleLine: true })}» quedaría visible en el historial de la imagen. Usa secretos de build (--secret) para credenciales.`} /> : null}
            </div>
          </section>

          {warnings.length && !running ? <AlertBox kind="warn" icon="warn" title="Avisos de la construcción" text={<>{warnings.map((w, i) => <span key={i} style={{ display: 'block' }}>{warningText(w)}</span>)}</>} /> : null}

          <div className="form-actions">
            {running ? (
              <Button key="cancel-build" type="button" variant="secondary" onClick={(e) => { e.preventDefault(); cancel() }}><Icon name="x" />Cancelar construcción</Button>
            ) : (
              <Button key="start-build" type="submit" variant="primary" locked={locked}><Icon name={planning ? 'loader' : 'layers'} spin={planning} />{run ? 'Construir de nuevo' : 'Construir'}</Button>
            )}
            <LinkButton variant="ghost" href={route.href('images')}>Volver a Imágenes</LinkButton>
          </div>
        </form>

        <div className="sr-only" role="status" aria-live="polite">{announce}</div>
        {run ? (
          <section className="card" aria-label="Progreso de la construcción">
            <header style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <b>{running ? 'Construyendo…' : run.state === 'done' ? 'Construcción terminada' : run.state === 'canceled' ? 'Construcción cancelada' : 'La construcción falló'}</b>
              <span className="muted" style={{ marginLeft: 'auto' }}>{run.step ? `Paso ${run.step.n} de ${run.step.total}` : running ? 'Enviando el contexto…' : ''}</span>
            </header>
            <div style={{ padding: '8px 16px' }}>
              <Progress value={run.state === 'done' ? 100 : pct} label="Progreso de pasos" indeterminate={running && !run.step} />
            </div>
            {run.state === 'error' ? <div style={{ padding: '0 16px 8px' }}><AlertBox kind="error" icon="alert" title="No se pudo construir la imagen" text={safeText(run.error?.message ?? 'Error desconocido')} /></div> : null}
            {run.state === 'done' ? <div style={{ padding: '0 16px 8px' }}><AlertBox kind="info" icon="check" title="Imagen construida" text={`${run.imageId ? `ID ${safeText(run.imageId.replace('sha256:', '').slice(0, 12))}. ` : ''}${tag.trim() ? `Etiqueta ${safeText(tag.trim(), { singleLine: true })}.` : 'Sin etiqueta (aparecerá como imagen colgada).'}`} actions={<LinkButton variant="primary" size="sm" href={route.href('images')}><Icon name="layers" size="sm" />Ver imágenes</LinkButton>} /></div> : null}
            <div style={{ padding: '0 16px 16px' }}><LogViewer lines={logLines} follow={running} label="Salida de la construcción" /></div>
          </section>
        ) : null}
      </div>
    </>
  )
}
