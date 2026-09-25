// Vista «Configuración» (siempre disponible, aun sin conexión al motor). Contiene:
//   Conexiones (local REAL; el resto SIMULADAS y marcadas «No conectado aún») · Apariencia (<AppearanceSection/>, de la base) ·
//   Datos (sondeo de respaldo, apagado por defecto: real) · Niveles de seguridad · Acción prohibida · Vista previa de estados (solo simulado/DEV).
import { safeText } from '@/lib/safeText'
import { devFlagsEnabled, setComposeMissing, setPreviewState } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { useGuardedAction } from '@/components/shared/ConfirmDialog'
import { Icon } from '@/components/shared/Icon'
import type { IconName } from '@/components/shared/iconNames'
import { PageHeader } from '@/components/shared/PageHeader'
import { AlertBox } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/checkbox'
import { useConnection, useEngineApi, useEngineStore, useEngineStoreApi } from '@/data/store/hooks'
import type { ConnectionIssue } from '@/data/types'
import { policyDenied, toast } from '@/lib/toastStore'
import { LinkButton } from '../common/LinkButton'
import { AppearanceSection } from './AppearanceSection'

const LEVELS: { title: string; cls: 'libre' | 'confirmar' | 'bloqueado'; label: string; text: string; icon: IconName }[] = [
  { title: 'Iniciar, detener, reiniciar, ver logs', cls: 'libre', label: 'Libre', text: 'Allow: se ejecuta al instante, sin diálogo.', icon: 'check' },
  { title: 'Eliminar contenedor, imagen o red', cls: 'confirmar', label: 'Confirmar', text: 'Confirm: diálogo con lo que se verá afectado.', icon: 'warn' },
  { title: 'Eliminar volumen, volúmenes sin usar, bajar stack', cls: 'confirmar', label: 'Confirmar con nombre', text: 'Confirm reforzado: hay que escribir el nombre o ELIMINAR. Exige a una persona incluso con «omitir confirmaciones».', icon: 'warn' },
  { title: 'Limpiar todo el sistema (system prune)', cls: 'bloqueado', label: 'Bloqueado', text: 'Deny · Forbidden: nunca se ejecuta, ni con confirmación.', icon: 'ban' },
]

type Preview =
  | { kind: 'ui'; val: 'empty' | 'loading' }
  | { kind: 'err'; val: ConnectionIssue }
  | { kind: 'compose' }
  | { kind: 'policy' }
  | { kind: 'toast'; val: 'ok' | 'warn' | 'err' }
const PREVIEWS: { p: Preview; label: string }[] = [
  { p: { kind: 'ui', val: 'empty' }, label: 'Estado vacío' },
  { p: { kind: 'ui', val: 'loading' }, label: 'Esqueleto de carga' },
  { p: { kind: 'err', val: 'permission' }, label: 'Error: sin permiso al socket' },
  { p: { kind: 'err', val: 'daemon' }, label: 'Error: daemon apagado' },
  { p: { kind: 'err', val: 'ssh' }, label: 'Error: SSH' },
  { p: { kind: 'err', val: 'lost' }, label: 'Desconectado durante el uso' },
  { p: { kind: 'compose' }, label: 'Compose no instalado' },
  { p: { kind: 'policy' }, label: 'Rechazo inesperado del backend' },
  { p: { kind: 'toast', val: 'ok' }, label: 'Toast correcto' },
  { p: { kind: 'toast', val: 'warn' }, label: 'Toast aviso' },
  { p: { kind: 'toast', val: 'err' }, label: 'Toast error' },
]

