// Pestaña «Registros» de Configuración: registries de imágenes con credenciales (llavero del sistema).
// El secreto (contraseña o token) entra UNA vez por el campo `type=password` y nunca se vuelve a mostrar ni a leer: la lista solo trae servidor y usuario.
// Se limpia del estado del formulario en cuanto se envía. Eliminar pasa por ConfirmDialog (nivel Confirmar). «Probar» solo por gesto del usuario.
import { useEffect, useRef, useState } from 'react'
import { useConfirm } from '@/components/shared/confirmApi'
import { FormDialog } from '@/components/shared/FormDialog'
import { Icon } from '@/components/shared/Icon'
import { SafeName } from '@/components/shared/SafeName'
import { AlertBox, SimulatedTag } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiErrorMessage } from '@/data/errors'
import { useEngineApi, useIsSimulatedWorld } from '@/data/store/hooks'
import type { RegistrySummary } from '@/data/types'
import { safeText } from '@/lib/safeText'
import { toast } from '@/lib/toastStore'

type Test = { state: 'testing' } | { state: 'ok' } | { state: 'fail'; text: string }

export function RegistriesSection({ presetServer }: { presetServer?: string | null }) {
  const api = useEngineApi()
  const confirm = useConfirm()
  const simulated = useIsSimulatedWorld()
  const [rows, setRows] = useState<RegistrySummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, Test>>({})
  const [open, setOpen] = useState(!!presetServer)
  const [server, setServer] = useState(presetServer ?? '')
  const [username, setUsername] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const first = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const [nonce, setNonce] = useState(0)
  const load = () => setNonce((n) => n + 1)
  useEffect(() => {
    let alive = true
    api.registries.list().then((r) => { if (alive) { setRows(r); setLoadError(null) } }).catch((e) => { if (alive) setLoadError(apiErrorMessage(e).detail || apiErrorMessage(e).title) })
    return () => { alive = false }
  }, [api, nonce])

  const close = () => { setOpen(false); setSecret(''); setFormError(null); setBusy(false) }
  const submit = async () => {
    const s = secret
    if (!server.trim() || !username.trim() || !s) { setFormError('Completa servidor, usuario y contraseña o token.'); return }
    setBusy(true)
    setSecret('') // el secreto sale del estado de React en cuanto se envía
    try {
      const r = await api.registries.save({ server: server.trim(), username: username.trim(), secret: s })
      toast.ok('Registro guardado', { sub: `${safeText(r.server, { singleLine: true })} · el secreto quedó en el llavero del sistema` })
      setOpen(false); setBusy(false); setFormError(null); setServer(''); setUsername('')
      load()
    } catch (e) {
      const m = apiErrorMessage(e)
      setFormError(m.detail || m.title)
      setBusy(false)
    }
  }
  const test = async (r: RegistrySummary) => {
    setTests((t) => ({ ...t, [r.id]: { state: 'testing' } }))
    try {
      const res = await api.registries.test(r.id)
      setTests((t) => ({ ...t, [r.id]: res.ok ? { state: 'ok' } : { state: 'fail', text: res.error ? apiErrorMessage(res.error).detail || apiErrorMessage(res.error).title : 'Credenciales rechazadas' } }))
    } catch (e) { setTests((t) => ({ ...t, [r.id]: { state: 'fail', text: apiErrorMessage(e).detail || apiErrorMessage(e).title } })) }
  }
  const remove = async (r: RegistrySummary) => {
    const ok = await confirm({
      level: 'confirm', title: 'Eliminar credenciales del registro',
      description: <p>Se borrarán de DockInng y del llavero las credenciales de <b><SafeName mono>{r.server}</SafeName></b> (usuario <SafeName>{r.username}</SafeName>). Las imágenes ya descargadas no se tocan.</p>,
      levelNote: <><b>Nivel Confirmar.</b> Para volver a descargar imágenes privadas tendrás que añadirlas otra vez.</>, okLabel: 'Eliminar credenciales', okIcon: 'trash',
    })
    if (!ok) return
    try { await api.registries.remove(r.id, true); toast.ok('Credenciales eliminadas'); load() } catch (e) { const m = apiErrorMessage(e); toast.err(m.title, { sub: m.detail }) }
  }

  return (
    <section aria-labelledby="sReg">
      <h2 className="section-title" id="sReg">Registros de imágenes {simulated ? <SimulatedTag /> : null}</h2>
      <p className="muted text-[length:var(--text-xs)] mb-2" >Credenciales para descargar imágenes privadas. La contraseña o el token se guarda en el llavero del sistema, entra una sola vez y <b>no se vuelve a mostrar</b>. «Probar» se hace con el motor activo: con una conexión TLS directa solo funciona con el socket local o un túnel SSH.</p>
      {loadError ? <AlertBox kind="error" icon="alert" title="No se pudieron leer los registros" text={loadError} actions={<Button variant="secondary" size="sm" onClick={load}><Icon name="refresh" size="sm" />Reintentar</Button>} /> : null}
      <div className="card">
        {rows === null && !loadError ? <div className="setting-row"><span className="muted">Cargando…</span></div> : null}
        {rows?.length === 0 ? <div className="setting-row"><div className="grow"><b>Sin registros</b><small>Añade uno para descargar imágenes privadas (ghcr.io, registry.gitlab.com, etc.).</small></div></div> : null}
        {rows?.map((r) => {
          const t = tests[r.id]
          return (
            <div className="setting-row reg-row" key={r.id}>
              <div className="grow">
                <b className="mono"><SafeName ellipsis>{r.server}</SafeName></b>
                <small>Usuario <SafeName>{r.username}</SafeName> · contraseña en el llavero</small>
                {t?.state === 'ok' ? <small role="status" className="text-status-running"><Icon name="check" size="sm" /> Credenciales válidas</small> : null}
                {t?.state === 'fail' ? <small role="status" className="text-status-dead"><Icon name="alert" size="sm" /> {safeText(t.text, { singleLine: true })}</small> : null}
              </div>
              <Button variant="secondary" size="sm" disabled={t?.state === 'testing'} onClick={() => void test(r)}><Icon name={t?.state === 'testing' ? 'loader' : 'zap'} size="sm" spin={t?.state === 'testing'} />Probar</Button>
              <Button variant="outline-destructive" size="sm" aria-label={`Eliminar las credenciales de ${safeText(r.server, { singleLine: true })}`} onClick={() => void remove(r)}><Icon name="trash" size="sm" />Eliminar</Button>
            </div>
          )
        })}
      </div>
      <div className="mt-2.5"><Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" />Añadir registro</Button></div>

      <FormDialog open={open} onClose={close} title="Añadir registro" icon="lock" submitLabel="Guardar en el llavero" submitIcon="lock" busy={busy} formError={formError} initialFocus={first} onSubmit={() => void submit()}
        description={<p>El secreto se envía una sola vez al llavero del sistema y no se puede volver a ver.</p>}>
        <div className="f-row"><label htmlFor="rgServer">Servidor</label><Input ref={first} id="rgServer" value={server} placeholder="ghcr.io" autoCapitalize="none" spellCheck={false} onChange={(e) => setServer(e.target.value)} /><span className="f-hint">Docker Hub: <code>docker.io</code>.</span></div>
        <div className="f-row"><label htmlFor="rgUser">Usuario</label><Input id="rgUser" value={username} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(e) => setUsername(e.target.value)} /></div>
        <div className="f-row"><label htmlFor="rgSecret">Contraseña o token de acceso</label><Input id="rgSecret" type="password" value={secret} autoComplete="new-password" onChange={(e) => setSecret(e.target.value)} /><span className="f-hint">Mejor un token con permisos de solo lectura.</span></div>
      </FormDialog>
    </section>
  )
}
