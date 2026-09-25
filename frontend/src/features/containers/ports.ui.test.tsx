import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { Container, PortMapping } from '@/data/types'
import { fullId } from '@/data/adapters/sim/fixtures'
import { makeApi, renderView, resetGlobals } from '../testUtils'
import { useGroupsStore } from '../groups/groupsStore'
import ContainerDetailPage from './ContainerDetailPage'
import ContainersPage from './ContainersPage'

afterEach(resetGlobals)

const pub = (host: number, container = host, proto = 'tcp', ip: string | null = '0.0.0.0'): PortMapping => ({ ip, private_port: container, public_port: host, protocol: proto })
const exposed = (container: number, proto = 'tcp'): PortMapping => ({ ip: null, private_port: container, public_port: null, protocol: proto })

/** Como el `screego-prod-server` real: rango udp de 90 puertos en IPv4 e IPv6 + tcp sueltos + expuestos sin publicar. */
function screegoPorts(): PortMapping[] {
  const p: PortMapping[] = [exposed(3478), exposed(5050), exposed(3478, 'udp')]
  for (const port of [55100, 55101]) p.push(pub(port, port, 'tcp', '0.0.0.0'), pub(port, port, 'tcp', '::'))
  for (let port = 55110; port <= 55199; port++) p.push(pub(port, port, 'udp', '0.0.0.0'), pub(port, port, 'udp', '::'))
  return p
}
const heavy = (name: string, ports: PortMapping[], state: Container['state'] = 'running'): Container => ({
  id: fullId('9'.repeat(12)), names: [name], image: 'screego/server:1.10', image_id: 'sha256:' + '0'.repeat(64), state, status: 'Up 1 hour', created: 1,
  compose_project: null, compose_service: null, ports, mounts: [], networks: [],
})
async function withHeavy() {
  const api = makeApi()
  api.sim.world.containers.push(heavy('screego-prod-server', screegoPorts()))
  return api
}
const rowOf = (name: string) => screen.getByRole('link', { name }).closest('tr') as HTMLElement

