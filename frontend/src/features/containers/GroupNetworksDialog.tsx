// Modal «Redes» de un grupo (stack de Compose o grupo propio): cuántas redes propias usa y, de cada una, driver, subred, puerta de enlace y
// los contenedores del grupo conectados con su IP. No muestra las redes del sistema (bridge, host, none). Cierra con Cerrar, Esc o clic fuera.
import { useMemo, useRef } from 'react'
import { Icon } from '@/components/shared/Icon'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { containerName } from '@/data/store/engineStore'
import { useNetworks } from '@/data/store/hooks'
import type { Container } from '@/data/types'
import { safeText } from '@/lib/safeText'
import { groupNetworks } from '../common/netinfo'

export interface NetworksTarget { kind: 'stack' | 'custom'; label: string; containers: Container[] }
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function Body({ group, closeRef, onClose }: { group: NetworksTarget; closeRef: React.RefObject<HTMLButtonElement | null>; onClose(): void }) {
  const { list: networks } = useNetworks()
  const nets = useMemo(() => groupNetworks(group.containers, networks), [group.containers, networks])
  const label = safeText(group.label, { singleLine: true })
  const kind = group.kind === 'custom' ? 'el grupo' : 'el stack'
  return (
    <>
      <div className="dlg-body">
        <span className="dlg-ico"><Icon name="network" size="lg" /></span>
        <div style={{ minWidth: 0 }}>
          <DialogTitle>Redes de {kind} {label}</DialogTitle>
          <DialogDescription render={<p />}>{plural(nets.length, 'red', 'redes')} · {plural(group.containers.length, 'contenedor', 'contenedores')} en el grupo</DialogDescription>
          <div className="net-scroll" tabIndex={0} role="region" aria-label={`Redes de ${label}`}>
            {nets.length === 0 ? <p className="muted">Este grupo no usa redes propias (solo redes del sistema como bridge).</p> : null}
            {nets.map((g) => (
              <section className="net-block" key={g.name} aria-label={`Red ${safeText(g.name, { singleLine: true })}`}>
                <header>
                  <b className="mono">{safeText(g.name, { singleLine: true })}</b>
                  {g.info ? <span className="tag">{safeText(g.info.driver, { singleLine: true })}</span> : null}
                  {g.info ? <span className="tag">{safeText(g.info.scope, { singleLine: true })}</span> : null}
                  {g.info?.internal ? <span className="tag" title="Sin salida a internet">interna</span> : null}
                </header>
                <p className="net-meta">
                  Subred <span className="mono">{g.info?.subnets.length ? g.info.subnets.join(', ') : '—'}</span> · Puerta de enlace <span className="mono">{g.gateway ?? '—'}</span>
                </p>
                <table className="ports-table">
                  <caption className="sr-only">Contenedores de {label} en la red {safeText(g.name, { singleLine: true })}</caption>
                  <thead><tr><th scope="col">Contenedor</th><th scope="col">IPv4</th><th scope="col">IPv6</th><th scope="col">Estado</th></tr></thead>
                  <tbody>
                    {[...g.members].sort((a, b) => containerName(a.c).localeCompare(containerName(b.c))).map(({ c, endpoint }) => (
                      <tr key={c.id}>
                        <td className="mono">{safeText(containerName(c), { singleLine: true })}</td>
                        <td className="mono">{endpoint.ip_address ?? '—'}</td>
                        <td className="mono">{endpoint.ipv6_address ?? '—'}</td>
                        <td><StatusBadge state={c.state} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 'var(--text-xs)', marginTop: 8 }}>No se muestran las redes del sistema (bridge, host, none).</p>
        </div>
      </div>
      <div className="dlg-foot"><Button ref={closeRef} variant="secondary" onClick={onClose}>Cerrar</Button></div>
    </>
  )
}

export function GroupNetworksDialog({ group, onClose }: { group: NetworksTarget | null; onClose(): void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={group !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent initialFocus={closeRef} className="info-dlg">
        {group ? <Body group={group} closeRef={closeRef} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  )
}
