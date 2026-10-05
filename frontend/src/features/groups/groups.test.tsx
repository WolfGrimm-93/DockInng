import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import ContainersPage from '../containers/ContainersPage'
import SettingsPage from '../settings/SettingsPage'
import { renderView, resetGlobals } from '../testUtils'
import { assignKey, useGroupsStore } from './groupsStore'

afterEach(resetGlobals)
const s = () => useGroupsStore.getState()
const hue = (el: Element) => (el as HTMLElement).style.getPropertyValue('--grp-h')
async function loaded() { await screen.findByRole('link', { name: 'tienda-api-1' }) }
const rowOf = (name: string) => screen.getByRole('link', { name }).closest('tr') as HTMLElement
const headOf = (re: RegExp) => screen.getByRole('button', { name: re }).closest('tr') as HTMLElement

describe('grupos propios en la tabla', () => {
  it('un contenedor de un stack movido a un grupo propio sale de su stack y aparece bajo el grupo, con el color del grupo', async () => {
    const id = s().createGroup('Mis pruebas', 200)!
    s().moveContainers('local', ['tienda-api-1'], id)
    renderView(<ContainersPage />)
    await screen.findByRole('link', { name: 'tienda-postgres-1' })
    const head = headOf(/Grupo Mis pruebas/)
    expect(hue(head)).toBe('200')
    expect(hue(rowOf('tienda-api-1'))).toBe('200')
    // El stack «tienda» conserva a los demás (5 → 4) y ya no incluye a tienda-api-1.
    expect(within(headOf(/Stack tienda/)).getByText(/· 4/)).toBeInTheDocument()
    // Los grupos propios van antes que los stacks.
    const heads = Array.from(document.querySelectorAll('tr.group-row button')).map((b) => b.textContent ?? '')
    expect(heads.findIndex((t) => t.includes('Grupo Mis pruebas'))).toBeLessThan(heads.findIndex((t) => t.includes('Stack ')))
  })

  it('un contenedor SUELTO movido a un grupo propio deja de ser suelto', async () => {
    const id = s().createGroup('Infra')!
    s().moveContainers('local', ['traefik-proxy'], id)
    renderView(<ContainersPage />)
    await loaded()
    expect(rowOf('traefik-proxy')).toHaveClass('in-group')
    expect(rowOf('minio-dev')).not.toHaveClass('in-group')
  })

  it('un grupo propio sin contenedores visibles no aparece; la asignación a un grupo borrado se ignora', async () => {
    const id = s().createGroup('Vacío')!
    s().moveContainers('local', ['traefik-proxy'], id)
    s().deleteGroup(id)
    renderView(<ContainersPage />)
    await loaded()
    expect(screen.queryByRole('button', { name: /Grupo Vacío/ })).toBeNull()
    expect(rowOf('traefik-proxy')).not.toHaveClass('in-group')
  })

  it('la asignación es por conexión: otra conexión con el mismo nombre no se ve afectada', async () => {
    const id = s().createGroup('Solo remoto')!
    s().moveContainers('otra-conexion', ['traefik-proxy'], id)
    renderView(<ContainersPage />)
    await loaded()
    expect(screen.queryByRole('button', { name: /Grupo Solo remoto/ })).toBeNull()
    expect(s().assign[assignKey('otra-conexion', 'traefik-proxy')]).toBe(id)
  })

  it('el color elegido para un stack sustituye al automático y «color automático» lo restablece', async () => {
    s().setStackHue('tienda', 300)
    renderView(<ContainersPage />)
    await loaded()
    expect(hue(headOf(/Stack tienda/))).toBe('300')
    expect(hue(rowOf('tienda-api-1'))).toBe('300')
    // El otro stack sigue con su color automático (distinto).
    expect(hue(headOf(/Stack monitoreo/))).not.toBe('300')
  })

  it('menú de una fila: «Nuevo grupo…» crea el grupo y mueve el contenedor (validando el nombre)', async () => {
    const u = userEvent.setup()
    renderView(<ContainersPage />)
    await loaded()
    await u.click(screen.getByRole('button', { name: 'Mover traefik-proxy a un grupo' }))
    expect(await screen.findByText('Todavía no tienes grupos.')).toBeInTheDocument()
    await u.click(screen.getByRole('menuitem', { name: /Nuevo grupo/ }))
    const dlg = await screen.findByRole('alertdialog')
    // El foco inicial va al campo de nombre; vacío no se puede crear.
    await waitFor(() => expect(within(dlg).getByLabelText('Nombre')).toHaveFocus())
    await u.click(within(dlg).getByRole('button', { name: 'Crear grupo' }))
    expect(within(dlg).getByText('Escribe un nombre.')).toBeInTheDocument()
    await u.type(within(dlg).getByLabelText('Nombre'), 'Reverse proxy')
    await u.click(within(dlg).getByRole('button', { name: 'Crear grupo' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(s().groups.map((g) => g.name)).toEqual(['Reverse proxy'])
    expect(rowOf('traefik-proxy')).toHaveClass('in-group')
    expect(screen.getByRole('button', { name: /Grupo Reverse proxy/ })).toBeInTheDocument()
  })

  it('«Nuevo grupo…» cancelado: el foco vuelve al disparador del menú de la fila (no se pierde en el body) y no se roba al abrir', async () => {
    const u = userEvent.setup()
    renderView(<ContainersPage />)
    await loaded()
    const trigger = screen.getByRole('button', { name: 'Mover traefik-proxy a un grupo' })
    await u.click(trigger)
    await u.click(await screen.findByRole('menuitem', { name: /Nuevo grupo/ }))
    const dlg = await screen.findByRole('alertdialog')
    await waitFor(() => expect(within(dlg).getByLabelText('Nombre')).toHaveFocus())
    // El menú que se cierra al elegir «Nuevo grupo…» no debe devolver el foco después de abrir el diálogo.
    await new Promise((r) => setTimeout(r, 50))
    expect(within(dlg).getByLabelText('Nombre')).toHaveFocus()
    await u.click(within(dlg).getByRole('button', { name: 'Cancelar' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(s().groups).toHaveLength(0)
  })

  it('menú de una fila: mover a un grupo existente y «Quitar de su grupo»', async () => {
    const u = userEvent.setup()
    const id = s().createGroup('Existente')!
    renderView(<ContainersPage />)
    await loaded()
    await u.click(screen.getByRole('button', { name: 'Mover minio-dev a un grupo' }))
    await u.click(await screen.findByRole('menuitem', { name: 'Existente' }))
    expect(s().assign[assignKey('local', 'minio-dev')]).toBe(id)
    await u.click(screen.getByRole('button', { name: 'Mover minio-dev a un grupo' }))
    await u.click(await screen.findByRole('menuitem', { name: /Quitar de su grupo/ }))
    expect(s().assign[assignKey('local', 'minio-dev')]).toBeUndefined()
  })

  it('barra masiva: «Mover a grupo…» mueve toda la selección visible', async () => {
    const u = userEvent.setup()
    const id = s().createGroup('Lote')!
    renderView(<ContainersPage />)
    await loaded()
    await u.click(within(rowOf('minio-dev')).getByRole('checkbox'))
    await u.click(within(rowOf('mailpit-pruebas')).getByRole('checkbox'))
    await u.click(await screen.findByRole('button', { name: 'Mover la selección a un grupo' }))
    await u.click(await screen.findByRole('menuitem', { name: 'Lote' }))
    expect(s().assign[assignKey('local', 'minio-dev')]).toBe(id)
    expect(s().assign[assignKey('local', 'mailpit-pruebas')]).toBe(id)
  })

  it('el nombre de un grupo con marcas bidi/HTML se muestra como texto y sin inyectar nada', async () => {
    // Un valor así solo llega por almacenamiento manipulado: loadGroups lo descarta, y aun sin descartarlo se pintaría como texto.
    const id = s().createGroup('<img src=x onerror=window.__xss=1>')!
    s().moveContainers('local', ['traefik-proxy'], id)
    renderView(<ContainersPage />)
    await loaded()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined()
    expect(screen.getByRole('button', { name: /Grupo <img src=x/ })).toBeInTheDocument()
  })
})

describe('pestaña Grupos de Configuración', () => {
  it('estado vacío con instrucciones, y lista los stacks con color automático', async () => {
    renderView(<SettingsPage />, { hash: '#settings?tab=groups' })
    expect(await screen.findByText('Todavía no tienes grupos')).toBeInTheDocument()
    const tienda = await screen.findByRole('group', { name: 'Stack tienda' })
    expect(within(tienda).getByText(/color automático/)).toBeInTheDocument()
    expect(within(tienda).queryByRole('button', { name: 'Color automático' })).toBeNull()
  })

  it('crear un grupo, cambiar su color (muestra y deslizador), renombrarlo y eliminarlo con confirmación', async () => {
    const u = userEvent.setup()
    renderView(<SettingsPage />, { hash: '#settings?tab=groups' })
    await u.click(await screen.findByRole('button', { name: 'Nuevo grupo' }))
    const dlg = await screen.findByRole('alertdialog')
    await u.type(within(dlg).getByLabelText('Nombre'), 'Alfa')
    await u.click(within(dlg).getByRole('button', { name: 'Crear grupo' }))
    const row = await screen.findByRole('group', { name: 'Grupo Alfa' })
    const g = s().groups[0]
    // Color: una muestra de la paleta…
    await u.click(within(row).getByRole('button', { name: 'Color Violeta' }))
    expect(s().groups[0].hue).toBe(300)
    expect(within(row).getByRole('button', { name: 'Color Violeta' })).toHaveAttribute('aria-pressed', 'true')
    // …y cualquier otro matiz con el deslizador (jsdom no implementa el incremento nativo con flechas, así que se dispara el cambio de valor).
    const slider = within(row).getByRole('slider')
    fireEvent.change(slider, { target: { value: '302' } })
    expect(s().groups[0].hue).toBe(302)
    fireEvent.change(slider, { target: { value: '999' } }) // fuera de rango: el clamp lo deja en 0–359
    expect(s().groups[0].hue).toBeGreaterThanOrEqual(0)
    expect(s().groups[0].hue).toBeLessThan(360)
    // Renombrar (Enter confirma) y rechazar un nombre inválido volviendo al anterior.
    const input = within(row).getByLabelText('Nombre del grupo')
    await u.clear(input)
    await u.type(input, 'Beta{Enter}')
    expect(s().groups[0].name).toBe('Beta')
    await u.clear(input)
    await u.tab()
    expect(s().groups[0].name).toBe('Beta')
    // Eliminar pide confirmación y no toca contenedores.
    s().moveContainers('local', ['tienda-api-1'], g.id)
    await u.click(within(await screen.findByRole('group', { name: 'Grupo Beta' })).getByRole('button', { name: /Eliminar el grupo Beta/ }))
    expect(s().groups).toHaveLength(1)
    await u.click(screen.getByRole('button', { name: 'Eliminar grupo' }))
    expect(s().groups).toHaveLength(0)
    expect(s().assign[assignKey('local', 'tienda-api-1')]).toBeUndefined()
  })

  it('elegir el color de un stack y volver al automático', async () => {
    const u = userEvent.setup()
    renderView(<SettingsPage />, { hash: '#settings?tab=groups' })
    const tienda = await screen.findByRole('group', { name: 'Stack tienda' })
    await u.click(within(tienda).getByRole('button', { name: 'Color Azul' }))
    expect(s().stackHue.tienda).toBe(240)
    expect(within(tienda).getByText(/color elegido/)).toBeInTheDocument()
    await u.click(within(tienda).getByRole('button', { name: 'Color automático' }))
    expect(s().stackHue.tienda).toBeUndefined()
  })

  it('un nombre repetido se rechaza con un mensaje accesible', async () => {
    const u = userEvent.setup()
    s().createGroup('Uno')
    renderView(<SettingsPage />, { hash: '#settings?tab=groups' })
    await u.click(await screen.findByRole('button', { name: 'Nuevo grupo' }))
    const dlg = await screen.findByRole('alertdialog')
    await u.type(within(dlg).getByLabelText('Nombre'), 'uno')
    await u.click(within(dlg).getByRole('button', { name: 'Crear grupo' }))
    expect(within(dlg).getByText('Ya existe un grupo con ese nombre.')).toBeInTheDocument()
    expect(within(dlg).getByLabelText('Nombre')).toHaveAttribute('aria-invalid', 'true')
    expect(s().groups).toHaveLength(1)
    await u.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })
})
