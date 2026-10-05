// Vista «Nueva conexión» (#conn-new). Ola 2: conexiones REALES por SSH (agente o ruta de llave; alias de ~/.ssh/config) o TLS mutuo (3 rutas).
// Flujo: «Verificar y probar» → (SSH) `connection_probe_host_key` → HostKeyDialog (TOFU: la huella se enseña SIEMPRE; clave cambiada = bloqueo)
// → `connection_trust_host_key` → `connection_test` → «Guardar» (solo tras una prueba correcta de ESTOS datos). No hay campo que acepte contenido
// de llaves ni opción «inseguro». (?test=testing|ok|fail solo en simulado/DEV: previsualiza los estados de la prueba.)
import { safeText } from '@/lib/safeText'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { devFlagsEnabled } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { HostKeyDialog } from '@/components/shared/HostKeyDialog'
import { Icon } from '@/components/shared/Icon'
import { PageHeader } from '@/components/shared/PageHeader'
import { Segmented } from '@/components/shared/Segmented'
import { AlertBox } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { connectionFailText } from '@/data/diagnostics'
import { apiErrorMessage, toApiError } from '@/data/errors'
import { useCapability, useEngineApi, useEngineStore, useEngineStoreApi, useIsSimulatedWorld } from '@/data/store/hooks'
import type { ConnSpec, ConnTestResult, HostKeyProbe, PodmanCandidate } from '@/data/types'
import { toast } from '@/lib/toastStore'
import { LinkButton } from '../common/LinkButton'

type Kind = 'ssh' | 'tls'
type Mode = 'explicit' | 'alias'
type Ident = 'agent' | 'file'
type Phase = 'idle' | 'probing' | 'trusting' | 'testing' | 'saving'
type Errors = Partial<Record<'name' | 'host' | 'port' | 'user' | 'identity' | 'ca' | 'cert' | 'key', string>>

const HOST_RE = /^(?:[A-Za-z0-9._-]{1,253}|\[[0-9A-Fa-f:.]+\])$/
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/

