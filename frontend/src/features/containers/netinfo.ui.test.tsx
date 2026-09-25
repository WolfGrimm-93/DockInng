import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { Container, NetworkEndpoint } from '@/data/types'
import { fullId } from '@/data/adapters/sim/fixtures'
import { useGroupsStore } from '../groups/groupsStore'
import { makeApi, renderView, resetGlobals } from '../testUtils'
import ContainerDetailPage from './ContainerDetailPage'
import ContainersPage from './ContainersPage'

afterEach(resetGlobals)
const rowOf = (name: string) => screen.getByRole('link', { name }).closest('tr') as HTMLElement
const ep = (name: string, ip: string | null = null): NetworkEndpoint => ({ name, ip_address: ip, ipv6_address: null, gateway: ip ? '10.9.0.1' : null, mac_address: ip ? '02:42:0a:09:00:02' : null, aliases: [] })
const cont = (name: string, endpoints: NetworkEndpoint[], state: Container['state'] = 'running'): Container => ({
  id: fullId('7'.repeat(12)), names: [name], image: 'img', image_id: 'sha256:' + '0'.repeat(64), state, status: '', created: 1, compose_project: null, compose_service: null,
  ports: [], mounts: [], networks: endpoints.map((e) => e.name), endpoints,
})
async function openIps(name: string, api = makeApi()) {
  const u = userEvent.setup()
  renderView(<ContainersPage />, { api })
  await screen.findByRole('link', { name })
  await u.click(within(rowOf(name)).getByRole('button', { name: `Ver puertos e IPs de ${name}` }))
  const dlg = await screen.findByRole('dialog', { name: `Puertos e IPs de ${name}` })
  await u.click(within(dlg).getByRole('tab', { name: 'IPs' }))
  return { u, dlg, api }
}

