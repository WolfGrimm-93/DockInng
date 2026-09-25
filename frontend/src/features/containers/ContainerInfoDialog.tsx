// Modal de un contenedor con dos pestañas: PUERTOS (todos los abiertos; la tabla solo muestra los 2 principales) e IPS (una fila por red
// con IPv4, IPv6, puerta de enlace, MAC y alias de DNS). Se abre con el ojo de cada fila y del detalle. Cierra con Cerrar, Esc o clic fuera.
// La IP sale del listado; los alias de DNS solo los da `inspect`, así que la pestaña IPs pide el detalle al abrirse (una llamada).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@/components/shared/Icon'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { containerName } from '@/data/store/engineStore'
import { useEngineApi } from '@/data/store/hooks'
import type { Container, ContainerDetail } from '@/data/types'
import { safeText } from '@/lib/safeText'
import { endpointsOf, hasIp } from '../common/netinfo'
import { portEntries, portLabel, publishedPorts, totalPorts } from '../common/ports'

export type InfoTab = 'ports' | 'ips'
export interface InfoTarget { c: Container; tab: InfoTab }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function PortsPanel({ c }: { c: Container }) {
  const entries = useMemo(() => portEntries(c.ports), [c.ports])
  if (!entries.length) return <p className="muted">Este contenedor no expone puertos.</p>
  const name = safeText(containerName(c), { singleLine: true })
  return (
    <div className="ports-scroll" tabIndex={0} role="region" aria-label={`Lista de puertos de ${name}`}>
      <table className="ports-table">
        <caption className="sr-only">Puertos abiertos de {name}</caption>
        <thead>
          <tr><th scope="col">Equipo</th><th scope="col">Contenedor</th><th scope="col">Protocolo</th><th scope="col">Enlace</th></tr>
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
              <td>{e.bindings.length ? e.bindings.join(' · ') : <span className="muted" title="El contenedor lo expone pero no está publicado en el equipo">Solo expuesto</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function IpsPanel({ c }: { c: Container }) {
  const api = useEngineApi()
  // null = cargando · 'error' = no se pudo leer el detalle (se muestra sin alias).
  const [detail, setDetail] = useState<ContainerDetail | 'error' | null>(null)
  useEffect(() => {
    let dead = false
    api.containers.inspect(c.id).then((d) => { if (!dead) setDetail(d) }).catch(() => { if (!dead) setDetail('error') })
    return () => { dead = true }
  }, [api, c.id])

  const eps = endpointsOf(c)
  const name = safeText(containerName(c), { singleLine: true })
  const aliasesOf = (net: string): string[] | null => (detail && detail !== 'error' ? (detail.networks.find((n) => n.name === net)?.aliases ?? []) : null)

  if (!eps.length) return <p className="muted">No está conectado a ninguna red (red «none»).</p>
  return (
    <>
      {eps.some((e) => e.name === 'host') ? (
        <p className="info-note"><Icon name="info" size="sm" /> Usa la red del equipo (<code>host</code>): comparte la IP del equipo y no tiene una propia.</p>
      ) : !hasIp(c) ? (
        <p className="info-note"><Icon name="info" size="sm" /> Está detenido, así que no tiene IP asignada. Docker le dará una al iniciarlo y puede ser distinta.</p>
      ) : null}
      <div className="ports-scroll" tabIndex={0} role="region" aria-label={`IPs por red de ${name}`}>
        <table className="ports-table">
          <caption className="sr-only">IPs por red de {name}</caption>
          <thead>
            <tr>
              <th scope="col">Red</th><th scope="col">IPv4</th><th scope="col">IPv6</th><th scope="col">Puerta de enlace</th><th scope="col">MAC</th>
              <th scope="col">Alias de DNS</th>
            </tr>
          </thead>
          <tbody>
            {eps.map((e) => {
              const al = aliasesOf(e.name)
              return (
                <tr key={e.name}>
                  <td className="mono">{safeText(e.name, { singleLine: true })}</td>
                  <td className="mono">{e.ip_address ?? '—'}</td>
                  <td className="mono">{e.ipv6_address ?? '—'}</td>
                  <td className="mono">{e.gateway ?? '—'}</td>
                  <td className="mono">{e.mac_address ?? '—'}</td>
                  <td className="alias-cell">
                    {al === null && detail !== 'error' ? <small className="muted" role="status">cargando…</small>
                      : al && al.length ? al.map((a) => <span className="alias mono" key={a}>{safeText(a, { singleLine: true })}</span>)
                      : <span className="muted" title={detail === 'error' ? 'No se pudieron leer los alias' : 'Sin alias en esta red'}>—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Body({ c, initialTab, closeRef, onClose }: { c: Container; initialTab: InfoTab; closeRef: React.RefObject<HTMLButtonElement | null>; onClose(): void }) {
  const [tab, setTab] = useState<InfoTab>(initialTab)
  const name = safeText(containerName(c), { singleLine: true })
  const entries = useMemo(() => portEntries(c.ports), [c.ports])
  const total = totalPorts(entries)
  const nets = endpointsOf(c).length
  return (
    <>
      <div className="dlg-body">
        <span className="dlg-ico"><Icon name="network" size="lg" /></span>
        <div style={{ minWidth: 0 }}>
          <DialogTitle>Puertos e IPs de {name}</DialogTitle>
          <DialogDescription render={<p />}>
            {plural(total, 'puerto abierto', 'puertos abiertos')}{total ? ` · ${plural(publishedPorts(entries), 'publicado', 'publicados')} en el equipo` : ''} · {plural(nets, 'red', 'redes')}
          </DialogDescription>
          <Tabs value={tab} onValueChange={(v) => setTab(v as InfoTab)} className="info-tabs">
            <TabsList aria-label={`Secciones de ${name}`}>
              <TabsTab value="ports"><Icon name="network" size="sm" />Puertos</TabsTab>
              <TabsTab value="ips"><Icon name="globe" size="sm" />IPs</TabsTab>
            </TabsList>
            <TabsPanel value="ports" className="info-panel"><PortsPanel c={c} /></TabsPanel>
            <TabsPanel value="ips" className="info-panel"><IpsPanel c={c} /></TabsPanel>
          </Tabs>
        </div>
      </div>
      <div className="dlg-foot"><Button ref={closeRef} variant="secondary" onClick={onClose}>Cerrar</Button></div>
    </>
  )
}

export function ContainerInfoDialog({ target, onClose }: { target: InfoTarget | null; onClose(): void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={target !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent initialFocus={closeRef} className="info-dlg">
        {target ? <Body key={`${target.c.id}:${target.tab}`} c={target.c} initialTab={target.tab} closeRef={closeRef} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  )
}
