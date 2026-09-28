// Pestaña «Conexiones» de Configuración: lista de conexiones (Local real + SSH/TLS guardadas), con insignias (Activa, Remota, SSH/TLS, Podman,
// Simulada) y borrado con confirmación. La conexión activa y la local no se pueden borrar.
import { safeText } from '@/lib/safeText'
import { useConfirm } from '@/components/shared/confirmApi'
import { useHashRoute } from '@/app/useHashRoute'
import { Icon } from '@/components/shared/Icon'
import { SafeName } from '@/components/shared/SafeName'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/buttonVariants'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { apiErrorMessage } from '@/data/errors'
import { useConnection, useEngineStore, useEngineStoreApi, useEngineApi } from '@/data/store/hooks'
import type { ConnectionProfile } from '@/data/types'
import { toast } from '@/lib/toastStore'
import { isPodmanTarget } from './podman'

export function ConnectionsSection() {
  const conn = useConnection()
  const route = useHashRoute()
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const confirm = useConfirm()
  const switching = useEngineStore((s) => s.switchingProfileId)

  const remove = async (p: ConnectionProfile) => {
    const ok = await confirm({
      level: 'confirm', title: 'Eliminar conexión',
      description: <p>Se eliminará la conexión <b><SafeName>{p.name}</SafeName></b> (<span className="mono">{safeText(p.target, { singleLine: true })}</span>) y sus grupos asignados. No se toca el servidor ni sus contenedores.</p>,
      levelNote: <><b>Nivel Confirmar.</b> Se conserva la huella de host confiada solo si vuelves a crearla.</>, okLabel: 'Eliminar conexión', okIcon: 'trash',
    })
    if (!ok) return
    try {
      await api.connections.remove(p.id, true)
      toast.ok('Conexión eliminada', { sub: safeText(p.name, { singleLine: true }) })
      await store.getState().refreshProfiles()
    } catch (e) { const m = apiErrorMessage(e); toast.err(m.title, { sub: m.detail }) }
  }

  return (
    <section aria-labelledby="sConn">
      <h2 className="section-title" id="sConn">Conexiones</h2>
      <div className="card">
        {conn.profiles.map((p) => {
          const active = p.id === conn.profile.id
          const label = safeText(p.name, { singleLine: true })
          return (
            <div className={`conn${active ? ' is-active' : ''}`} key={p.id}>
              <span className="conn-ico"><Icon name={p.icon} /></span>
              <div className="grow">
                <b>{label}</b>{' '}
                {active ? <span className="tag tag-brand">Activa</span> : p.failsToConnect ? <span className="tag" style={{ color: 'var(--status-dead)' }}><Icon name="alert" size="sm" />Sin respuesta</span> : null}
                {p.remote ? <> <span className="tag"><Icon name="globe" size="sm" />Remota · {p.kind.toUpperCase()}</span></> : <> <span className="tag">Local</span></>}
                {isPodmanTarget(p) ? <> <span className="tag">Podman</span></> : null}
                {p.simulated ? <> <span className="tag" title="Conexión de ejemplo: solo existe en el modo simulado (navegador)."><Icon name="flask" size="sm" />Simulada</span></> : null}
                <small>{safeText(p.target, { singleLine: true })}</small>
                {p.host_key_fp ? <small title="Huella SHA256 de la clave de host confiada">Huella {safeText(p.host_key_fp, { singleLine: true })}</small> : null}
              </div>
              {active ? null : <Button variant="secondary" size="sm" disabled={!!switching} aria-busy={switching === p.id || undefined} onClick={() => conn.select(p.id)}>{switching === p.id ? <><Icon name="loader" size="sm" spin />Conectando…</> : 'Conectar'}</Button>}
              {p.id === 'local' ? null : (
                <DropdownMenu>
                  <DropdownMenuTrigger className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} aria-label={`Más opciones de ${label}`}><Icon name="dots" /></DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem disabled={active || !p.spec} onClick={() => p.spec && !active && route.go('conn-new', { id: p.id })}><Icon name="edit" />{active ? 'Editar (cambia de conexión antes)' : 'Editar'}</DropdownMenuItem>
                    <DropdownMenuItem disabled={active} onClick={() => void remove(p)}><Icon name="trash" />{active ? 'Eliminar (cambia de conexión antes)' : 'Eliminar…'}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