describe('modal del contenedor: pestaña IPs', () => {
  it('una fila por red con IPv4, puerta de enlace y MAC, y los alias de DNS que llegan del detalle', async () => {
    const { dlg } = await openIps('tienda-api-1')
    const table = await within(dlg).findByRole('table', { name: 'IPs por red de tienda-api-1' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(1)
    const cells = within(rows[0]).getAllByRole('cell').map((c) => c.textContent)
    expect(cells[0]).toBe('tienda_default')
    expect(cells[1]).toMatch(/^172\.20\.0\.\d+$/)
    expect(cells[3]).toBe('172.20.0.1')
    expect(cells[4]).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/)
    // Los alias no vienen en el listado: se piden con inspect al abrir la pestaña.
    await waitFor(() => expect(within(rows[0]).getByText('tienda-api-1')).toBeInTheDocument())
    expect(within(rows[0]).getByText('api')).toBeInTheDocument()
  })

  it('un contenedor en varias redes muestra una fila por red', async () => {
    const { dlg } = await openIps('tienda-web-1')
    const rows = within(await within(dlg).findByRole('table', { name: /IPs por red/ })).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(['proxy-publico', 'tienda_default'])
  })

  it('detenido: conserva sus redes pero sin IP, y lo explica', async () => {
    const { dlg } = await openIps('minio-dev')
    expect(await within(dlg).findByText(/Está detenido, así que no tiene IP asignada/)).toBeInTheDocument()
    const cells = within(within(dlg).getByRole('table', { name: /IPs por red/ })).getAllByRole('row')[1]
    expect(within(cells).getAllByRole('cell').map((c) => c.textContent)).toEqual(['bridge', '—', '—', '—', '—', expect.any(String)])
  })

  it('red host: explica que comparte la IP del equipo; sin ninguna red: lo dice', async () => {
    const api = makeApi()
    api.sim.world.containers.push(cont('en-host', [ep('host')]), { ...cont('sin-red', []), id: fullId('8'.repeat(12)) })
    const a = await openIps('en-host', api)
    expect(await within(a.dlg).findByText(/Usa la red del equipo/)).toBeInTheDocument()
    await a.u.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await a.u.click(within(rowOf('sin-red')).getByRole('button', { name: 'Ver puertos e IPs de sin-red' }))
    const dlg2 = await screen.findByRole('dialog', { name: 'Puertos e IPs de sin-red' })
    await a.u.click(within(dlg2).getByRole('tab', { name: 'IPs' }))
    expect(await within(dlg2).findByText(/No está conectado a ninguna red/)).toBeInTheDocument()
  })

  it('si inspect falla, las IPs se muestran igual y los alias quedan en «—» (sin romper)', async () => {
    const api = makeApi()
    api.containers.inspect = async () => { throw new Error('boom') }
    const { dlg } = await openIps('tienda-api-1', api)
    const row = within(await within(dlg).findByRole('table', { name: /IPs por red/ })).getAllByRole('row')[1]
    expect(within(row).getAllByRole('cell')[1].textContent).toMatch(/^172\.20\.0\./)
    await waitFor(() => expect(within(row).getByTitle('No se pudieron leer los alias')).toBeInTheDocument())
  })

  it('las pestañas se recorren con el teclado y el nombre/alias raros se pintan como texto', async () => {
    const api = makeApi()
    api.sim.world.containers.push(cont('<i>x</i>', [ep('<b>red</b>', '10.9.0.5')]))
    const u = userEvent.setup()
    renderView(<ContainersPage />, { api })
    await screen.findByRole('link', { name: '<i>x</i>' })
    await u.click(within(rowOf('<i>x</i>')).getByRole('button', { name: 'Ver puertos e IPs de <i>x</i>' }))
    const dlg = await screen.findByRole('dialog')
    const tabPorts = within(dlg).getByRole('tab', { name: 'Puertos' })
    tabPorts.focus()
    await u.keyboard('{ArrowRight}')
    expect(within(dlg).getByRole('tab', { name: 'IPs' })).toHaveAttribute('aria-selected', 'true')
    expect(await within(dlg).findByText('<b>red</b>')).toBeInTheDocument()
    expect(dlg.querySelector('b')).toBeNull()
    expect(dlg.querySelector('i')).toBeNull()
  })

  it('detalle: el ojo junto a la IP abre el modal directamente en la pestaña IPs', async () => {
    const u = userEvent.setup()
    renderView(<ContainerDetailPage />, { hash: '#detail?c=tienda-api-1' })
    await u.click(await screen.findByRole('button', { name: 'Ver las IPs de tienda-api-1 por red' }))
    const dlg = await screen.findByRole('dialog', { name: 'Puertos e IPs de tienda-api-1' })
    expect(within(dlg).getByRole('tab', { name: 'IPs' })).toHaveAttribute('aria-selected', 'true')
    expect(await within(dlg).findByRole('table', { name: /IPs por red/ })).toBeInTheDocument()
  })
})

describe('modal «Redes» del grupo', () => {
  async function openGroup(re: RegExp) {
    const u = userEvent.setup()
    renderView(<ContainersPage />)
    await screen.findByRole('link', { name: 'tienda-api-1' })
    const btn = within(screen.getByRole('button', { name: re }).closest('tr') as HTMLElement).getByRole('button', { name: /^Ver las \d+ redes? de / })
    await u.click(btn)
    return { u, btn, dlg: await screen.findByRole('dialog') }
  }

  it('cuántas redes tiene el stack y, de cada una, subred, puerta de enlace y sus contenedores con IP (sin las redes del sistema)', async () => {
    const { dlg } = await openGroup(/Stack tienda/)
    expect(within(dlg).getByRole('heading', { name: 'Redes de el stack tienda' })).toBeInTheDocument()
    expect(within(dlg).getByText(/2 redes · 5 contenedores en el grupo/)).toBeInTheDocument()
    const td = within(dlg).getByRole('region', { name: 'Red tienda_default' })
    expect(within(td).getByText('172.20.0.0/16')).toBeInTheDocument()
    expect(td.textContent).toContain('Puerta de enlace')
    const rows = within(td).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(['tienda-api-1', 'tienda-postgres-1', 'tienda-redis-1', 'tienda-web-1', 'tienda-worker-1'])
    // Una fila con IP real y el que está reiniciando (su IP puede faltar: nunca se inventa).
    expect(within(rows[0]).getAllByRole('cell')[1].textContent).toMatch(/^172\.20\.0\.\d+$/)
    // La otra red la comparte solo el web.
    const proxy = within(dlg).getByRole('region', { name: 'Red proxy-publico' })
    expect(within(proxy).getAllByRole('row').slice(1)).toHaveLength(1)
    expect(within(dlg).queryByRole('region', { name: 'Red bridge' })).toBeNull()
    expect(within(dlg).getByText(/No se muestran las redes del sistema/)).toBeInTheDocument()
  })

  it('Esc cierra el modal y devuelve el foco al botón «Redes»', async () => {
    const { u, btn } = await openGroup(/Stack monitoreo/)
    await u.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(btn).toHaveFocus()
  })

  it('un grupo propio dice «el grupo»; y uno que solo usa redes del sistema no tiene botón «Redes»', async () => {
    const store = useGroupsStore.getState()
    const mixed = store.createGroup('Mezcla')!
    store.moveContainers('local', ['tienda-api-1', 'monitoreo-grafana-1'], mixed)
    const soloBridge = store.createGroup('Solo bridge')!
    store.moveContainers('local', ['minio-dev', 'mailpit-pruebas'], soloBridge)
    const { u, dlg } = await openGroup(/Grupo Mezcla/)
    expect(within(dlg).getByRole('heading', { name: 'Redes de el grupo Mezcla' })).toBeInTheDocument()
    // tienda-api-1 solo está en tienda_default; monitoreo-grafana-1 en monitoreo_default y proxy-publico → 3 redes.
    expect(within(dlg).getByText(/3 redes · 2 contenedores en el grupo/)).toBeInTheDocument()
    // Con el modal abierto el fondo está inerte (correcto): se cierra antes de mirar la tabla.
    await u.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const sb = screen.getByRole('button', { name: /Grupo Solo bridge/ }).closest('tr') as HTMLElement
    expect(within(sb).queryByRole('button', { name: /Ver las .* redes? de/ })).toBeNull()
  })
})