describe('puertos: principales en la tabla y todos en el modal', () => {
  it('con más de 2 puertos aparece el ojo y la tabla muestra solo los 2 principales; con 2 o menos no hay ojo', async () => {
    renderView(<ContainersPage />, { api: await withHeavy() })
    await screen.findByRole('link', { name: 'screego-prod-server' })
    const row = rowOf('screego-prod-server')
    // 189 entradas de la API → los 2 principales (publicados, tcp, número menor).
    expect(row.querySelector('.col-ports')?.textContent).toBe('55100, 55101')
    const eye = within(row).getByRole('button', { name: /^Ver los \d+ puertos de screego-prod-server$/ })
    expect(eye).toHaveAttribute('aria-haspopup', 'dialog')
    // Nada de la lista larga en la fila.
    expect(row.textContent).not.toContain('55110')
    // Contenedores con 1 o 2 puertos: sin ojo (minio-dev tiene 9000 y 9001; traefik 80 y 443).
    expect(within(rowOf('minio-dev')).queryByRole('button', { name: /Ver los .* puertos/ })).toBeNull()
    expect(within(rowOf('traefik-proxy')).queryByRole('button', { name: /Ver los .* puertos/ })).toBeNull()
    expect(rowOf('minio-dev').querySelector('.col-ports')?.textContent).toBe('9000, 9001')
  })

  it('el ojo abre el modal con TODOS los puertos (IPv4/IPv6 unidos y rangos colapsados) y Esc lo cierra devolviendo el foco', async () => {
    const u = userEvent.setup()
    renderView(<ContainersPage />, { api: await withHeavy() })
    await screen.findByRole('link', { name: 'screego-prod-server' })
    const eye = within(rowOf('screego-prod-server')).getByRole('button', { name: /Ver los .* puertos/ })
    await u.click(eye)
    const dlg = await screen.findByRole('dialog', { name: 'Puertos de screego-prod-server' })
    // 3 expuestos + 2 tcp + 90 udp + 0 duplicados (IPv4 e IPv6 unidos) = 95 puertos; 92 publicados; 3 solo expuestos.
    expect(within(dlg).getByText(/95 puertos abiertos · 92 publicados en el equipo · 3 solo expuestos/)).toBeInTheDocument()
    const rows = within(dlg).getAllByRole('row').slice(1)
    expect(rows.length).toBeLessThanOrEqual(8) // 189 entradas → pocas filas
    const text = rows.map((r) => r.textContent ?? '')
    expect(text.some((t) => t.includes('55110–55199') && t.includes('90 puertos') && t.includes('UDP'))).toBe(true)
    expect(text.some((t) => t.includes('55100') && t.includes('TCP') && t.includes('IPv4 · IPv6'))).toBe(true)
    expect(text.filter((t) => t.includes('Solo expuesto')).length).toBe(3)
    // Foco inicial en «Cerrar»; Esc cierra y el foco vuelve al ojo.
    expect(within(dlg).getByRole('button', { name: 'Cerrar' })).toHaveFocus()
    await u.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(eye).toHaveFocus()
  })

  it('la búsqueda sigue encontrando un puerto que no se ve en la tabla (dentro de un rango)', async () => {
    const u = userEvent.setup()
    renderView(<ContainersPage />, { api: await withHeavy() })
    await screen.findByRole('link', { name: 'screego-prod-server' })
    await u.type(screen.getByRole('searchbox'), '55150')
    expect(screen.getByRole('link', { name: 'screego-prod-server' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'tienda-api-1' })).toBeNull()
  })

  it('«Cerrar» y el clic en el botón cierran el modal; el modal muestra el nombre como texto (sin inyectar HTML)', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    api.sim.world.containers.push(heavy('<b>x</b>-web', [pub(80), pub(443), pub(8080)]))
    renderView(<ContainersPage />, { api })
    await screen.findByRole('link', { name: '<b>x</b>-web' })
    await u.click(screen.getByRole('button', { name: /Ver los 3 puertos de <b>x<\/b>-web/ }))
    const dlg = await screen.findByRole('dialog')
    expect(dlg.querySelector('b')).toBeNull()
    await u.click(within(dlg).getByRole('button', { name: 'Cerrar' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('detalle: la línea de puertos muestra los 2 principales y el ojo abre el mismo modal', async () => {
    const u = userEvent.setup()
    const api = await withHeavy()
    renderView(<ContainerDetailPage />, { api, hash: '#detail?c=screego-prod-server' })
    const eye = await screen.findByRole('button', { name: /Ver los .* puertos de screego-prod-server/ })
    expect(eye.closest('span')?.textContent).toContain('55100, 55101')
    await u.click(eye)
    expect(await screen.findByRole('dialog', { name: 'Puertos de screego-prod-server' })).toBeInTheDocument()
  })

  it('detalle de un contenedor con pocos puertos: sin ojo', async () => {
    renderView(<ContainerDetailPage />, { hash: '#detail?c=tienda-api-1' })
    await screen.findByRole('heading', { level: 1, name: 'tienda-api-1' })
    expect(screen.queryByRole('button', { name: /Ver los .* puertos/ })).toBeNull()
  })
})

describe('indicadores animados de «en ejecución»', () => {
  it('la cabecera de un grupo con contenedores en marcha lleva el punto verde animado ANTES del número; sin ninguno en marcha, no', async () => {
    const id = useGroupsStore.getState().createGroup('Apagados')!
    useGroupsStore.getState().moveContainers('local', ['minio-dev', 'mailpit-pruebas'], id)
    renderView(<ContainersPage />)
    await screen.findByRole('link', { name: 'tienda-api-1' })
    const tienda = screen.getByRole('button', { name: /Stack tienda/ })
    const dot = tienda.querySelector('.live-dot')
    expect(dot).not.toBeNull()
    expect(dot).toHaveAttribute('aria-hidden', 'true') // el texto «en ejecución» ya lo dice; el punto es solo visual
    // Orden: nombre → punto → número/«en ejecución».
    const html = tienda.innerHTML
    expect(html.indexOf('live-dot')).toBeLessThan(html.indexOf('en ejecución'))
    expect(tienda.textContent).toMatch(/en ejecución/)
    // Grupo con todo detenido: sin punto.
    expect(screen.getByRole('button', { name: /Grupo Apagados/ }).querySelector('.live-dot')).toBeNull()
  })

  it('el icono «En ejecución» del detalle está animado; el de la tabla no', async () => {
    const { unmount } = renderView(<ContainerDetailPage />, { hash: '#detail?c=tienda-api-1' })
    await screen.findByRole('heading', { level: 1, name: 'tienda-api-1' })
    const badge = document.querySelector('.status-running')
    expect(badge).toHaveClass('is-live')
    expect(badge?.querySelector('.dot-halo')).not.toBeNull()
    unmount()
    renderView(<ContainersPage />)
    await screen.findByRole('link', { name: 'tienda-api-1' })
    expect(document.querySelector('tbody .status-running')).not.toBeNull()
    expect(document.querySelector('tbody .status-running.is-live')).toBeNull()
  })

  it('un contenedor detenido no anima su icono en el detalle', async () => {
    renderView(<ContainerDetailPage />, { hash: '#detail?c=minio-dev' })
    await screen.findByRole('heading', { level: 1, name: 'minio-dev' })
    expect(document.querySelector('.status.is-live')).toBeNull()
  })
})
