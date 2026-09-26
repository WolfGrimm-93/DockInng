// Editor de stack (#stack-edit?stack=<nombre>): compose.yaml + .env con CodeMirror (perezoso), validación en vivo con `docker compose config`,
// guardar/descartar/cambios sin guardar/«Guardar y levantar» y progreso de up en vivo. Datos REALES (stack_read/save/validate, run_stack_op).
// Los stacks descubiertos solo por etiquetas no se editan (se ofrece vincular su archivo). Parámetros dev: ?yaml=broken ?run=up ?file=env.
import { safeText } from '@/lib/safeText'
import { useCallback, useEffect, useRef, useState } from 'react'
import { devFlagsEnabled, setComposeMissing, useComposeMissing } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { asSim } from '@/data/createEngineApi'
import { CodeEditor, type CodeEditorHandle } from '@/components/shared/code-editor/CodeEditor'
import { useConfirm } from '@/components/shared/ConfirmDialog'
import { Icon } from '@/components/shared/Icon'
import { PageHeader } from '@/components/shared/PageHeader'
import { Segmented } from '@/components/shared/Segmented'
import { AlertBox, ComposeMissing, EmptyState } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { apiErrorMessage, toApiError } from '@/data/errors'
import { useCapability, useEngineApi, useEngineStore, useEngineStoreApi, useStackOp } from '@/data/store/hooks'
import type { ApiError, StackFiles, StackRisk } from '@/data/types'
import type { Diag } from '@/lib/composeDiag'
import { toast } from '@/lib/toastStore'
import { useViewGate } from '../common/gate'
import { LinkButton } from '../common/LinkButton'
import { StackOpPanel } from './StackOpPanel'
import { useStacks } from './useStacks'
import { useStackValidation } from './useStackValidation'
import { useUnsavedGuard } from './useUnsavedGuard'

type FileId = 'yaml' | 'env'
const FILE_LABEL: Record<FileId, string> = { yaml: 'compose.yaml', env: '.env' }

const RISK_TEXT: Record<StackRisk['type'], string> = {
  privileged: 'usa contenedores privilegiados (privileged)', host_network: 'usa la red del equipo (network_mode: host)', docker_sock: 'monta docker.sock (control total de Docker)',
  sensitive_bind: 'monta rutas sensibles del equipo', pid_host: 'comparte los procesos del equipo (pid: host)', cap_add_sys_admin: 'añade la capacidad SYS_ADMIN',
}

export default function StackEditPage() {
  const route = useHashRoute()
  const api = useEngineApi()
  const dev = devFlagsEnabled(api)
  const name = route.params.get('stack')
  if (!name) {
    return (
      <>
        <PageHeader title="Editar stack" back={{ href: route.href('stacks'), label: 'Stacks' }} />
        <div className="view-body"><EmptyState icon="grid" title="Elige un stack para editar" text="Abre un stack de la lista, crea uno nuevo o vincula un archivo Compose existente." actions={<LinkButton variant="primary" href={route.href('stacks')}><Icon name="grid" />Ir a Stacks</LinkButton>} /></div>
      </>
    )
  }
  return <Editor key={name} name={name} broken={dev && route.params.get('yaml') === 'broken'} run={dev && route.params.get('run') === 'up'} startFile={dev && route.params.get('file') === 'env' ? 'env' : 'yaml'} />
}

