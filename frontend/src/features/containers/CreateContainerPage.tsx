// Vista «Nuevo contenedor» (#create?image=&remote=1). Creación REAL: validación por campo (cliente y plan del backend), avisos de rutas
// sensibles (confirmación con ticket cuando el backend la exige), elección de grupo propio, y si la imagen no está en el equipo se
// descarga primero (pull inline con progreso y cancelación) y se reintenta. Al terminar navega al detalle del contenedor.
import { safeText } from '@/lib/safeText'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { devFlagsEnabled } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { useConfirm } from '@/components/shared/confirmApi'
import { Icon } from '@/components/shared/Icon'
import { LayerProgress } from '@/components/shared/LayerProgress'
import { PageHeader } from '@/components/shared/PageHeader'
import { Segmented } from '@/components/shared/Segmented'
import { AlertBox } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { apiErrorMessage, toApiError } from '@/data/errors'
import { useCapability, useConnection, useContainers, useEngineApi, useEngineStoreApi, useImages, useIsSimulatedWorld, useNetworks, usePull } from '@/data/store/hooks'
import type { ApiError, CreatePlan, CreateWarning, Restart } from '@/data/types'
import { backendFieldToKey, imageIsLocal, toCreateSpec, validateCreateForm, type CreateForm, type EnvRow, type PortRow, type VolRow } from '@/lib/createForm'
import { hasExplicitTag, normalizeImageRef } from '@/lib/imageRef'
import { pullErrorText } from '@/lib/resourceNames'
import { sensitiveBind } from '@/lib/sensitiveBind'
import { toast } from '@/lib/toastStore'
import { uuidv7 } from '@/lib/uuid7'
import { NewGroupDialog } from '../groups/NewGroupDialog'
import { VolumesSection } from './VolumesSection'
import { useGroupsStore } from '../groups/groupsStore'
import { useStartupOnce } from '../common/devOnce'
import { useViewGate } from '../common/gate'
import { LinkButton } from '../common/LinkButton'

const RESTARTS: Restart[] = ['no', 'always', 'unless-stopped', 'on-failure']

function warningLine(w: CreateWarning): string | null {
  switch (w.type) {
    case 'sensitive_bind': return `Ruta sensible ${safeText(w.source, { singleLine: true })}: ${safeText(w.reason, { singleLine: true })}`
    case 'docker_socket': return '/var/run/docker.sock da control total de Docker al contenedor.'
    case 'host_network': return 'Usa la red del equipo (network=host): el contenedor no está aislado de la red.'
    case 'remote_bind': return `El montaje ${safeText(w.source, { singleLine: true })} se resuelve en el servidor remoto, no en tu equipo.`
    default: return null
  }
}

