// CreateContainerPage con el adaptador simulado: validación por campo, avisos de bind sensible con ticket, grupo, imagen no local (pull inline).
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGroupsStore } from '../groups/groupsStore'
import { makeApi, renderView, resetGlobals } from '../testUtils'
import CreateContainerPage from './CreateContainerPage'

afterEach(resetGlobals)

describe('CreateContainerPage', () => {
  it('imagen obligatoria: mensaje, aria-invalid, foco al primer campo inválido y aviso', async () => {
    const u = userEvent.setup()
    renderView(<CreateContainerPage />, { hash: '#create' })
    await u.click(await screen.findByRole('button', { name: 'Crear e iniciar' }))
    expect(await screen.findByText('Indica la imagen.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Imagen')).toHaveFocus())
    expect(screen.getByLabelText('Imagen')).toHaveAttribute('aria-invalid', 'true')
    expect(await screen.findByText('Revisa el formulario')).toBeInTheDocument()
  })

  it('nombre inválido/duplicado y puerto ocupado por un contenedor real se explican en su campo', async () => {
    const u = userEvent.setup()
    renderView(<CreateContainerPage />, { hash: '#create?image=postgres:16.4' })
    await u.click(await screen.findByRole('button', { name: 'Solo crear' }))
    expect(await screen.findByText('El puerto 8080 del equipo ya lo usa tienda-web-1.')).toBeInTheDocument()
    expect(screen.getByLabelText('Puerto del equipo 1')).toHaveAttribute('aria-invalid', 'true')
    await u.type(screen.getByLabelText(/^Nombre/), 'tienda-api-1')
    expect(await screen.findByText('Ya existe un contenedor llamado tienda-api-1.')).toBeInTheDocument()
    await u.clear(screen.getByLabelText(/^Nombre/))
    await u.type(screen.getByLabelText(/^Nombre/), '-raro')
    expect(await screen.findByText(/debe empezar por letra o número/)).toBeInTheDocument()
  })

  it('rutas relativas de volumen, destino no absoluto, variables inválidas y puertos fuera de rango', async () => {
    const u = userEvent.setup()
    renderView(<CreateContainerPage />, { hash: '#create?image=postgres:16.4' })
    await screen.findByRole('button', { name: 'Solo crear' })
    await u.clear(screen.getByLabelText('Puerto del equipo 1'))
    await u.type(screen.getByLabelText('Puerto del equipo 1'), '99999')
    await u.type(screen.getByLabelText('Origen (volumen o ruta) 1'), './datos')
    await u.type(screen.getByLabelText('Ruta en el contenedor 1'), 'datos')
    await u.clear(screen.getByLabelText('Variable 1'))
    await u.type(screen.getByLabelText('Variable 1'), '1MALA')
    await u.click(screen.getByRole('button', { name: 'Solo crear' }))
    expect(await screen.findByText('Puerto del equipo: un número de 1 a 65535.')).toBeInTheDocument()
    expect(screen.getByText(/las rutas relativas no se admiten/)).toBeInTheDocument()
    expect(screen.getByText(/debe ser absoluta/)).toBeInTheDocument()
    expect(screen.getByText(/Nombre no válido: letras, números y «_»/)).toBeInTheDocument()
  })

  it('bind sensible: aviso en pantalla y confirmación con ticket antes de crear', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<CreateContainerPage />, { hash: '#create?image=postgres:16.4' })
    await screen.findByRole('button', { name: 'Solo crear' })
    await u.clear(screen.getByLabelText('Puerto del equipo 1'))
    await u.type(screen.getByLabelText('Origen (volumen o ruta) 1'), '/var/run/docker.sock')
    await u.type(screen.getByLabelText('Ruta en el contenedor 1'), '/var/run/docker.sock')
    expect(await screen.findByText('Montaje sensible')).toBeInTheDocument()
    await u.type(screen.getByLabelText(/^Nombre/), 'con-socket')
    await u.click(screen.getByRole('button', { name: 'Solo crear' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText(/control total de Docker/)).toBeInTheDocument()
    await u.click(within(dlg).getByRole('button', { name: 'Revisar' }))
    expect(api.sim.world.containers.some((c) => c.names[0] === 'con-socket')).toBe(false)
    await u.click(screen.getByRole('button', { name: 'Solo crear' }))
    await u.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Crear' }))
    await waitFor(() => expect(window.location.hash).toBe('#detail?c=con-socket'))
    expect(api.sim.world.containers.find((c) => c.names[0] === 'con-socket')?.state).toBe('created')
  })

  it('crea, asigna el grupo propio y navega al detalle', async () => {
    const u = userEvent.setup()
    const gid = useGroupsStore.getState().createGroup('Pruebas', 200)!
    const { api } = renderView(<CreateContainerPage />, { hash: '#create?image=postgres:16.4' })
    await screen.findByRole('button', { name: 'Crear e iniciar' })
    await u.click(screen.getByRole('button', { name: 'Añadir puerto' }))
    expect(screen.getByLabelText('Puerto del equipo 2')).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Quitar puerto 2' }))
    await u.clear(screen.getByLabelText('Puerto del equipo 1'))
    await u.type(screen.getByLabelText('Puerto del equipo 1'), '5999')
    await u.type(screen.getByLabelText(/^Nombre/), 'nuevo-pg')
    await u.selectOptions(screen.getByLabelText(/^Grupo propio/), gid)
    await u.click(screen.getByRole('button', { name: 'Crear e iniciar' }))
    await waitFor(() => expect(window.location.hash).toBe('#detail?c=nuevo-pg'))
    const c = api.sim.world.containers.find((x) => x.names[0] === 'nuevo-pg')!
    expect(c.state).toBe('running')
    expect(c.ports[0]).toMatchObject({ public_port: 5999, private_port: 80, ip: '127.0.0.1' })
    expect(Object.values(useGroupsStore.getState().assign)).toContain(gid)
  })

  it('«Nuevo grupo…» abre el diálogo y selecciona el grupo creado', async () => {
    const u = userEvent.setup()
    renderView(<CreateContainerPage />, { hash: '#create' })
    await u.click(await screen.findByRole('button', { name: 'Nuevo grupo…' }))
    const dlg = await screen.findByRole('alertdialog')
    await u.type(within(dlg).getByLabelText('Nombre'), 'Equipo A')
    await u.click(within(dlg).getByRole('button', { name: 'Crear grupo' }))
    await waitFor(() => expect((screen.getByLabelText(/^Grupo propio/) as HTMLSelectElement).selectedOptions[0].textContent).toBe('Equipo A'))
  })

  it('imagen que no está en el equipo: descarga primero (progreso inline) y luego crea', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<CreateContainerPage />, { hash: '#create?image=miapp/web:2.0' })
    expect(await screen.findByText(/no está en este equipo: se descargará/)).toBeInTheDocument()
    await u.clear(screen.getByLabelText('Puerto del equipo 1'))
    await u.type(screen.getByLabelText(/^Nombre/), 'web-nuevo')
    await u.click(screen.getByRole('button', { name: 'Crear e iniciar' }))
    expect(await screen.findByRole('region', { name: 'Descargando imagen' })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#detail?c=web-nuevo'), { timeout: 8000 })
    expect(api.sim.world.images.some((i) => i.reference === 'miapp/web:2.0')).toBe(true)
    expect(api.sim.world.containers.some((c) => c.names[0] === 'web-nuevo')).toBe(true)
  })

  it('si la descarga falla no se crea nada y el error queda visible', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<CreateContainerPage />, { hash: '#create?image=ratelimit/429:x' })
    await screen.findByRole('button', { name: 'Crear e iniciar' })
    await u.clear(screen.getByLabelText('Puerto del equipo 1'))
    await u.click(screen.getByRole('button', { name: 'Crear e iniciar' }))
    expect(await screen.findByText(/No se pudo descargar ratelimit\/429:x/, undefined, { timeout: 8000 })).toBeInTheDocument()
    expect(api.sim.world.containers.some((c) => c.image.includes('ratelimit'))).toBe(false)
  })

  it('política de reinicio: Segmented con una sola opción activa', async () => {
    const u = userEvent.setup()
    renderView(<CreateContainerPage />, { hash: '#create' })
    const g = await screen.findByRole('group', { name: 'Política de reinicio' })
    expect(within(g).getByRole('button', { name: 'unless-stopped' })).toHaveAttribute('aria-pressed', 'true')
    await u.click(within(g).getByRole('button', { name: 'always' }))
    expect(within(g).getByRole('button', { name: 'always' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(g).getByRole('button', { name: 'unless-stopped' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('el aviso de ruta relativa en conexión remota se conserva', async () => {
    const api = makeApi()
    const u = userEvent.setup()
    renderView(<CreateContainerPage />, { api, hash: '#create?remote=1' })
    await screen.findByRole('button', { name: 'Crear e iniciar' })
    await u.type(screen.getByLabelText('Origen (volumen o ruta) 1'), './datos')
    await waitFor(() => expect(screen.getByText('Ruta relativa en una conexión remota')).toBeInTheDocument())
  })

  it('image_missing en create: descarga, VUELVE A PLANIFICAR y usa el ticket nuevo (reconfirmando)', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    const { unmount } = renderView(<CreateContainerPage />, { api, hash: '#create?image=postgres:16.4' })
    void unmount
    await screen.findByRole('button', { name: 'Solo crear' })
    await u.clear(screen.getByLabelText('Puerto del equipo 1'))
    await u.type(screen.getByLabelText('Origen (volumen o ruta) 1'), '/var/run/docker.sock')
    await u.type(screen.getByLabelText('Ruta en el contenedor 1'), '/s')
    await u.type(screen.getByLabelText(/^Nombre/), 'replan')
    const tickets: (string | null)[] = []
    const realCreate = api.containers.create
    let first = true
    api.containers.create = async (spec, start, ticket) => {
      tickets.push(ticket)
      if (first) { first = false; throw { code: 'image_missing', message: 'No such image' } }
      return realCreate(spec, start, ticket)
    }
    const planSpy = vi.spyOn(api.containers, 'planCreate')
    await u.click(screen.getByRole('button', { name: 'Solo crear' }))
    await u.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Crear' }))
    // Tras el pull vuelve a planificar y pide confirmar otra vez.
    await waitFor(() => expect(planSpy).toHaveBeenCalledTimes(2), { timeout: 10000 })
    await u.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Crear' }))
    await waitFor(() => expect(window.location.hash).toBe('#detail?c=replan'), { timeout: 10000 })
    expect(tickets).toHaveLength(2)
    expect(tickets[0]).toBeTruthy()
    expect(tickets[1]).toBeTruthy()
    expect(tickets[1]).not.toBe(tickets[0])
  }, 30000)
})
