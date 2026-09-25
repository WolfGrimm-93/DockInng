// Vista «Nuevo contenedor» (#create?image=&remote=1). Formulario REAL (validación, conflicto de puertos con contenedores reales,
// lista de imágenes locales) pero el ENVÍO es SIMULADO (marca «No conectado aún»): en Tauri no crea nada y lo dice.
import { safeText } from '@/lib/safeText'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { devFlagsEnabled } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { Icon } from '@/components/shared/Icon'
import { PageHeader } from '@/components/shared/PageHeader'
import { Segmented } from '@/components/shared/Segmented'
import { AlertBox } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { apiErrorMessage } from '@/data/errors'
import { useConnection, useContainers, useEngineApi, useImages, useIsSimulatedWorld, useNetworks } from '@/data/store/hooks'
import type { CreateSpec } from '@/data/types'
import { uuidv7 } from '@/lib/uuid7'
import { toast } from '@/lib/toastStore'
import { useStartupOnce } from '../common/devOnce'
import { useViewGate } from '../common/gate'
import { LinkButton } from '../common/LinkButton'

type Restart = CreateSpec['restart']
const RESTARTS: Restart[] = ['no', 'always', 'unless-stopped', 'on-failure']
interface PortRow { id: string; host: string; container: string; protocol: 'tcp' | 'udp' }
interface VolRow { id: string; host: string; container: string }
interface EnvRow { id: string; key: string; value: string }

