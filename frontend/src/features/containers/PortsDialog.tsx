// Modal con TODOS los puertos abiertos de un contenedor (la tabla solo muestra los 2 principales). Cierra con Cerrar, Esc o clic fuera.
// Cada fila une IPv4/IPv6 del mismo puerto y las tiradas de 3+ puertos consecutivos aparecen como un rango con su cantidad.
import { useMemo, useRef } from 'react'
import { Icon } from '@/components/shared/Icon'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { containerName } from '@/data/store/engineStore'
import type { Container } from '@/data/types'
import { safeText } from '@/lib/safeText'
import { portEntries, portLabel, publishedPorts, totalPorts } from '../common/ports'

export function PortsDialog({ c, onClose }: { c: Container | null; onClose(): void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const entries = useMemo(() => (c ? portEntries(c.ports) : []), [c])
  const total = totalPorts(entries)
  const published = publishedPorts(entries)
  const name = c ? safeText(containerName(c), { singleLine: true }) : ''
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

  return (
    <Dialog open={c !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent initialFocus={closeRef} className="ports-dlg">
        <div className="dlg-body">
          <span className="dlg-ico"><Icon name="network" size="lg" /></span>
          <div style={{ minWidth: 0 }}>
            <DialogTitle>Puertos de {name}</DialogTitle>
            <DialogDescription render={<p />}>
              {plural(total, 'puerto abierto', 'puertos abiertos')} · {plural(published, 'publicado', 'publicados')} en el equipo
              {total > published ? ` · ${plural(total - published, 'solo expuesto', 'solo expuestos')}` : ''}
            </DialogDescription>
            <div className="ports-scroll" tabIndex={0} role="region" aria-label={`Lista de puertos de ${name}`}>
              <table className="ports-table">
                <caption className="sr-only">Puertos abiertos de {name}</caption>
                <thead>
                  <tr>
                    <th scope="col">Equipo</th>
                    <th scope="col">Contenedor</th>
                    <th scope="col">Protocolo</th>
                    <th scope="col">Enlace</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) => (
                    <tr key={`${e.proto}-${e.host ?? 'x'}-${e.container}-${i}`}>
                      <td className="mono">
                        {e.host === null ? '—' : portLabel({ ...e, container: e.host, containerEnd: e.hostEnd ?? e.host, host: null, proto: 'tcp' })}
                        {/* El total de un rango va junto al lado donde se ve el rango: el equipo si está publicado, el contenedor si no. */}
                        {e.host !== null && e.count > 1 ? <small className="muted"> {e.count} puertos</small> : null}
                      </td>
                      <td className="mono">
                        {portLabel({ ...e, host: null, proto: 'tcp' })}
                        {e.host === null && e.count > 1 ? <small className="muted"> {e.count} puertos</small> : null}
                      </td>
                      <td>{e.proto.toUpperCase()}</td>
                      <td>
                        {e.bindings.length ? e.bindings.join(' · ') : <span className="muted" title="El contenedor lo expone pero no está publicado en el equipo">Solo expuesto</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div className="dlg-foot">
          <Button ref={closeRef} variant="secondary" onClick={onClose}>Cerrar</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