function Editor({ name, broken, run, startFile }: { name: string; broken: boolean; run: boolean; startFile: FileId }) {
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const route = useHashRoute()
  const gate = useViewGate(4, 6)
  const confirm = useConfirm()
  const cap = useCapability('stacks')
  const composeFlag = useComposeMissing()
  const { available, recheck } = useStacks()
  const op = useStackOp(name)
  const connected = useEngineStore((s) => s.connection.status === 'connected')

  const [files, setFiles] = useState<StackFiles | null>(null)
  const [loadError, setLoadError] = useState<ApiError | null>(null)
  const [text, setText] = useState({ yaml: '', env: '' })
  const [saved, setSaved] = useState({ yaml: '', env: '' })
  const revision = useRef<string | null>(null)
  const [file, setFile] = useState<FileId>(startFile)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const editor = useRef<CodeEditorHandle>(null)
  const missing = composeFlag || available === false
  const loaded = files !== null
  const readOnly = !files?.editable || !connected

  const dirty = { yaml: text.yaml !== saved.yaml, env: text.env !== saved.env }
  const anyDirty = dirty.yaml || dirty.env
  const saveRef = useRef<() => Promise<boolean>>(async () => false)
  useUnsavedGuard(anyDirty, { onSave: () => saveRef.current() })
  const val = useStackValidation({ name, yaml: text.yaml, env: text.env, enabled: loaded && !!files?.editable && !missing && !loadError, disabledReason: loaded && !files?.editable ? 'el stack es de solo lectura' : undefined })

  const readFiles = useCallback(async (): Promise<StackFiles> => {
    const f = await api.stacks.read(name)
    if (broken) { const b = asSim(api)?.stacks.brokenYaml; if (b) return { ...f, yaml: b } }
    return f
  }, [api, name, broken])
  const applyFiles = useCallback((f: StackFiles) => {
    setFiles(f)
    revision.current = f.revision
    setText({ yaml: f.yaml, env: f.env })
    setSaved({ yaml: f.yaml, env: f.env })
    setConflict(false)
    setLoadError(null)
  }, [])
  // Reintentar / recargar desde disco (desde un evento).
  const load = useCallback(() => readFiles().then(applyFiles, (e) => setLoadError(toApiError(e))), [readFiles, applyFiles])
  useEffect(() => {
    let stale = false
    readFiles().then((f) => { if (!stale) applyFiles(f) }, (e) => { if (!stale) setLoadError(toApiError(e)) })
    return () => { stale = true }
  }, [readFiles, applyFiles])

  const save = useCallback(async (overwrite = false): Promise<boolean> => {
    if (!files?.editable || saving) return false
    setSaving(true)
    try {
      const f = await api.stacks.save(name, { yaml: text.yaml, env: text.env, expectedRevision: overwrite ? null : revision.current })
      revision.current = f.revision
      setFiles(f)
      const wrote = [dirty.yaml ? 'compose.yaml' : null, dirty.env ? '.env' : null].filter(Boolean).join(' y ')
      setSaved({ yaml: text.yaml, env: text.env })
      setConflict(false)
      toast.ok(`${wrote || 'Stack'} guardado`, val.hasErrors ? { sub: 'Se guardó con errores de validación.' } : undefined)
      void store.getState().refresh('stacks')
      return true
    } catch (e) {
      const err = toApiError(e)
      if (err.code === 'state_changed') setConflict(true)
      else { const m = apiErrorMessage(err); toast.err('No se pudo guardar', { sub: m.detail || m.title }) }
      return false
    } finally { setSaving(false) }
  }, [api, name, files, saving, text, dirty.yaml, dirty.env, val.hasErrors, store])

  useEffect(() => { saveRef.current = () => save() })
  const up = async () => {
    if (anyDirty && !(await save())) return
    store.getState().runStackOp(name, 'up')
  }
  useEffect(() => { if (loaded && run) store.getState().runStackOp(name, 'up') }, [loaded, run, name, store])

  const discard = async () => {
    const ok = await confirm({ level: 'confirm', title: 'Descartar cambios', description: 'Se perderán los cambios sin guardar de compose.yaml y .env.', okLabel: 'Descartar cambios', okIcon: 'x', cancelLabel: 'Seguir editando' })
    if (ok) setText(saved)
  }
  const reloadFromDisk = async () => {
    const ok = !anyDirty || await confirm({ level: 'confirm', title: 'Recargar desde el disco', description: 'Se perderán tus cambios sin guardar y se cargará la versión que hay en el disco.', okLabel: 'Recargar', okIcon: 'refresh', cancelLabel: 'Seguir editando' })
    if (ok) await load()
  }
  const overwrite = async () => {
    const ok = await confirm({ level: 'confirm', title: 'Sobrescribir el archivo', description: 'El archivo cambió en el disco desde que lo abriste. Si continúas, se pierden esos cambios externos.', okLabel: 'Sobrescribir', okIcon: 'check', cancelLabel: 'Cancelar' })
    if (ok) await save(true)
  }
  const jump = (d: Diag) => {
    if (d.line === null) return
    if (file !== 'yaml') setFile('yaml')
    setTimeout(() => editor.current?.focusLine(d.line as number, d.column), file === 'yaml' ? 0 : 50)
  }
  const onRecheck = () => {
    setComposeMissing(false)
    void recheck().then((a) => {
      if (a) toast.ok('Docker Compose disponible')
      else { setComposeMissing(true); toast.err('Docker Compose sigue sin encontrarse', { sub: 'docker compose version no devolvió nada.' }) }
    })
  }

  const running = op?.state === 'running'
  const upWhy = loaded && !files?.editable ? 'Levantar no está disponible: el stack fue descubierto por sus etiquetas; vincula su archivo Compose para gestionarlo desde aquí.' : missing ? 'Levantar no está disponible: requiere Docker Compose.' : val.hasErrors ? 'Levantar no está disponible: corrige los errores de validación.' : null
  const head = (
    <PageHeader
      title={`Editar stack ${safeText(name, { singleLine: true })}`}
      back={{ href: route.href('stacks'), label: 'Stacks' }}
      simulated={cap !== 'live'}
      secondary={
        <>
          {anyDirty ? <Button variant="ghost" locked={gate.locked} disabled={saving} onClick={() => void discard()}><Icon name="x" />Descartar cambios</Button> : null}
          <Button variant="secondary" locked={gate.locked} disabled={!loaded || !files?.editable || !anyDirty || saving} onClick={() => void save()}><Icon name={saving ? 'loader' : 'check'} spin={saving} />Guardar</Button>
        </>
      }
      primary={
        <Button variant="primary" id="upBtn" locked={gate.locked || !loaded || !!loadError || !files?.editable || missing || val.hasErrors || running || saving} aria-describedby={upWhy ? 'upWhy' : undefined} onClick={() => void up()}>
          <Icon name={running ? 'loader' : 'play'} fill={!running} spin={running} />{anyDirty ? 'Guardar y levantar' : 'Levantar'}
        </Button>
      }
    />
  )
  if (gate.blocked) return <>{head}{gate.blocked}</>
  if (loadError) {
    const denied = loadError.code === 'policy_denied'
    return (
      <>
        {head}
        <div className="view-body">
          {gate.lostBanner}
          {denied ? (
            <AlertBox kind="info" icon="info" title="Este stack no se puede editar todavía" text={<>{safeText(loadError.message)} Vuelve a Stacks y usa «Vincular…» para asociar su archivo Compose.</>} actions={<LinkButton variant="primary" size="sm" href={route.href('stacks')}><Icon name="grid" size="sm" />Ir a Stacks</LinkButton>} />
          ) : (
            <AlertBox kind="error" icon="alert" title="No se pudo leer el stack" text={apiErrorMessage(loadError).detail || apiErrorMessage(loadError).title} actions={<Button variant="secondary" size="sm" onClick={() => void load()}><Icon name="refresh" size="sm" />Reintentar</Button>} />
          )}
        </div>
      </>
    )
  }

  const dot = (d: boolean) => (d ? <><span aria-hidden="true"> ●</span><span className="unsaved"> sin guardar</span></> : null)
  const fileDiags = file === 'yaml' ? val.diags.filter((d) => d.line !== null).map((d) => ({ line: d.line as number, column: d.column, level: d.level, message: d.message })) : []
  return (
    <>
      {head}
      <div className="view-body">
        {gate.lostBanner}
        {upWhy ? <p className="f-hint" id="upWhy" role="status">{upWhy}</p> : null}
        {missing ? <ComposeMissing compact onRecheck={onRecheck} /> : null}
        {conflict ? (
          <AlertBox kind="warn" icon="warn" title="El archivo cambió en el disco" text="Otra herramienta modificó el archivo mientras lo editabas. Elige si quieres cargar esa versión o sobrescribirla con la tuya."
            actions={<><Button variant="secondary" size="sm" onClick={() => void reloadFromDisk()}><Icon name="refresh" size="sm" />Recargar desde disco</Button><Button variant="outline-destructive" size="sm" onClick={() => void overwrite()}>Sobrescribir</Button></>} />
        ) : null}
        {loaded && !files.editable ? <AlertBox kind="info" icon="lock" title="Solo lectura" text="Solo lectura: fue descubierto por sus etiquetas de Compose; vincula su archivo para editarlo." actions={<LinkButton variant="secondary" size="sm" href={route.href('stacks')}><Icon name="file" size="sm" />Ir a Stacks para vincularlo</LinkButton>} /> : null}
        {val.risks.length ? (
          <AlertBox kind="warn" icon="warn" title="Este stack tiene configuración de riesgo" text={`El archivo ${val.risks.map((r) => (r.type === 'sensitive_bind' && r.path ? `monta ${safeText(r.path, { singleLine: true })}` : RISK_TEXT[r.type])).join('; ')}. Revísalo antes de levantarlo.`} />
        ) : null}
        <div className="toolbar" style={{ paddingBottom: 0 }}>
          <Segmented<FileId> ariaLabel="Archivo" value={file} onChange={setFile} options={[{ value: 'yaml', label: <>compose.yaml{dot(dirty.yaml)}</> }, { value: 'env', label: <>.env{dot(dirty.env)}</> }]} />
          <span className="muted mono" style={{ overflowWrap: 'anywhere' }}>{files ? safeText(file === 'yaml' ? files.path : files.env_path, { singleLine: true }) : ''}</span>
        </div>
        <div className="editor">
          <div className="code-wrap is-cm">
            {loaded ? (
              <CodeEditor
                docKey={file} value={file === 'yaml' ? text.yaml : text.env} language={file === 'yaml' ? 'yaml' : 'plain'} diagnostics={fileDiags} readOnly={readOnly}
                ariaLabel={`Contenido de ${FILE_LABEL[file]}`} handleRef={editor} onSave={() => { if (anyDirty) void save() }}
                onChange={(v) => setText((t) => ({ ...t, [file]: v }))}
              />
            ) : <div className="editor-loading" role="status" aria-busy="true"><span className="skeleton" style={{ width: '60%', height: 12 }} /><span className="skeleton" style={{ width: '80%', height: 12 }} /><span className="skeleton" style={{ width: '45%', height: 12 }} /></div>}
          </div>
          <section className="card" aria-label="Validación">
            <h2 className="section-title" style={{ padding: '12px 14px 0' }}>Validación en vivo</h2>
            <div className="val-summary" role="status" aria-live="polite">
              {val.status === 'validating' ? <><Icon name="loader" size="sm" spin /> Validando con Docker Compose…</> : val.summary}
              {val.status === 'unavailable' && loaded ? <span className="muted"> · Validación completa no disponible{val.unavailableReason ? `: ${safeText(val.unavailableReason, { singleLine: true })}` : ''}. Se usan las comprobaciones básicas.</span> : null}
            </div>
            <ul className="checks" id="checks">
              {val.diags.length === 0 && val.status !== 'validating' ? <li><span className="ok"><Icon name="check" size="sm" /></span><span>Sin problemas.</span></li> : null}
              {val.diags.map((d, i) => (
                <li key={i}>
                  <span className={d.level === 'error' ? 'bad' : 'warn'}><Icon name={d.level === 'error' ? 'xcircle' : 'warn'} size="sm" /><span className="sr-only">{d.level === 'error' ? 'Error' : 'Aviso'}</span></span>
                  {d.line !== null ? (
                    <button type="button" className="diag-btn" onClick={() => jump(d)}>Línea {d.line}: {safeText(d.message, { singleLine: true })}</button>
                  ) : <span>{safeText(d.message, { singleLine: true })}</span>}
                </li>
              ))}
            </ul>
          </section>
        </div>
        {op ? (
          <section className="card" id="upcard" aria-label="Progreso de la operación del stack">
            <header style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <b>docker compose {op.kind}</b>
            </header>
            <StackOpPanel op={op} locked={gate.locked} onCancel={() => store.getState().cancelStackOp(name)} onRetry={() => void up()} onDismiss={() => store.getState().dismissStackOp(name)} />
          </section>
        ) : null}
      </div>
    </>
  )
}