export default function CreateContainerPage() {
  const route = useHashRoute()
  const api = useEngineApi()
  const conn = useConnection()
  const gate = useViewGate(4, 6)
  const browserWorld = useIsSimulatedWorld()
  const { list: containers } = useContainers()
  const { list: images } = useImages()
  const { list: networks } = useNetworks()
  const formRef = useRef<HTMLFormElement>(null)

  const [image, setImage] = useState(() => route.params.get('image') ?? '')
  const [name, setName] = useState('')
  const [restart, setRestart] = useState<Restart>('unless-stopped')
  const [net, setNet] = useState('bridge')
  const [ports, setPorts] = useState<PortRow[]>(() => [{ id: uuidv7(), host: '8080', container: '80', protocol: 'tcp' }])
  const [vols, setVols] = useState<VolRow[]>(() => [{ id: uuidv7(), host: './datos', container: '/var/lib/postgresql/data' }])
  const [env, setEnv] = useState<EnvRow[]>(() => [{ id: uuidv7(), key: 'POSTGRES_PASSWORD', value: '' }])
  const [err, setErr] = useState<{ image?: string; name?: string }>({})
  const [busy, setBusy] = useState(false)

  // #create?remote=1 (plantilla): abre el formulario con una conexión remota activa (solo mundo simulado/DEV).
  const wantRemote = route.params.get('remote') === '1' && devFlagsEnabled(api) && browserWorld
  useStartupOnce('create.remote', wantRemote && conn.profiles.length > 0, () => {
    const r = conn.profiles.find((p) => p.remote)
    if (r && !conn.profile.remote) conn.select(r.id)
  })

  const relRemote = useMemo(() => (conn.profile.remote ? vols.filter((v) => v.host && !v.host.startsWith('/') && /^[.~]/.test(v.host)) : []), [conn.profile.remote, vols])
  const owner = (host: string): string | undefined => {
    if (!host) return undefined
    const c = containers.find((x) => x.state === 'running' && x.ports.some((p) => String(p.public_port) === host))
    return c?.names[0]
  }

  useEffect(() => {
    if (err.image || err.name) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [err])

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const mode = ((e.nativeEvent as SubmitEvent).submitter as HTMLElement | null)?.dataset.create === 'only' ? 'only' : 'start'
    const next: { image?: string; name?: string } = {}
    if (!image.trim()) next.image = 'Indica la imagen que se va a ejecutar.'
    if (name && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) next.name = 'Solo letras, números, punto, guion y guion bajo; debe empezar por letra o número.'
    if (name && containers.some((c) => c.names.includes(name))) next.name = `Ya existe un contenedor llamado ${safeText(name, { singleLine: true })}.`
    setErr(next)
    if (next.image || next.name) {
      toast.warn('Revisa el formulario', { sub: 'Hay campos con errores.' })
      return
    }
    const spec: CreateSpec = {
      image: image.trim(), name,
      ports: ports.filter((p) => p.host && p.container).map((p) => ({ host: p.host, container: p.container, protocol: p.protocol })),
      volumes: vols.filter((v) => v.host && v.container).map((v) => ({ host: v.host, container: v.container, readOnly: false })),
      env: env.filter((v) => v.key).map((v) => ({ key: v.key, value: v.value })),
      network: net, restart,
    }
    setBusy(true)
    try {
      const r = await api.create.submit(spec, mode)
      if (browserWorld) {
        toast.ok(mode === 'start' ? `${safeText(r.name, { singleLine: true })} creado e iniciado` : `${safeText(r.name, { singleLine: true })} creado`)
        route.go('containers')
      } else {
        toast.warn('Simulado — no conectado aún', { sub: 'No se creó ningún contenedor: la creación todavía no está conectada al motor de Docker.' })
      }
    } catch (ex) {
      const m = apiErrorMessage(ex)
      toast.err(m.title, { sub: m.detail })
    } finally {
      setBusy(false)
    }
  }

  const head = <PageHeader title="Nuevo contenedor" back={{ href: route.href('containers'), label: 'Contenedores' }} simulated />
  if (gate.blocked) return <>{head}{gate.blocked}</>

  const upd = <T extends { id: string }>(set: (f: (p: T[]) => T[]) => void, id: string, patch: Partial<T>) => set((p) => p.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const rm = <T extends { id: string }>(set: (f: (p: T[]) => T[]) => void, id: string) => set((p) => p.filter((r) => r.id !== id))

  return (
    <>
      {head}
      <div className="view-body">
        {gate.lostBanner}
        <form className="form" id="createForm" noValidate ref={formRef} onSubmit={(e) => void submit(e)}>
          <section className="card form-section">
            <h2>Imagen y nombre</h2>
            <div className="form-body">
              <div className="f-cols">
                <div className="f-row">
                  <label htmlFor="fImage">Imagen</label>
                  <Input id="fImage" value={image} onChange={(e) => setImage(e.target.value)} placeholder="postgres:16.4" list="imgs" aria-invalid={!!err.image} aria-describedby={err.image ? 'eImage' : undefined} />
                  <datalist id="imgs">{images.filter((i) => !i.dangling).map((i) => <option key={i.reference} value={safeText(i.reference, { singleLine: true })} />)}</datalist>
                  {err.image ? <span className="f-error" id="eImage"><Icon name="alert" size="sm" />{err.image}</span> : <span className="f-hint">Elige una imagen local o escribe otra: si no existe, se descargará.</span>}
                </div>
                <div className="f-row">
                  <label htmlFor="fName">Nombre <span className="muted">(opcional)</span></label>
                  <Input id="fName" value={name} onChange={(e) => setName(e.target.value)} placeholder="base-datos-pruebas" aria-invalid={!!err.name} aria-describedby={err.name ? 'eName' : undefined} />
                  {err.name ? <span className="f-error" id="eName"><Icon name="alert" size="sm" />{err.name}</span> : <span className="f-hint">Letras, números, punto, guion y guion bajo.</span>}
                </div>
              </div>
            </div>
          </section>

          <section className="card form-section">
            <h2>Puertos</h2>
            <div className="form-body">
              {ports.map((p, i) => {
                const own = owner(p.host)
                return (
                  <div className="rep" key={p.id}>
                    <div><label className="sr-only" htmlFor={`pH${i}`}>Puerto del equipo {i + 1}</label><Input id={`pH${i}`} value={p.host} placeholder="8080" inputMode="numeric" aria-invalid={!!own} onChange={(e) => upd(setPorts, p.id, { host: e.target.value })} /></div>
                    <div><label className="sr-only" htmlFor={`pC${i}`}>Puerto del contenedor {i + 1}</label><Input id={`pC${i}`} value={p.container} placeholder="80" inputMode="numeric" onChange={(e) => upd(setPorts, p.id, { container: e.target.value })} /></div>
                    <div>
                      <label className="sr-only" htmlFor={`pP${i}`}>Protocolo {i + 1}</label>
                      <Select id={`pP${i}`} value={p.protocol} onChange={(e) => upd(setPorts, p.id, { protocol: e.target.value as 'tcp' | 'udp' })}><option value="tcp">tcp</option><option value="udp">udp</option></Select>
                    </div>
                    <Button type="button" variant="ghost" size="icon" aria-label={`Quitar puerto ${i + 1}`} onClick={() => rm(setPorts, p.id)}><Icon name="x" /></Button>
                    {own ? <span className="f-error" style={{ gridColumn: '1/-1' }}><Icon name="alert" size="sm" />El puerto {p.host} del equipo ya lo usa {safeText(own, { singleLine: true })}.</span> : null}
                  </div>
                )
              })}
              <div><Button type="button" variant="secondary" size="sm" onClick={() => setPorts((p) => [...p, { id: uuidv7(), host: '', container: '', protocol: 'tcp' }])}><Icon name="plus" size="sm" />Añadir puerto</Button></div>
            </div>
          </section>

          <section className="card form-section">
            <h2>Volúmenes</h2>
            <div className="form-body">
              {relRemote.length ? <AlertBox kind="warn" icon="warn" title="Ruta relativa en una conexión remota" text={`Con «${safeText(conn.profile.name, { singleLine: true })}» activa, «${safeText(relRemote[0].host, { singleLine: true })}» se resuelve en el servidor, no en tu equipo. Usa una ruta absoluta del servidor o un volumen con nombre.`} /> : null}
              {vols.map((v, i) => (
                <div className="rep two" key={v.id}>
                  <div><label className="sr-only" htmlFor={`vH${i}`}>Origen (volumen o ruta) {i + 1}</label><Input className="mono" id={`vH${i}`} value={v.host} placeholder="datos-pg o /srv/datos" onChange={(e) => upd(setVols, v.id, { host: e.target.value })} /></div>
                  <div><label className="sr-only" htmlFor={`vC${i}`}>Ruta en el contenedor {i + 1}</label><Input className="mono" id={`vC${i}`} value={v.container} placeholder="/var/lib/postgresql/data" onChange={(e) => upd(setVols, v.id, { container: e.target.value })} /></div>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Quitar volumen ${i + 1}`} onClick={() => rm(setVols, v.id)}><Icon name="x" /></Button>
                </div>
              ))}
              <div><Button type="button" variant="secondary" size="sm" onClick={() => setVols((p) => [...p, { id: uuidv7(), host: '', container: '' }])}><Icon name="plus" size="sm" />Añadir volumen</Button></div>
            </div>
          </section>

          <section className="card form-section">
            <h2>Variables de entorno</h2>
            <div className="form-body">
              {env.map((v, i) => (
                <div className="rep two" key={v.id}>
                  <div><label className="sr-only" htmlFor={`eK${i}`}>Variable {i + 1}</label><Input className="mono" id={`eK${i}`} value={v.key} placeholder="CLAVE" onChange={(e) => upd(setEnv, v.id, { key: e.target.value })} /></div>
                  <div><label className="sr-only" htmlFor={`eV${i}`}>Valor {i + 1}</label><Input className="mono" id={`eV${i}`} value={v.value} placeholder="valor" onChange={(e) => upd(setEnv, v.id, { value: e.target.value })} /></div>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Quitar variable ${i + 1}`} onClick={() => rm(setEnv, v.id)}><Icon name="x" /></Button>
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
                  <Select id="fNet" value={net} onChange={(e) => setNet(e.target.value)}>
                    {networks.map((n) => <option key={n.id} value={n.name}>{safeText(n.name, { singleLine: true })}</option>)}
                    {networks.some((n) => n.name === net) ? null : <option value={net}>{net}</option>}
                  </Select>
                </div>
                <div className="f-row">
                  <span className="f-label" id="lRestart">Política de reinicio</span>
                  <Segmented<Restart> labelledBy="lRestart" style={{ justifySelf: 'start' }} value={restart} onChange={setRestart} options={RESTARTS.map((r) => ({ value: r, label: r }))} />
                </div>
              </div>
            </div>
          </section>

          <div className="form-actions">
            <Button type="submit" variant="primary" data-create="start" locked={gate.locked || busy}><Icon name="play" fill />Crear e iniciar</Button>
            <Button type="submit" variant="secondary" data-create="only" locked={gate.locked || busy}>Solo crear</Button>
            <LinkButton variant="ghost" href={route.href('containers')}>Cancelar</LinkButton>
          </div>
        </form>
      </div>
    </>
  )
}