export default function SettingsPage() {
  const route = useHashRoute()
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const conn = useConnection()
  const guard = useGuardedAction()
  const polling = useEngineStore((s) => s.polling)
  const dev = devFlagsEnabled(api)

  const applyPreview = (p: Preview) => {
    // AppShell limpia la vista previa al cambiar de ruta: se aplica justo después de navegar.
    const after = (fn: () => void) => window.setTimeout(fn, 60)
    if (p.kind === 'ui') { route.go('containers'); after(() => setPreviewState(p.val)) }
    else if (p.kind === 'err') { route.go('containers'); after(() => store.getState().previewConnection(p.val)) }
    else if (p.kind === 'compose') { route.go('stacks'); after(() => setComposeMissing(true)) }
    else if (p.kind === 'policy') policyDenied('Eliminar imagen', 'PolicyDenied: la imagen ghcr.io/casaluna/tienda-api:2.4.1 la usa tienda-api-1. La interfaz la mostraba como eliminable: es un fallo de la app, no tuyo.')
    else if (p.val === 'ok') toast.ok('Contenedor iniciado')
    else if (p.val === 'warn') toast.warn('Imagen sin usar desde hace 30 días')
    else toast.err('No se pudo eliminar la red', { sub: 'La red «tienda_default» tiene contenedores conectados.' })
  }

  return (
    <>
      <PageHeader
        title="Configuración"
        count={`${conn.profiles.length} conexiones`}
        primary={<LinkButton variant="primary" href={route.href('conn-new')}><Icon name="plus" />Añadir conexión</LinkButton>}
      />
      <div className="view-body">
        {conn.state.status === 'error' || conn.state.status === 'lost' ? (
          <AlertBox kind="error" icon="alert" title="Sin conexión con el motor" text="Puedes editar las conexiones desde aquí; el resto de vistas muestran el diagnóstico." />
        ) : null}

        <section aria-labelledby="sConn">
          <h2 className="section-title" id="sConn">Conexiones</h2>
          <div className="card">
            {conn.profiles.map((p) => {
              const active = p.id === conn.profile.id
              return (
                <div className={`conn${active ? ' is-active' : ''}`} key={p.id}>
                  <span className="conn-ico"><Icon name={p.icon} /></span>
                  <div className="grow">
                    <b>{safeText(p.name, { singleLine: true })}</b>{' '}
                    {active ? <span className="tag tag-brand">Activa</span> : p.failsToConnect ? <span className="tag" style={{ color: 'var(--status-dead)' }}><Icon name="alert" size="sm" />Sin respuesta</span> : null}
                    {p.simulated ? <> <span className="tag" title="Conexión de ejemplo: todavía no está conectada al motor."><Icon name="flask" size="sm" />No conectado aún</span></> : null}
                    <small>{safeText(p.target, { singleLine: true })}</small>
                  </div>
                  {active ? null : <Button variant="secondary" size="sm" onClick={() => conn.select(p.id)}>Conectar</Button>}
                  <Button variant="ghost" size="icon-sm" aria-label={`Más opciones de ${safeText(p.name, { singleLine: true })}`} onClick={() => toast.warn('Simulado — no conectado aún', { sub: 'Las opciones por conexión todavía no están disponibles.' })}><Icon name="dots" /></Button>
                </div>
              )
            })}
          </div>
        </section>

        <div className="grid-2">
          <div style={{ display: 'grid', gap: 16, alignContent: 'start', minWidth: 0 }}>
            <AppearanceSection />
            <section aria-labelledby="sData">
              <h2 className="section-title" id="sData">Datos</h2>
              <div className="card">
                <div className="setting-row">
                  <div className="grow"><b>Datos en tiempo real</b><small>La app se actualiza con los eventos del motor de Docker, sin sondear.</small></div>
                  <span className="tag">Automático</span>
                </div>
                <div className="setting-row">
                  <div className="grow"><b>Respaldo: sondeo cada 5 s</b><small>Solo si los eventos fallan (por ejemplo, a través de algunos túneles SSH).</small></div>
                  <Switch aria-label="Respaldo: sondeo cada 5 segundos" checked={polling} onChange={(e) => store.getState().setPolling(e.target.checked)} />
                </div>
              </div>
            </section>
          </div>

          <section aria-labelledby="sSec">
            <h2 className="section-title" id="sSec">Niveles de seguridad</h2>
            <div className="card">
              {LEVELS.map((l) => (
                <div className="setting-row" key={l.title}>
                  <div className="grow"><b>{l.title}</b><small>{l.text}</small></div>
                  <span className={`level level-${l.cls}`}><Icon name={l.icon} size="sm" />{l.label}</span>
                </div>
              ))}
            </div>
            <p className="muted" style={{ fontSize: 'var(--text-xs)', marginTop: 6 }}>El caso «Denegado sin interacción» de la política solo existe en la línea de comandos; en la interfaz gráfica no aplica.</p>
          </section>
        </div>

        <section aria-labelledby="sRisk">
          <h2 className="section-title" id="sRisk">Acción prohibida (demostración)</h2>
          <div className="card">
            <div className="setting-row">
              <div className="grow">
                <b>Limpiar todo el sistema</b>
                <small>Equivale a <code>docker system prune</code>. Se muestra solo para explicar por qué no está disponible: borra contenedores, redes, imágenes y caché de una sola vez, sin poder revisar qué se pierde. Nunca se ejecuta.</small>
              </div>
              <Button variant="blocked" aria-haspopup="dialog" onClick={() => void guard({ type: 'prune_system' })}><Icon name="ban" />Limpiar todo el sistema</Button>
            </div>
          </div>
        </section>

        {dev ? (
          <section aria-labelledby="sPrev">
            <h2 className="section-title" id="sPrev">Vista previa de estados <span className="tag">Solo plantilla</span></h2>
            <div className="card card-pad" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {PREVIEWS.map((x) => <Button key={x.label} variant="secondary" size="sm" onClick={() => applyPreview(x.p)}>{x.label}</Button>)}
              <LinkButton variant="secondary" size="sm" href={route.href('create')}>Nuevo contenedor</LinkButton>
              <LinkButton variant="secondary" size="sm" href={route.href('pull', { pull: 'running' })}>Descarga en curso</LinkButton>
              <LinkButton variant="secondary" size="sm" href={route.href('stack-edit', { yaml: 'broken', run: 'up' })}>Editor con errores</LinkButton>
              <LinkButton variant="secondary" size="sm" href={route.href('conn-new', { test: 'fail' })}>Prueba de conexión fallida</LinkButton>
            </div>
          </section>
        ) : null}
      </div>
    </>
  )
}
