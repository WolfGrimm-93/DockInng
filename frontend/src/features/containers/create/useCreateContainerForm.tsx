// Estado, validación y flujo de envío de «Nuevo contenedor». La vista (CreateContainerPage y sus secciones) solo pinta:
// el plan y la confirmación los da el backend, la descarga de imagen y la creación van aquí.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { devFlagsEnabled } from '@/app/devFlags'
import type { useHashRoute } from '@/app/useHashRoute'
import { useConfirm } from '@/components/shared/confirmApi'
import { useCapability, useConnection, useContainers, useEngineApi, useEngineStoreApi, useImages, useIsSimulatedWorld, useNetworks, usePull } from '@/data/store/hooks'
import { toApiError } from '@/data/errors'
import type { ApiError, CreatePlan, Restart } from '@/data/types'
import { backendFieldToKey, imageIsLocal, toCreateSpec, validateCreateForm, type CreateForm, type EnvRow, type PortRow, type VolRow } from '@/lib/createForm'
import { safeText } from '@/lib/safeText'
import { sensitiveBind } from '@/lib/sensitiveBind'
import { toast } from '@/lib/toastStore'
import { uuidv7 } from '@/lib/uuid7'
import { warningLine } from './warnings'

import { useStartupOnce } from '../../common/devOnce'
import { useGroupsStore } from '../../groups/groupsStore'

export type CreateRoute = ReturnType<typeof useHashRoute>

/** Une los cambios de un fila (puerto, variable, montaje) por id. Cualquier edición limpia los errores del backend. */
function patchRow<T extends { id: string }>(set: (f: (p: T[]) => T[]) => void, clearBackend: () => void, id: string, patch: Partial<T>) {
  set((p) => p.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  clearBackend()
}

/** Espera a que una descarga termine: 'done', 'error', 'canceled' (o desaparece del store). */
function waitPull(store: ReturnType<typeof useEngineStoreApi>, ref: string) {
  return new Promise<'done' | 'error' | 'canceled'>((resolve) => {
    const cur = store.getState().pulls[ref]
    if (cur && cur.state !== 'pulling') return resolve(cur.state)
    const unsub = store.subscribe((s) => {
      const p = s.pulls[ref]
      if (!p) { unsub(); resolve('canceled') } else if (p.state !== 'pulling') { unsub(); resolve(p.state) }
    })
  })
}

export function useCreateContainerForm(route: CreateRoute) {
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const conn = useConnection()
  const confirm = useConfirm()
  const cap = useCapability('create')
  const browserWorld = useIsSimulatedWorld()
  const { list: containers } = useContainers()
  const { list: images } = useImages()
  const { list: networks } = useNetworks()
  const groups = useGroupsStore((s) => s.groups)
  const moveContainers = useGroupsStore((s) => s.moveContainers)
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
  const [submitted, setSubmitted] = useState(0)
  const [touched, setTouched] = useState<Record<string, true>>({})
  const [backendErrors, setBackendErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<ApiError | null>(null)
  const [phase, setPhase] = useState<'idle' | 'pulling' | 'creating'>('idle')
  const [pullRef, setPullRef] = useState('')
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
  /** Error visible de un campo: solo tras intentar enviar, tocarlo o tener un error del backend. */
  const fieldError = (k: string): string | undefined => (submitted > 0 || touched[k] || backendErrors[k] ? errors[k] : undefined)
  const touch = (k: string) => setTouched((t) => (t[k] ? t : { ...t, [k]: true }))
  const clearBackendErrors = () => setBackendErrors({})
  const relRemote = conn.profile.remote ? vols.filter((v) => v.source && !v.source.startsWith('/') && /^[.~]/.test(v.source)) : []
  // Montajes con aviso de sensibilidad (sin aserciones `!`: el tipo se estrecha al construir la lista).
  const binds = vols.flatMap((v) => {
    const w = sensitiveBind(v.source, v.readOnly)
    return w ? [{ v, w }] : []
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

  /** Descarga la imagen y espera; false si falla o se cancela (el error queda visible en la tarjeta). */
  const pullFirst = async (ref: string): Promise<boolean> => {
    setPullRef(ref)
    setPhase('pulling')
    store.getState().startPull(ref)
    const r = await waitPull(store, ref)
    if (!mounted.current) return false
    setPhase('creating')
    return r === 'done'
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

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const start = ((e.nativeEvent as SubmitEvent).submitter as HTMLElement | null)?.dataset.create !== 'only'
    void run(start)
  }

  return {
    submitted, phase, images, networks, groups, cap,
    image, setImage, name, setName, command, setCommand, restart, setRestart, net, setNet,
    ports, env, vols, groupId, setGroupId,
    fieldError, touch, clearBackendErrors,
    addPort: () => setPorts((p) => [...p, { id: uuidv7(), hostIp: 'local', host: '', container: '', protocol: 'tcp' }]),
    patchPort: (id: string, patch: Partial<PortRow>) => patchRow(setPorts, clearBackendErrors, id, patch),
    removePort: (id: string) => setPorts((p) => p.filter((r) => r.id !== id)),
    addEnv: () => setEnv((p) => [...p, { id: uuidv7(), key: '', value: '' }]),
    patchEnv: (id: string, patch: Partial<EnvRow>) => patchRow(setEnv, clearBackendErrors, id, patch),
    removeEnv: (id: string) => setEnv((p) => p.filter((r) => r.id !== id)),
    addVol: () => setVols((p) => [...p, { id: uuidv7(), source: '', target: '', readOnly: false }]),
    patchVol: (id: string, patch: Partial<VolRow>) => patchRow(setVols, clearBackendErrors, id, patch),
    removeVol: (id: string) => setVols((p) => p.filter((r) => r.id !== id)),
    remoteBind, binds, relRemote, connName: conn.profile.name,
    busy: phase !== 'idle', pullRef, pullOp, formError, submit,
    cancelPull: () => store.getState().cancelPull(pullRef),
  }
}