export default function CreateContainerPage() {
  const route = useHashRoute()
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const conn = useConnection()
  const gate = useViewGate(4, 6)
  const confirm = useConfirm()
  const cap = useCapability('create')
  const browserWorld = useIsSimulatedWorld()
  const { list: containers } = useContainers()
  const { list: images } = useImages()
  const { list: networks } = useNetworks()
  const groups = useGroupsStore((s) => s.groups)
  const moveContainers = useGroupsStore((s) => s.moveContainers)
  const formRef = useRef<HTMLFormElement>(null)
  const mounted = useRef(true)
  const [remoteBind, setRemoteBind] = useState(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const [image, setImage] = useState(() => route.params.get('image') ?? '')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [restart, setRestart] = useState<Restart>('unless-stopped')
  const [net, setNet] = useState('bridge')
  const [ports, setPorts] = useState<PortRow[]>(() => [{ id: uuidv7(), hostIp: 'local', host: '8080', container: '80', protocol: 'tcp' }])
  const [vols, setVols] = useState<VolRow[]>(() => [{ id: uuidv7(), source: '', target: '', readOnly: false }])
  const [env, setEnv] = useState<EnvRow[]>(() => [{ id: uuidv7(), key: 'POSTGRES_PASSWORD', value: '' }])
  const [groupId, setGroupId] = useState('')
  const [groupDlg, setGroupDlg] = useState(false)
  const [submitted, setSubmitted] = useState(0)
  const [touched, setTouched] = useState<Record<string, true>>({})
  const [backendErrors, setBackendErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<ApiError | null>(null)
  const [phase, setPhase] = useState<'idle' | 'pulling' | 'creating'>('idle')
  const [pullRef, setPullRef] = useState('')
  const pullCard = useRef<HTMLElement>(null)
  const pullOp = usePull(pullRef)

  // #create?remote=1 (plantilla): abre el formulario con una conexión remota activa (solo mundo simulado/DEV).
  const wantRemote = route.params.get('remote') === '1' && devFlagsEnabled(api) && browserWorld
  useStartupOnce('create.remote', wantRemote && conn.profiles.length > 0, () => {
    const r = conn.profiles.find((p) => p.remote)
    if (r && !conn.profile.remote) conn.select(r.id)
  })

  const form = useMemo<CreateForm>(() => ({ image, name, command, restart, network: net, ports, vols, env }), [image, name, command, restart, net, ports, vols, env])
  const ctx = useMemo(() => ({
    containerNames: containers.flatMap((c) => c.names),
    publishedPorts: new Map(containers.filter((c) => c.state === 'running').flatMap((c) => c.ports.filter((p) => p.public_port != null).map((p) => [p.public_port as number, c.names[0]] as const))),
    networks: networks.map((n) => n.name),
  }), [containers, networks])
  const { errors: localErrors, order } = useMemo(() => validateCreateForm(form, ctx), [form, ctx])
  const errors = { ...localErrors, ...backendErrors }
  const show = (k: string): string | undefined => (submitted > 0 || touched[k] || backendErrors[k] ? errors[k] : undefined)
  const touch = (k: string) => setTouched((t) => (t[k] ? t : { ...t, [k]: true }))
  const relRemote = conn.profile.remote ? vols.filter((v) => v.source && !v.source.startsWith('/') && /^[.~]/.test(v.source)) : []
  // Montajes con aviso de sensibilidad (sin aserciones `!`: el tipo se estrecha al construir la lista).
  const binds = vols.flatMap((v) => {
    const w = sensitiveBind(v.source, v.readOnly)
    return w ? [{ v, w }] : []
  })

  // La tarjeta de descarga queda al final del formulario: se lleva a la vista cuando empieza (el anuncio aria-live ya está dentro).
  useEffect(() => { if (phase === 'pulling') pullCard.current?.scrollIntoView?.({ block: 'center' }) }, [phase])

  // Foco al primer campo con error tras un envío fallido.
  useEffect(() => {
    if (submitted > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [submitted])

  const upd = <T extends { id: string }>(set: (f: (p: T[]) => T[]) => void, id: string, patch: Partial<T>) => { set((p) => p.map((r) => (r.id === id ? { ...r, ...patch } : r))); setBackendErrors({}) }
  const rm = <T extends { id: string }>(set: (f: (p: T[]) => T[]) => void, id: string) => set((p) => p.filter((r) => r.id !== id))

  const waitPull = (ref: string) => new Promise<'done' | 'error' | 'canceled'>((resolve) => {
    const cur = store.getState().pulls[ref]
    if (cur && cur.state !== 'pulling') return resolve(cur.state)
    const unsub = store.subscribe((s) => {
      const p = s.pulls[ref]
      if (!p) { unsub(); resolve('canceled') } else if (p.state !== 'pulling') { unsub(); resolve(p.state) }
    })
  })

  const finish = async (c: { name: string; started: boolean; warnings: string[]; start_error: ApiError | null }) => {
    for (const w of c.warnings) toast.warn(w)
    if (groupId) moveContainers(conn.profile.id, [c.name], groupId)
    await store.getState().refresh('containers')
    const n = safeText(c.name, { singleLine: true })
    if (c.start_error) toast.warn(`${n} creado, pero no se pudo iniciar`, { sub: c.start_error.message })
    else toast.ok(c.started ? `${n} creado e iniciado` : `${n} creado`)
    if (mounted.current) route.go('detail', { c: c.name })
  }

  const run = async (start: boolean) => {
    setFormError(null)
    setBackendErrors({})
    setSubmitted((n) => n + 1)
    if (order.length) { toast.warn('Revisa el formulario', { sub: 'Hay campos con errores.' }); return }
    const spec = toCreateSpec(form)
    setPhase('creating')
    try {
      // 1) Imagen: si no está en el equipo, se descarga primero (con progreso y cancelación).
      if (!imageIsLocal(images, spec.image)) {
        const ok = await pullFirst(spec.image)
        if (!ok) return
      }
      // 2) Plan (+ confirmación si hace falta) y 3) crear. Si la imagen desaparece entre medias, se descarga y se VUELVE A PLANIFICAR:
      //    el ticket anterior ya no sirve (el backend puede haberlo consumido) y la decisión puede cambiar.
      let res
      for (let attempt = 0; ; attempt++) {
        const planned = await planAndConfirm(spec, start)
        if (!planned) return
        try {
          res = await api.containers.create(planned.normalized, start, planned.ticket)
          break
        } catch (e) {
          const err = toApiError(e)
          if (err.code !== 'image_missing' || attempt >= 1) throw err
          if (!(await pullFirst(spec.image))) return
        }
      }
      await finish(res)
    } catch (e) {
      const err = toApiError(e)
      if (err.code === 'conflict' && /nombre|name|already in use|Ya existe un contenedor/i.test(err.message)) setBackendErrors({ name: err.message })
      else if (err.code === 'conflict' && /port|puerto/i.test(err.message)) setFormError({ ...err, message: `Un puerto ya está ocupado: ${err.message}` })
      else setFormError(err)
      setSubmitted((n) => n + 1)
    } finally {
      if (mounted.current) setPhase('idle')
    }
  }

  /** Plan del backend: errores por campo, avisos y confirmación (con ticket) si el motor la exige. null = detenido (errores, cancelado). */
  const planAndConfirm = async (spec: ReturnType<typeof toCreateSpec>, start: boolean): Promise<{ normalized: typeof spec; ticket: string | null } | null> => {
    const plan: CreatePlan = await api.containers.planCreate(spec)
    const rb = plan.warnings.some((w) => w.type === 'remote_bind')
    if (mounted.current) setRemoteBind(rb)
    // La página navega al crear: el aviso también sale como toast para que no se pierda.
    if (rb && plan.ok) toast.warn('Montajes en el servidor remoto', { sub: `Con «${safeText(conn.profile.name, { singleLine: true })}» activa, las rutas de origen (bind) apuntan al disco del servidor, no al de tu equipo.` })
    if (!plan.ok) {
      const be: Record<string, string> = {}
      for (const fe of plan.field_errors) be[backendFieldToKey(form, fe.field)] = fe.message
      setBackendErrors(be)
      toast.warn('Revisa el formulario', { sub: 'El motor rechazó algunos campos.' })
      setSubmitted((n) => n + 1)
      return null
    }
    if (plan.decision.type === 'allow') return { normalized: plan.normalized, ticket: null }
    if (plan.decision.type === 'deny') { toast.err('El motor de seguridad rechazó la creación'); return null }
    const lines = plan.warnings.map(warningLine).filter((l): l is string => !!l)
    const ok = await confirm({
      level: 'confirm', title: 'Confirmar contenedor con acceso sensible',
      description: <><p>Este contenedor tendrá acceso amplio al equipo:</p><ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul></>,
      levelNote: <><b>Nivel Confirmar.</b> Solo continúa si confías en la imagen.</>, okLabel: start ? 'Crear e iniciar' : 'Crear', okIcon: 'play', cancelLabel: 'Revisar',
    })
    return ok ? { normalized: plan.normalized, ticket: plan.ticket } : null
  }

  /** Descarga la imagen y espera; false si falla o se cancela (el error queda visible en la tarjeta). */
  const pullFirst = async (ref: string): Promise<boolean> => {
    setPullRef(ref)
    setPhase('pulling')
    store.getState().startPull(ref)
    const r = await waitPull(ref)
    if (!mounted.current) return false
    setPhase('creating')
    return r === 'done'
  }

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const start = ((e.nativeEvent as SubmitEvent).submitter as HTMLElement | null)?.dataset.create !== 'only'
    void run(start)
  }

  const head = <PageHeader title="Nuevo contenedor" back={{ href: route.href('containers'), label: 'Contenedores' }} simulated={cap !== 'live'} />
  if (gate.blocked) return <>{head}{gate.blocked}</>
  const busy = phase !== 'idle'
  const locked = gate.locked || busy
  const fe = (k: string) => show(k)
  const fieldMsg = (k: string, id: string) => (fe(k) ? <span className="f-error" id={id}><Icon name="alert" size="sm" />{fe(k)}</span> : null)

  return (
    <>
      {head}
      <div className="view-body">
        {gate.lostBanner}
        <form className="form" id="createForm" noValidate ref={formRef} aria-busy={busy || undefined} onSubmit={submit}>
          <section className="card form-section">
            <h2>Imagen y nombre</h2>
            <div className="form-body">
              <div className="f-cols">
                <div className="f-row">
                  <label htmlFor="fImage">Imagen</label>
                  <Input id="fImage" value={image} onChange={(e) => { setImage(e.target.value); setBackendErrors({}) }} onBlur={() => touch('image')} placeholder="postgres:16.4" list="imgs" aria-invalid={!!fe('image')} aria-describedby={fe('image') ? 'eImage' : 'hImage'} />
                  <datalist id="imgs">{images.filter((i) => !i.dangling).map((i) => <option key={i.reference} value={safeText(i.reference, { singleLine: true })} />)}</datalist>
                  {fe('image') ? fieldMsg('image', 'eImage') : (
                    <span className="f-hint" id="hImage">
                      {image.trim() && !hasExplicitTag(image) ? `Sin etiqueta: se usará :latest. ` : ''}
                      {image.trim() && !imageIsLocal(images, image) ? `«${safeText(normalizeImageRef(image), { singleLine: true })}» no está en este equipo: se descargará antes de crear el contenedor.` : 'Elige una imagen local o escribe otra: si no está en el equipo, se descarga primero.'}
                    </span>
                  )}
                </div>
                <div className="f-row">
                  <label htmlFor="fName">Nombre <span className="muted">(opcional)</span></label>
                  <Input id="fName" value={name} onChange={(e) => { setName(e.target.value); setBackendErrors({}) }} onBlur={() => touch('name')} placeholder="base-datos-pruebas" aria-invalid={!!fe('name')} aria-describedby={fe('name') ? 'eName' : 'hName'} />
                  {fe('name') ? fieldMsg('name', 'eName') : <span className="f-hint" id="hName">Letras, números, punto, guion y guion bajo. Vacío: Docker elige uno.</span>}
                </div>
              </div>
              <div className="f-row">
                <label htmlFor="fCmd">Comando <span className="muted">(opcional)</span></label>
                <Input id="fCmd" className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="sleep infinity" aria-describedby="hCmd" />
                <span className="f-hint" id="hCmd">Sustituye el comando de la imagen. No se ejecuta en una shell: no hay pipes ni variables.</span>
              </div>
            </div>
          </section>

          <section className="card form-section">
            <h2>Puertos</h2>
            <div className="form-body">
              {ports.map((p, i) => (
                <div className="rep port-row" key={p.id}>
                  <div>
                    <label className="sr-only" htmlFor={`pI${i}`}>Interfaz del puerto {i + 1}</label>
                    <Select id={`pI${i}`} value={p.hostIp} onChange={(e) => upd(setPorts, p.id, { hostIp: e.target.value as 'local' | 'all' })}><option value="local">Solo este equipo</option><option value="all">Todas las interfaces</option></Select>
                  </div>
                  <div><label className="sr-only" htmlFor={`pH${i}`}>Puerto del equipo {i + 1}</label><Input id={`pH${i}`} value={p.host} placeholder="8080" inputMode="numeric" aria-invalid={!!fe(`ports.${p.id}.host`)} aria-describedby={fe(`ports.${p.id}.host`) ? `ePH${i}` : undefined} onBlur={() => touch(`ports.${p.id}.host`)} onChange={(e) => upd(setPorts, p.id, { host: e.target.value })} /></div>
                  <div><label className="sr-only" htmlFor={`pC${i}`}>Puerto del contenedor {i + 1}</label><Input id={`pC${i}`} value={p.container} placeholder="80" inputMode="numeric" aria-invalid={!!fe(`ports.${p.id}.container`)} aria-describedby={fe(`ports.${p.id}.container`) ? `ePC${i}` : undefined} onBlur={() => touch(`ports.${p.id}.container`)} onChange={(e) => upd(setPorts, p.id, { container: e.target.value })} /></div>
                  <div>
                    <label className="sr-only" htmlFor={`pP${i}`}>Protocolo {i + 1}</label>
                    <Select id={`pP${i}`} value={p.protocol} onChange={(e) => upd(setPorts, p.id, { protocol: e.target.value as 'tcp' | 'udp' })}><option value="tcp">tcp</option><option value="udp">udp</option></Select>
                  </div>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Quitar puerto ${i + 1}`} onClick={() => rm(setPorts, p.id)}><Icon name="x" /></Button>
                  {fe(`ports.${p.id}.host`) ? <span className="f-error col-[1/-1]" id={`ePH${i}`} ><Icon name="alert" size="sm" />{fe(`ports.${p.id}.host`)}</span> : null}
                  {fe(`ports.${p.id}.container`) ? <span className="f-error col-[1/-1]" id={`ePC${i}`} ><Icon name="alert" size="sm" />{fe(`ports.${p.id}.container`)}</span> : null}
                  {p.hostIp === 'all' && p.host.trim() ? <span className="f-hint col-[1/-1]" >Publicado en todas las interfaces: accesible desde tu red.</span> : null}
                </div>
              ))}
              <div><Button type="button" variant="secondary" size="sm" onClick={() => setPorts((p) => [...p, { id: uuidv7(), hostIp: 'local', host: '', container: '', protocol: 'tcp' }])}><Icon name="plus" size="sm" />Añadir puerto</Button></div>
            </div>
          </section>

          <VolumesSection
            vols={vols}
            connName={conn.profile.name}
            remoteBind={remoteBind}
            relRemote={relRemote}
            binds={binds}
            fieldError={fe}
            onPatch={(id, patch) => upd(setVols, id, patch)}
            onRemove={(id) => rm(setVols, id)}
            onAdd={() => setVols((p) => [...p, { id: uuidv7(), source: '', target: '', readOnly: false }])}
            onTouch={touch}
          />

          <section className="card form-section">
            <h2>Variables de entorno</h2>
            <div className="form-body">
              {env.map((v, i) => (
                <div className="rep two" key={v.id}>
                  <div><label className="sr-only" htmlFor={`eK${i}`}>Variable {i + 1}</label><Input className="mono" id={`eK${i}`} value={v.key} placeholder="CLAVE" aria-invalid={!!fe(`env.${v.id}.key`)} aria-describedby={fe(`env.${v.id}.key`) ? `eEK${i}` : undefined} onBlur={() => touch(`env.${v.id}.key`)} onChange={(e) => upd(setEnv, v.id, { key: e.target.value })} /></div>
                  <div><label className="sr-only" htmlFor={`eV${i}`}>Valor {i + 1}</label><Input className="mono" id={`eV${i}`} value={v.value} placeholder="valor" onChange={(e) => upd(setEnv, v.id, { value: e.target.value })} /></div>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Quitar variable ${i + 1}`} onClick={() => rm(setEnv, v.id)}><Icon name="x" /></Button>
                  {fe(`env.${v.id}.key`) ? <span className="f-error col-[1/-1]" id={`eEK${i}`} ><Icon name="alert" size="sm" />{fe(`env.${v.id}.key`)}</span> : null}
                </div>
              ))}
              <div><Button type="button" variant="secondary" size="sm" onClick={() => setEnv((p) => [...p, { id: uuidv7(), key: '', value: '' }])}><Icon name="plus" size="sm" />Añadir variable</Button></div>
            </div>
          </section>

          <section className="card form-section">
            <h2>Red y reinicio</h2>
            <div className="form-body">
              <div className="f-cols">
                <div className="f-row">
                  <label htmlFor="fNet">Red</label>
                  <Select id="fNet" value={net} aria-invalid={!!fe('network')} onChange={(e) => setNet(e.target.value)}>
                    {networks.map((n) => <option key={n.id} value={n.name}>{safeText(n.name, { singleLine: true })}</option>)}
                    {networks.some((n) => n.name === net) ? null : <option value={net}>{net}</option>}
                  </Select>
                  {fieldMsg('network', 'eNet')}
                </div>
                <div className="f-row">
                  <span className="f-label" id="lRestart">Política de reinicio</span>
                  <Segmented<Restart> labelledBy="lRestart" className="justify-self-start" value={restart} onChange={setRestart} options={RESTARTS.map((r) => ({ value: r, label: r }))} />
                </div>
              </div>
            </div>
          </section>

          <section className="card form-section">
            <h2>Grupo</h2>
            <div className="form-body">
              <div className="f-row">
                <label htmlFor="fGroup">Grupo propio <span className="muted">(opcional)</span></label>
                <div className="flex flex-wrap gap-2">
                  <Select id="fGroup" value={groupId} onChange={(e) => setGroupId(e.target.value)} aria-describedby="hGroup">
                    <option value="">Sin grupo (por defecto: su stack o suelto)</option>
                    {groups.map((g) => <option key={g.id} value={g.id}>{safeText(g.name, { singleLine: true })}</option>)}
                  </Select>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setGroupDlg(true)}><Icon name="folder-plus" size="sm" />Nuevo grupo…</Button>
                </div>
                <span className="f-hint" id="hGroup">Los grupos son solo de esta app: no cambian nada en Docker.</span>
              </div>
            </div>
          </section>

          {phase === 'pulling' && pullRef ? (
            <section className="card" aria-label="Descargando imagen" ref={pullCard}>
              <header className="flex items-center gap-3 px-4 py-3 border-b border-border">
                <b>Descargando imagen</b><span className="mono muted">{safeText(pullRef, { singleLine: true })}</span>
                <Button type="button" variant="secondary" size="sm" className="ml-auto" onClick={() => store.getState().cancelPull(pullRef)}><Icon name="x" size="sm" />Cancelar</Button>
              </header>
              <div role="status" aria-live="polite" className="sr-only">Descargando {pullRef}</div>
              {pullOp?.layers.length ? <LayerProgress layers={pullOp.layers} pulling /> : <div className="layer"><span className="muted">Conectando con el registro…</span></div>}
            </section>
          ) : null}
          {pullOp && phase === 'idle' && (pullOp.state === 'error' || pullOp.state === 'canceled') ? (
            <AlertBox kind={pullOp.state === 'error' ? 'error' : 'info'} icon={pullOp.state === 'error' ? 'alert' : 'info'} title={pullOp.state === 'error' ? `No se pudo descargar ${safeText(pullRef, { singleLine: true })}` : 'Descarga cancelada'}
              text={pullOp.error ? safeText(pullErrorText(pullRef, pullOp.error)) : 'No se creó el contenedor.'} />
          ) : null}
          {formError ? (() => { const m = apiErrorMessage(formError); return <AlertBox kind="error" icon="alert" title={m.title} text={safeText(m.detail)} /> })() : null}

          <div className="form-actions">
            <Button type="submit" variant="primary" data-create="start" locked={locked}><Icon name={busy ? 'loader' : 'play'} fill={!busy} spin={busy} />{phase === 'pulling' ? 'Descargando…' : phase === 'creating' ? 'Creando…' : 'Crear e iniciar'}</Button>
            <Button type="submit" variant="secondary" data-create="only" locked={locked}>Solo crear</Button>
            <LinkButton variant="ghost" href={route.href('containers')}>Cancelar</LinkButton>
          </div>
        </form>
      </div>
      <NewGroupDialog open={groupDlg} onClose={() => setGroupDlg(false)} onCreated={(id) => { setGroupId(id); setGroupDlg(false) }} />
    </>
  )
}
