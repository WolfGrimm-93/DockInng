// Ola 3: Copiar y Abrir puerto en el modal de puertos (botones, nunca enlaces; el backend arma la URL).
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fullId } from '@/data/adapters/sim/fixtures'
import type { Container, PortMapping } from '@/data/types'
import { makeApi, renderView, resetGlobals } from '../testUtils'
import ContainersPage from './ContainersPage'

const clip = vi.fn()
beforeEach(() => { clip.mockReset().mockResolvedValue(undefined) })
afterEach(() => { resetGlobals(); Reflect.deleteProperty(navigator, 'clipboard') })

const pub = (host: number, container = host, proto = 'tcp'): PortMapping => ({ ip: '0.0.0.0', private_port: container, public_port: host, protocol: proto })
const mk = (name: string, ports: PortMapping[], state: Container['state'] = 'running'): Container => ({
  id: fullId('7'.repeat(12)), names: [name], image: 'x:1', image_id: 'sha256:' + '0'.repeat(64), state, status: 'Up', created: 1,
  compose_project: null, compose_service: null, ports, mounts: [], networks: [], endpoints: [],
})
async function openDialog(c: Container, remote = false) {
  const api = makeApi()
  api.sim.world.containers.push(c)
  // La conexión activa pasa a ser remota (el simulado y el perfil que ve la UI salen del mismo mundo).
  if (remote) api.sim.world.profiles.find((p) => p.id === 'local')!.remote = true
  const u = userEvent.setup()
  // userEvent instala su propio portapapeles: el de la prueba se define DESPUÉS.
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true })
  renderView(<ContainersPage />, { api })
  await screen.findByRole('link', { name: c.names[0] })
  await u.click(screen.getByRole('button', { name: `Ver puertos e IPs de ${c.names[0]}` }))
  const dlg = await screen.findByRole('dialog')
  return { api, u, dlg }
}

describe('Copiar y Abrir puerto', () => {
  it('fila tcp publicada: botones Copiar y Abrir (nunca enlaces ni window.open); sin botones en udp, rango ni solo expuesto', async () => {
    const ports = [pub(8080, 80), pub(8443, 443), pub(5353, 53, 'udp'), { ip: null, private_port: 9000, public_port: null, protocol: 'tcp' } as PortMapping, ...[7000, 7001, 7002].map((p) => pub(p))]
    const { dlg } = await openDialog(mk('web-a', ports))
    expect(within(dlg).getByRole('button', { name: 'Copiar puerto 8080 de web-a' })).toBeInTheDocument()
    expect(within(dlg).getByRole('button', { name: 'Abrir puerto 8443 de web-a en el navegador' })).toBeInTheDocument()
    expect(within(dlg).getAllByRole('button', { name: /^Copiar puerto/ })).toHaveLength(2)
    expect(within(dlg).queryByRole('button', { name: /puerto 5353/ })).toBeNull()
    expect(within(dlg).queryByRole('button', { name: /puerto 9000/ })).toBeNull()
    expect(within(dlg).queryByRole('button', { name: /puerto 7000/ })).toBeNull()
    expect(dlg.querySelector('a[href]')).toBeNull()
  })

  it('Copiar escribe localhost:PUERTO en el portapapeles y avisa', async () => {
    const { dlg, u } = await openDialog(mk('web-a', [pub(8080, 80)]))
    await u.click(within(dlg).getByRole('button', { name: 'Copiar puerto 8080 de web-a' }))
    expect(clip).toHaveBeenCalledWith('localhost:8080')
    expect(await screen.findByText('Copiado: localhost:8080')).toBeInTheDocument()
  })

  it('si el portapapeles falla del todo, avisa y muestra el texto para copiarlo a mano', async () => {
    clip.mockRejectedValue(new Error('denied'))
    Reflect.deleteProperty(document, 'execCommand')
    const { dlg, u } = await openDialog(mk('web-a', [pub(8080, 80)]))
    await u.click(within(dlg).getByRole('button', { name: 'Copiar puerto 8080 de web-a' }))
    expect(await screen.findByText('No se pudo copiar')).toBeInTheDocument()
    expect(screen.getAllByText('localhost:8080').length).toBeGreaterThan(0)
  })

  it('Abrir invoca openPort con {id, port, scheme}: http normal, https para 443/8443', async () => {
    const c = mk('web-a', [pub(8080, 80), pub(9443, 8443)])
    const { api, dlg, u } = await openDialog(c)
    await u.click(within(dlg).getByRole('button', { name: 'Abrir puerto 8080 de web-a en el navegador' }))
    await u.click(within(dlg).getByRole('button', { name: 'Abrir puerto 9443 de web-a en el navegador' }))
    await waitFor(() => expect(api.sim.window.openedPorts).toEqual([{ id: c.id, port: 8080, scheme: 'http' }, { id: c.id, port: 9443, scheme: 'https' }]))
    expect(await screen.findByText('Abriendo http://127.0.0.1:8080/')).toBeInTheDocument()
  })

  it('contenedor detenido: Abrir deshabilitado con el motivo visible; Copiar sigue disponible', async () => {
    const { dlg, u, api } = await openDialog(mk('web-a', [pub(8080, 80)], 'exited'))
    const open = within(dlg).getByRole('button', { name: 'Abrir puerto 8080 de web-a en el navegador' })
    expect(open).toBeDisabled()
    expect(within(dlg).getByText('Contenedor detenido')).toBeVisible()
    await u.click(within(dlg).getByRole('button', { name: 'Copiar puerto 8080 de web-a' }))
    expect(clip).toHaveBeenCalled()
    expect(api.sim.window.openedPorts).toHaveLength(0)
  })

  it('conexión remota: Abrir deshabilitado con el motivo; Copiar copia solo el número de puerto', async () => {
    const { dlg, u } = await openDialog(mk('web-a', [pub(8080, 80)]), true)
    expect(within(dlg).getByRole('button', { name: 'Abrir puerto 8080 de web-a en el navegador' })).toBeDisabled()
    expect(within(dlg).getByText('Solo en este equipo')).toBeVisible()
    await u.click(within(dlg).getByRole('button', { name: 'Copiar puerto 8080 de web-a' }))
    expect(clip).toHaveBeenCalledWith('8080')
  })
})
