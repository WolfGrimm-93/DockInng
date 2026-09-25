// Vista «Nueva conexión» (#conn-new?test=testing|ok|fail). SIMULADA: probar/guardar aún no están conectados al motor
// (marca «No conectado aún»); en Tauri «Guardar» no persiste nada y lo dice.
import { safeText } from '@/lib/safeText'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { devFlagsEnabled } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { Icon } from '@/components/shared/Icon'
import { PageHeader } from '@/components/shared/PageHeader'
import { Segmented } from '@/components/shared/Segmented'
import { AlertBox } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiErrorMessage } from '@/data/errors'
import { useEngineApi, useEngineStoreApi, useIsSimulatedWorld } from '@/data/store/hooks'
import type { ConnSpec } from '@/data/types'
import { toast } from '@/lib/toastStore'
import { LinkButton } from '../common/LinkButton'

type Kind = 'ssh' | 'tls'
type Test = null | 'testing' | 'ok' | 'fail'

export default function ConnNewPage() {
  const route = useHashRoute()
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const browserWorld = useIsSimulatedWorld()
  const preset = devFlagsEnabled(api) ? (route.params.get('test') as Test) : null
  const [kind, setKind] = useState<Kind>('ssh')
  const [name, setName] = useState('')
  const [host, setHost] = useState('staging-lab')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('ops')
  const [key, setKey] = useState('~/.ssh/config (alias)')
  const [ca, setCa] = useState('~/.docker/ca.pem')
  const [cert, setCert] = useState('~/.docker/cert.pem')
  const [keyT, setKeyT] = useState('~/.docker/key.pem')
  const [test, setTest] = useState<Test>(preset === 'testing' || preset === 'ok' || preset === 'fail' ? preset : null)
  const seq = useRef(0)
  const ssh = kind === 'ssh'

  const spec = (): ConnSpec => ({ kind, name, host, port: ssh ? port : port === '22' ? '2376' : port, user: ssh ? user : '', key: ssh ? key : keyT })
  const runTest = async () => {
    const n = ++seq.current
    setTest('testing')
    try {
      const r = await api.connections.test(spec())
      if (n === seq.current) setTest(r)
    } catch (e) {
      if (n === seq.current) { setTest('fail'); toast.err(apiErrorMessage(e).title, { sub: apiErrorMessage(e).detail }) }
    }
  }
  const pickKind = (k: Kind) => { seq.current++; setKind(k); setTest(null); if (k === 'tls' && port === '22') setPort('2376'); if (k === 'ssh' && port === '2376') setPort('22') }
  useEffect(() => () => { seq.current++ }, [])

  const save = async (e: FormEvent) => {
    e.preventDefault()
    try {
      const p = await api.connections.save(spec())
      if (browserWorld) {
        store.setState({ profiles: await api.connection.profiles() })
        toast.ok('Conexión guardada', { sub: safeText(p.name, { singleLine: true }) })
        route.go('settings')
      } else {
        toast.warn('Simulado — no conectado aún', { sub: 'La conexión no se guardó: el alta de conexiones remotas todavía no está conectada.' })
      }
    } catch (ex) {
      const m = apiErrorMessage(ex)
      toast.err(m.title, { sub: m.detail })
    }
  }

  return (
    <>
      <PageHeader title="Nueva conexión" back={{ href: route.href('settings'), label: 'Configuración' }} simulated />
      <div className="view-body">
        <form className="form" id="connForm" noValidate onSubmit={(e) => void save(e)}>
          <section className="card form-section">
            <h2>Datos de la conexión</h2>
            <div className="form-body">
              <div className="f-row">
                <span className="f-label" id="lType">Tipo</span>
                <Segmented<Kind> labelledBy="lType" style={{ justifySelf: 'start' }} value={kind} onChange={pickKind} options={[{ value: 'ssh', label: 'SSH' }, { value: 'tls', label: 'TLS (tcp://)' }]} />
              </div>
              <div className="f-cols">
                <div className="f-row"><label htmlFor="cName">Nombre</label><Input id="cName" value={name} placeholder="prod-hetzner" onChange={(e) => setName(e.target.value)} /></div>
                <div className="f-row"><label htmlFor="cHost">{ssh ? 'Host o alias de ~/.ssh/config' : 'Host'}</label><Input id="cHost" value={host} onChange={(e) => setHost(e.target.value)} /></div>
                <div className="f-row"><label htmlFor="cPort">Puerto</label><Input id="cPort" value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value)} /></div>
                {ssh ? (
                  <div className="f-row"><label htmlFor="cUser">Usuario</label><Input id="cUser" value={user} onChange={(e) => setUser(e.target.value)} /></div>
                ) : (
                  <div className="f-row"><label htmlFor="cCa">Certificado CA</label><Input className="mono" id="cCa" value={ca} onChange={(e) => setCa(e.target.value)} /></div>
                )}
              </div>
              {ssh ? (
                <div className="f-row">
                  <label htmlFor="cKey">Llave</label>
                  <Input className="mono" id="cKey" value={key} onChange={(e) => setKey(e.target.value)} />
                  <span className="f-hint">Recomendado: usar el alias de ~/.ssh/config, que ya sabe qué llave usar.</span>
                </div>
              ) : (
                <div className="f-cols">
                  <div className="f-row"><label htmlFor="cCert">Certificado cliente</label><Input className="mono" id="cCert" value={cert} onChange={(e) => setCert(e.target.value)} /></div>
                  <div className="f-row"><label htmlFor="cKeyT">Llave cliente</label><Input className="mono" id="cKeyT" value={keyT} onChange={(e) => setKeyT(e.target.value)} /></div>
                </div>
              )}
            </div>
          </section>
          <div id="connRes" aria-live="polite">
            {test === 'testing' ? (
              <div className="alert alert-info" role="status"><Icon name="loader" spin /><div><b>Probando conexión…</b><p>Comprobando red, autenticación y socket remoto.</p></div></div>
            ) : test === 'ok' ? (
              <AlertBox kind="info" icon="check" title="Conexión correcta" text="Docker 26.1.4 · API 1.45 · 8 contenedores en ejecución. Puedes guardarla." />
            ) : test === 'fail' ? (
              <AlertBox kind="error" icon="alert" title="No se pudo conectar" text={ssh ? 'Permission denied (publickey). El servidor no aceptó la llave. Comprueba el alias en ~/.ssh/config y que la llave esté cargada (ssh-add).' : 'El certificado del servidor no coincide con la CA indicada.'} />
            ) : null}
          </div>
          <div className="form-actions">
            <Button type="button" variant="secondary" disabled={test === 'testing'} onClick={() => void runTest()}><Icon name="zap" />Probar conexión</Button>
            <Button type="submit" variant="primary" disabled={test === 'fail'}><Icon name="check" />Guardar conexión</Button>
            <LinkButton variant="ghost" href={route.href('settings')}>Cancelar</LinkButton>
            {test === null ? <span className="muted" style={{ alignSelf: 'center' }}>Sin probar todavía.</span> : null}
          </div>
        </form>
      </div>
    </>
  )
}