export default function ConnNewPage() {
  const route = useHashRoute()
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const browserWorld = useIsSimulatedWorld()
  const cap = useCapability('connections')
  const preset = devFlagsEnabled(api) ? route.params.get('test') : null
  const [kind, setKind] = useState<Kind>('ssh')
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('')
  const [mode, setMode] = useState<Mode>('explicit')
  const [ident, setIdent] = useState<Ident>('agent')
  const [identPath, setIdentPath] = useState('')
  const [ca, setCa] = useState('')
  const [cert, setCert] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [phase, setPhase] = useState<Phase>('idle')
  const [probe, setProbe] = useState<HostKeyProbe | null>(null)
  const editId = route.params.get('id')
  const editing = !!editId
  const [result, setResult] = useState<ConnTestResult | null>(editing ? null : preset === 'ok' ? { ok: true, server: { version: '26.1.4', api_version: '1.45', os: 'linux', arch: 'x86_64' } } : preset === 'fail' ? { ok: false, cause: 'auth_failed', error: { code: 'connection', message: 'Permission denied (publickey).', cause: 'auth_failed' } } : null)
  const [okFor, setOkFor] = useState<string | null>(null) // huella JSON del spec probado con éxito
  const [podman, setPodman] = useState<PodmanCandidate[]>([])
  const seq = useRef(0)
  const nameInput = useRef<HTMLInputElement>(null)
  const verifyBtn = useRef<HTMLButtonElement>(null)
  // F2: foco al primer campo inválido tras el render.
  const [focusTick, setFocusTick] = useState(0)
  useEffect(() => { if (focusTick > 0) document.querySelector<HTMLElement>('form [aria-invalid="true"]')?.focus() }, [focusTick])
  const existing = useEngineStore((s) => s.profiles)
  const ssh = kind === 'ssh'
  const busy = phase !== 'idle'

  // La lista ya contiene el spec completo y nunca contiene secretos; hidrata el formulario solo al editar.
  // Se hace durante el render (patrón de React para ajustar estado ante cambios de props) y una sola vez por id:
  // así un refresco de la lista no pisa lo que el usuario ya está escribiendo.
  const [hydratedId, setHydratedId] = useState<string | null>(null)
  const editSpec = editId ? existing.find((p) => p.id === editId)?.spec : undefined
  if (editSpec && hydratedId !== editId) {
    setHydratedId(editId)
    setKind(editSpec.kind)
    setName(editSpec.name)
    setHost(editSpec.host)
    setPort(String(editSpec.port || (editSpec.kind === 'tls' ? 2376 : 22)))
    if (editSpec.kind === 'ssh') {
      setUser(editSpec.user)
      setMode(editSpec.mode)
      setIdent(editSpec.identity.type)
      setIdentPath(editSpec.identity.type === 'file' ? editSpec.identity.path : '')
    } else {
      setCa(editSpec.ca_path); setCert(editSpec.cert_path); setKeyPath(editSpec.key_path)
    }
  }

  const cancelPending = useCallback(() => { seq.current++ }, [])
  useEffect(() => { void api.system.podmanDetect().then(setPodman).catch(() => setPodman([])); return cancelPending }, [api, cancelPending])

  /** Valida en el borde (el backend vuelve a validar) y construye el spec tipado. */
  const build = (): { spec: ConnSpec; errors: null } | { spec: null; errors: Errors } => {
    const e: Errors = {}
    const p = Number(port)
    if (!name.trim() || name.trim().length > 40) e.name = 'Escribe un nombre (1–40 caracteres).'
    else if (name.trim().toLowerCase() === 'local') e.name = 'El nombre «Local» está reservado.'
    else if (existing.some((p) => p.id !== editId && p.name.trim().toLowerCase() === name.trim().toLowerCase())) e.name = 'Ya existe una conexión con ese nombre: elige otro (o elimínala antes desde Configuración).'
    if (!HOST_RE.test(host.trim()) || host.trim().startsWith('-')) e.host = ssh && mode === 'alias' ? 'Alias no válido (letras, números, punto, guion).' : 'Host no válido (nombre, IPv4 o [IPv6]).'
    if (!Number.isInteger(p) || p < 1 || p > 65535) e.port = 'Puerto entre 1 y 65535.'
    if (ssh) {
      if (mode === 'explicit' && !USER_RE.test(user.trim())) e.user = 'Usuario no válido (minúsculas, números, _ y -).'
      if (ident === 'file' && !identPath.trim().startsWith('/')) e.identity = 'Indica la ruta ABSOLUTA de la llave privada.'
    } else {
      if (!ca.trim().startsWith('/')) e.ca = 'Ruta absoluta del certificado CA.'
      if (!cert.trim().startsWith('/')) e.cert = 'Ruta absoluta del certificado de cliente.'
      if (!keyPath.trim().startsWith('/')) e.key = 'Ruta absoluta de la llave de cliente.'
    }
    if (Object.keys(e).length) return { spec: null, errors: e }
    const base = { name: name.trim(), host: host.trim(), port: p }
    const spec: ConnSpec = ssh
      ? { kind: 'ssh', ...base, user: user.trim(), mode, identity: ident === 'agent' ? { type: 'agent' } : { type: 'file', path: identPath.trim() } }
      : { kind: 'tls', ...base, ca_path: ca.trim(), cert_path: cert.trim(), key_path: keyPath.trim() }
    return { spec, errors: null }
  }
  const specKey = useMemo(() => { const b = build(); return b.spec ? JSON.stringify(b.spec) : null }, [kind, name, host, port, user, mode, ident, identPath, ca, cert, keyPath]) // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = () => { seq.current++; setResult(null); setOkFor(null); setPhase('idle') }

  const runTest = async (spec: ConnSpec, n: number) => {
    setPhase('testing')
    try {
      const r = await api.connections.test(spec)
      if (n !== seq.current) return
      setResult(r)
      setOkFor(r.ok ? JSON.stringify(spec) : null)
    } catch (ex) {
      if (n !== seq.current) return
      const m = apiErrorMessage(ex)
      setResult({ ok: false, error: { code: 'internal', message: m.detail || m.title } })
    } finally { if (n === seq.current) setPhase('idle') }
  }

  const verify = async () => {
    const b = build()
    setErrors(b.errors ?? {})
    if (!b.spec) { setFocusTick((n) => n + 1); return }
    const spec = b.spec
    const n = ++seq.current
    setResult(null)
    setOkFor(null)
    if (spec.kind === 'tls') return void runTest(spec, n)
    setPhase('probing')
    try {
      const p = await api.connections.probeHostKey(spec)
      if (n !== seq.current) return
      if (p.state === 'trusted') return void runTest(spec, n)
      setProbe(p) // unknown → pedir confirmación; changed → bloqueo
      // B-1: con clave cambiada queda un resultado fallido PERSISTENTE en #connRes aunque se cierre el diálogo.
      if (p.state === 'changed') setResult({ ok: false, cause: 'host_key_changed', error: { code: 'connection', message: 'La clave del host es distinta de la confiada antes.', cause: 'host_key_changed' } })
      setPhase('idle')
    } catch (ex) {
      if (n !== seq.current) return
      const m = apiErrorMessage(ex)
      setResult({ ok: false, cause: 'unreachable', error: { code: 'connection', message: m.detail || m.title, cause: 'unreachable' } })
      setPhase('idle')
    }
  }

  const trust = async () => {
    const b = build()
    if (!b.spec || !probe) return
    const n = seq.current
    setPhase('trusting')
    try {
      await api.connections.trustHostKey(b.spec, probe.fingerprint_sha256)
      if (n !== seq.current) return
      setProbe(null)
      await runTest(b.spec, n)
    } catch (ex) {
      if (n !== seq.current) return
      // B-1: se muestra la causa REAL (una huella que cambió entre sondeos es «conflict», no «clave cambiada»).
      const a = toApiError(ex)
      const m = apiErrorMessage(ex)
      setProbe(null)
      setResult({ ok: false, cause: a.cause ?? null, error: { ...a, message: m.detail || m.title } })
      setPhase('idle')
      window.setTimeout(() => verifyBtn.current?.focus(), 0)
    }
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const b = build()
    if (!b.spec || okFor !== JSON.stringify(b.spec)) return
    setPhase('saving')
    try {
      const p = await api.connections.save(b.spec, editId ?? undefined)
      await store.getState().refreshProfiles()
      toast.ok('Conexión guardada', { sub: safeText(p.name, { singleLine: true }) })
      route.go('settings')
    } catch (ex) {
      const a = toApiError(ex)
      if (a.code === 'conflict') {
        // M-2: el backend rechaza un nombre ya usado por otra conexión.
        setErrors((old) => ({ ...old, name: 'Ya existe una conexión con ese nombre: elige otro.' }))
        nameInput.current?.focus()
      } else {
        const m = apiErrorMessage(ex)
        toast.err(m.title, { sub: m.detail })
      }
      setPhase('idle')
    }
  }

  const pickKind = (k: Kind) => { setKind(k); dirty(); setErrors({}); setPort(k === 'tls' ? '2376' : '22') }
  const field = (k: keyof Errors, id: string) => (errors[k] ? <span className="f-error" id={id}><Icon name="alert" size="sm" />{errors[k]}</span> : null)
  const inv = (k: keyof Errors, id: string) => ({ 'aria-invalid': errors[k] ? true : undefined, 'aria-describedby': errors[k] ? id : undefined }) as const
  const canSave = !busy && specKey !== null && okFor === specKey
  const testing = phase === 'probing' || phase === 'trusting' || phase === 'testing'
  const cause = result && !result.ok ? result.cause ?? result.error?.cause ?? null : null

  return (
    <>
      <PageHeader title={editing ? 'Editar conexión' : 'Nueva conexión'} back={{ href: route.href('settings'), label: 'Configuración' }} simulated={cap !== 'live' || browserWorld} />
      <div className="view-body">
        <form className="form" id="connForm" noValidate onSubmit={(e) => void save(e)} onChange={() => { if (okFor || result) dirty() }}>
          <section className="card form-section">
            <h2>Datos de la conexión</h2>
            <div className="form-body">
              <div className="f-row">
                <span className="f-label" id="lType">Tipo</span>
                <Segmented<Kind> labelledBy="lType" style={{ justifySelf: 'start' }} value={kind} onChange={pickKind} options={[{ value: 'ssh', label: 'SSH' }, { value: 'tls', label: 'TLS (tcp://)' }]} />
              </div>
              <div className="f-cols">
                <div className="f-row"><label htmlFor="cName">Nombre</label><Input ref={nameInput} id="cName" value={name} placeholder="prod-hetzner" maxLength={40} {...inv('name', 'eName')} onChange={(e) => setName(e.target.value)} />{field('name', 'eName')}</div>
                <div className="f-row"><label htmlFor="cHost">{ssh && mode === 'alias' ? 'Alias de ~/.ssh/config' : 'Host'}</label><Input id="cHost" value={host} placeholder={ssh && mode === 'alias' ? 'mi-servidor' : '203.0.113.10'} autoCapitalize="none" spellCheck={false} {...inv('host', 'eHost')} onChange={(e) => setHost(e.target.value)} />{field('host', 'eHost')}</div>
                <div className="f-row"><label htmlFor="cPort">Puerto</label><Input id="cPort" value={port} inputMode="numeric" {...inv('port', 'ePort')} onChange={(e) => setPort(e.target.value)} />{field('port', 'ePort')}</div>
                {ssh ? (
                  <div className="f-row"><label htmlFor="cUser">Usuario</label><Input id="cUser" value={user} placeholder={mode === 'alias' ? 'Opcional: lo define el alias' : 'deploy'} autoCapitalize="none" spellCheck={false} {...inv('user', 'eUser')} onChange={(e) => setUser(e.target.value)} />{field('user', 'eUser')}</div>
                ) : (
                  <div className="f-row"><label htmlFor="cCa">Certificado CA (ruta)</label><Input className="mono" id="cCa" value={ca} placeholder="/home/tu-usuario/.docker/ca.pem" {...inv('ca', 'eCa')} onChange={(e) => setCa(e.target.value)} />{field('ca', 'eCa')}</div>
                )}
              </div>
              {ssh ? (
                <>
                  <div className="f-row">
                    <span className="f-label" id="lMode">Cómo se resuelve el host</span>
                    <Segmented<Mode> labelledBy="lMode" style={{ justifySelf: 'start' }} value={mode} onChange={(m) => { setMode(m); dirty() }} options={[{ value: 'explicit', label: 'Host y usuario' }, { value: 'alias', label: 'Alias de ~/.ssh/config' }]} />
                    <span className="f-hint">Con alias, el propio ssh lee tu configuración; DockInng igualmente exige verificar la huella y usa su propio archivo de hosts conocidos.</span>
                  </div>
                  <div className="f-row">
                    <span className="f-label" id="lIdent">Identidad</span>
                    <Segmented<Ident> labelledBy="lIdent" style={{ justifySelf: 'start' }} value={ident} onChange={(i) => { setIdent(i); dirty() }} options={[{ value: 'agent', label: 'ssh-agent' }, { value: 'file', label: 'Archivo de llave' }]} />
                  </div>
                  {ident === 'file' ? (
                    <div className="f-row">
                      <label htmlFor="cKey">Ruta de la llave privada</label>
                      <Input className="mono" id="cKey" value={identPath} placeholder="/home/tu-usuario/.ssh/id_ed25519" {...inv('identity', 'eKey')} onChange={(e) => setIdentPath(e.target.value)} />
                      {field('identity', 'eKey')}
                      <span className="f-hint">Solo la ruta: DockInng no lee, copia ni guarda el contenido de la llave. Las llaves con passphrase no se admiten sin agente: cárgala antes con <code>ssh-add</code> y usa «ssh-agent».</span>
                    </div>
                  ) : (
                    <span className="f-hint">Se usa la llave cargada en tu <code>ssh-agent</code> (<code>SSH_AUTH_SOCK</code>). Nunca se pide ni se guarda una passphrase.</span>
                  )}
                </>
              ) : (
                <>
                  <div className="f-cols">
                    <div className="f-row"><label htmlFor="cCert">Certificado de cliente (ruta)</label><Input className="mono" id="cCert" value={cert} placeholder="/home/tu-usuario/.docker/cert.pem" {...inv('cert', 'eCert')} onChange={(e) => setCert(e.target.value)} />{field('cert', 'eCert')}</div>
                    <div className="f-row"><label htmlFor="cKeyT">Llave de cliente (ruta)</label><Input className="mono" id="cKeyT" value={keyPath} placeholder="/home/tu-usuario/.docker/key.pem" {...inv('key', 'eKeyT')} onChange={(e) => setKeyPath(e.target.value)} />{field('key', 'eKeyT')}</div>
                  </div>
                  <span className="f-hint">TLS mutuo: siempre se verifica el certificado del servidor contra la CA. No existe la opción «inseguro».</span>
                </>
              )}
            </div>
          </section>

          <div id="connRes" aria-live="polite">
            {testing ? (
              <div className="alert alert-info" role="status"><Icon name="loader" spin /><div><b>{phase === 'probing' ? 'Leyendo la clave del host…' : phase === 'trusting' ? 'Guardando la huella…' : 'Probando conexión…'}</b><p>{phase === 'probing' ? 'Sin conectar todavía: solo se lee la clave pública del servidor.' : 'Comprobando red, autenticación y Docker remoto.'}</p></div></div>
            ) : result?.ok ? (
              <AlertBox kind="info" icon="check" title="Conexión correcta" text={`${result.server ? `Docker ${safeText(result.server.version, { singleLine: true })} · API ${safeText(result.server.api_version, { singleLine: true })}. ` : ''}Ya puedes guardarla.`} />
            ) : result ? (
              <AlertBox kind="error" icon="alert" title={cause === 'host_key_changed' ? 'La clave del host cambió: conexión bloqueada' : 'No se pudo conectar'}
                text={<>{connectionFailText(cause, safeText(result.error?.message ?? '', { singleLine: true }))}{cause === 'auth_failed' && ssh ? ' Comprueba la identidad y que la llave esté cargada (ssh-add -l).' : ''}{cause === 'remote_docker_missing' ? ' Necesita Docker CLI ≥ 18.09 en el PATH de una sesión no interactiva.' : ''}</>} />
            ) : null}
          </div>

          {podman.length ? (
            <AlertBox kind="info" icon="info" title="Se detectó Podman en este equipo"
              text={<>{podman.map((c) => <span key={c.path} style={{ display: 'block' }}><code>{safeText(c.path, { singleLine: true })}</code> ({c.rootless ? 'rootless' : 'root'})</span>)}Por ahora es solo detección: conectar con Podman todavía no está disponible.</>} />
          ) : null}

          <div className="form-actions">
            <Button ref={verifyBtn} type="button" variant="secondary" locked={busy} onClick={() => { if (!busy) void verify() }}><Icon name={testing ? 'loader' : 'zap'} spin={testing} />{ssh ? 'Verificar y probar' : 'Probar conexión'}</Button>
            <Button type="submit" variant="primary" disabled={!canSave}><Icon name="check" />Guardar conexión</Button>
            <LinkButton variant="ghost" href={route.href('settings')}>Cancelar</LinkButton>
            {!result && !testing ? <span className="muted" style={{ alignSelf: 'center' }}>Sin probar todavía.</span> : null}
          </div>
        </form>
      </div>
      <HostKeyDialog probe={probe} host={host.trim()} port={Number(port) || 22} busy={phase === 'trusting'} simulated={browserWorld} onTrust={() => void trust()} onClose={() => { setProbe(null); setPhase('idle'); window.setTimeout(() => verifyBtn.current?.focus(), 0) }} />
    </>
  )
}
