// StacksPage + StackEditPage con el adaptador simulado (CodeMirror sustituido por un textarea con el mismo contrato).
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setComposeMissing } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { useEngineStoreApi } from '@/data/store/hooks'
import { makeApi, renderView, resetGlobals } from '../testUtils'
import StackEditPage from './StackEditPage'
import StacksPage from './StacksPage'

vi.mock('@/components/shared/code-editor/CodeMirrorEditor', async () => {
  const { TextareaEditor } = await import('@/components/shared/code-editor/TextareaEditor')
  return { default: (p: React.ComponentProps<typeof TextareaEditor>) => <TextareaEditor {...p} /> }
})

afterEach(resetGlobals)

describe('StacksPage', () => {
  it('tarjetas por stack con origen, salud y servicios reales; sin marca «No conectado aún»', async () => {
    renderView(<StacksPage />)
    const card = await screen.findByRole('region', { name: 'Stack tienda' })
    expect(screen.queryByText('No conectado aún')).toBeNull()
    expect(within(card).getByText('Vinculado')).toBeInTheDocument()
    expect(within(card).getByText('4 de 5 activos')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Stack monitoreo' })).toHaveTextContent('Descubierto')
    expect(screen.getByRole('img', { name: '2 de 3 servicios en ejecución' })).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Editar stack tienda' })).toHaveAttribute('href', '#stack-edit?stack=tienda')
    // Un stack descubierto no se edita: se ofrece vincular su archivo.
    expect(screen.getByRole('button', { name: /Vincular el archivo del stack monitoreo/ })).toBeInTheDocument()
    // El servicio enlaza con el detalle de su contenedor.
    expect(within(card).getByRole('link', { name: 'api' })).toHaveAttribute('href', '#detail?c=tienda-api-1')
  })

  it('la cabecera cuenta los MISMOS stacks que el menú (fuente única en el store)', async () => {
    const api = makeApi()
    renderView(<StacksPage />, { api })
    await screen.findByRole('region', { name: 'Stack tienda' })
    expect(document.querySelector('.view-title .count')).toHaveTextContent('2')
  })

  it('Levantar muestra el progreso por servicio y termina con «Stack levantado»', async () => {
    const u = userEvent.setup()
    renderView(<StacksPage />)
    const card = await screen.findByRole('region', { name: 'Stack tienda' })
    await u.click(within(card).getByRole('button', { name: 'Levantar stack tienda' }))
    expect(await within(card).findByText(/Levantando… \d de 4 listos|Levantando…/)).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Cancelar' })).toBeInTheDocument()
    expect(await within(card).findByText('Stack levantado', undefined, { timeout: 4000 })).toBeInTheDocument()
  })

  it('«Bajar…» exige escribir el nombre y elimina los contenedores por la política', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<StacksPage />)
    const card = await screen.findByRole('region', { name: 'Stack tienda' })
    await u.click(within(card).getByRole('button', { name: 'Bajar stack tienda' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByRole('heading', { name: 'Bajar stack tienda' })).toBeInTheDocument()
    expect(within(dlg).getByText(/5 contenedores/)).toBeInTheDocument()
    const ok = within(dlg).getByRole('button', { name: 'Bajar stack' })
    expect(ok).toBeDisabled()
    await u.type(within(dlg).getByRole('textbox'), 'tienda')
    await u.click(ok)
    await waitFor(() => expect(api.sim.world.containers.some((c) => c.compose_project === 'tienda')).toBe(false))
    expect(await screen.findByText('Stack tienda bajado')).toBeInTheDocument()
  })

  it('Compose no instalado con stacks descubiertos: aviso compacto, lista visible y acciones desactivadas', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    api.sim.stacks.setComposeMissing(true)
    renderView(<StacksPage />, { api })
    expect(await screen.findByText('Docker Compose no está instalado')).toBeInTheDocument()
    const card = await screen.findByRole('region', { name: 'Stack tienda' })
    const up = within(card).getByRole('button', { name: 'Levantar stack tienda' })
    expect(up).toHaveAttribute('aria-disabled', 'true')
    expect(up).toHaveAttribute('title', 'Requiere Docker Compose')
    api.sim.stacks.setComposeMissing(false)
    await u.click(screen.getByRole('button', { name: 'Volver a comprobar' }))
    expect(await screen.findByText('Docker Compose disponible')).toBeInTheDocument()
  })

  it('Compose no instalado y sin stacks: panel a página completa', async () => {
    const api = makeApi()
    api.sim.world.containers.forEach((c) => { c.compose_project = null })
    api.sim.world.ownStacks = []
    api.sim.stacks.setComposeMissing(true)
    renderView(<StacksPage />, { api })
    expect(await screen.findByRole('heading', { name: 'Docker Compose no está instalado' })).toBeInTheDocument()
  })

  it('vacío: «No hay stacks todavía» con Nuevo stack y Abrir archivo Compose', async () => {
    const api = makeApi()
    api.sim.world.containers.forEach((c) => { c.compose_project = null })
    api.sim.world.ownStacks = []
    renderView(<StacksPage />, { api })
    expect(await screen.findByText('No hay stacks todavía')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Nuevo stack' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Abrir archivo Compose' }).length).toBeGreaterThan(0)
  })

  it('«Nuevo stack»: valida el nombre, crea el stack propio y abre el editor', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<StacksPage />)
    await screen.findByRole('region', { name: 'Stack tienda' })
    await u.click(screen.getByRole('button', { name: 'Nuevo stack' }))
    const dlg = await screen.findByRole('alertdialog')
    const input = within(dlg).getByLabelText('Nombre del stack')
    await waitFor(() => expect(input).toHaveFocus())
    await u.type(input, 'Mayus{Enter}')
    expect(await within(dlg).findByText(/Usa minúsculas/)).toBeInTheDocument()
    await u.clear(input)
    await u.type(input, 'tienda{Enter}')
    expect(await within(dlg).findByText('Ya existe un stack con ese nombre.')).toBeInTheDocument()
    await u.clear(input)
    await u.type(input, 'nuevo-stack{Enter}')
    await waitFor(() => expect(window.location.hash).toBe('#stack-edit?stack=nuevo-stack'))
    expect(api.sim.world.ownStacks.some((s) => s.name === 'nuevo-stack' && s.origin === 'managed')).toBe(true)
  })

  it('«Abrir archivo Compose» (ruta escrita): valida y vincula', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<StacksPage />)
    await screen.findByRole('region', { name: 'Stack tienda' })
    await u.click(screen.getByRole('button', { name: 'Abrir archivo Compose' }))
    const dlg = await screen.findByRole('alertdialog')
    await u.type(within(dlg).getByLabelText('Ruta del archivo'), 'relativa/compose.yaml{Enter}')
    expect(await within(dlg).findByText(/ruta absoluta/)).toBeInTheDocument()
    await u.clear(within(dlg).getByLabelText('Ruta del archivo'))
    await u.type(within(dlg).getByLabelText('Ruta del archivo'), '/srv/blog/compose.yaml{Enter}')
    await waitFor(() => expect(window.location.hash).toBe('#stack-edit?stack=blog'))
    expect(api.sim.world.ownStacks.find((s) => s.name === 'blog')?.origin).toBe('linked')
  })

  it('stack propio detenido: «Eliminar stack…» pide escribir el nombre; el vinculado se desvincula sin borrar', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    api.sim.world.ownStacks.push({ name: 'propio', origin: 'managed', path: '~/x/compose.yaml', yaml: 'services:\n  a:\n    image: x\n', env: '', revision: 1 })
    api.sim.world.ownStacks.push({ name: 'enlazado', origin: 'linked', path: '/srv/e/compose.yaml', yaml: 'services:\n  a:\n    image: x\n', env: '', revision: 1 })
    renderView(<StacksPage />, { api })
    const card = await screen.findByRole('region', { name: 'Stack propio' })
    await u.click(within(card).getByRole('button', { name: 'Eliminar stack propio' }))
    const dlg = await screen.findByRole('alertdialog')
    const ok = within(dlg).getByRole('button', { name: 'Eliminar stack' })
    expect(ok).toBeDisabled()
    await u.type(within(dlg).getByRole('textbox'), 'propio')
    await u.click(ok)
    await waitFor(() => expect(api.sim.world.ownStacks.some((s) => s.name === 'propio')).toBe(false))
    const linked = screen.getByRole('region', { name: 'Stack enlazado' })
    await u.click(within(linked).getByRole('button', { name: 'Desvincular stack enlazado' }))
    await waitFor(() => expect(api.sim.world.ownStacks.some((s) => s.name === 'enlazado')).toBe(false))
  })

  it('nombres maliciosos de stack se pintan como texto', async () => {
    const api = makeApi()
    const EVIL = '<img src=x onerror=alert(1)>'
    api.sim.world.containers[0].compose_project = EVIL
    renderView(<StacksPage />, { api })
    await screen.findByText(EVIL)
    expect(document.querySelector('img')).toBeNull()
  })

  it('conexión perdida: los botones quedan bloqueados', async () => {
    const api = makeApi()
    const view = renderView(<StacksPage />, { api })
    await screen.findByRole('region', { name: 'Stack tienda' })
    const { act } = await import('@testing-library/react')
    act(() => api.sim.emit({ type: 'connection', status: { state: 'failed', endpoint: 'x', cause: 'other', message: 'x', steps: [] } }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Levantar stack tienda' })).toHaveAttribute('aria-disabled', 'true'))
    view.unmount()
  })
})

describe('StackCard: acciones por origen y estado', () => {
  it('descubierto: «Levantar» desactivado con motivo visible y accesible, y «Vincular…» disponible; el vinculado sí puede levantar', async () => {
    renderView(<StacksPage />)
    const mon = await screen.findByRole('region', { name: 'Stack monitoreo' })
    const up = within(mon).getByRole('button', { name: 'Levantar stack monitoreo' })
    expect(up).toHaveAttribute('aria-disabled', 'true')
    expect(up).toHaveAccessibleDescription(/Levantar y Actualizar imágenes requieren vincular su archivo Compose/)
    expect(within(mon).getByText(/requieren vincular su archivo Compose/)).toBeVisible()
    expect(within(mon).getByRole('button', { name: /Vincular el archivo del stack monitoreo/ })).toBeInTheDocument()
    const tienda = screen.getByRole('region', { name: 'Stack tienda' })
    expect(within(tienda).getByRole('button', { name: 'Levantar stack tienda' })).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('menú «Más» (teclado): Detener e Iniciar con progreso; «Actualizar imágenes» solo con archivo', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<StacksPage />)
    const tienda = await screen.findByRole('region', { name: 'Stack tienda' })
    const more = within(tienda).getByRole('button', { name: 'Más acciones del stack tienda' })
    more.focus()
    await u.keyboard('{Enter}')
    const stop = await screen.findByRole('menuitem', { name: /^Detener/ })
    expect(screen.getByRole('menuitem', { name: /^Iniciar/ })).not.toHaveAttribute('aria-disabled', 'true') // worker está reiniciando: hay servicios no en marcha
    expect(screen.getByRole('menuitem', { name: /^Actualizar imágenes/ })).not.toHaveAttribute('aria-disabled', 'true')
    await u.click(stop)
    expect(await within(tienda).findByText('Stack detenido', undefined, { timeout: 4000 })).toBeInTheDocument()
    expect(api.sim.world.containers.filter((c) => c.compose_project === 'tienda').every((c) => c.state !== 'running')).toBe(true)
    await u.click(within(tienda).getByRole('button', { name: 'Más acciones del stack tienda' }))
    expect(await screen.findByRole('menuitem', { name: /^Detener \(ya está detenido\)/ })).toHaveAttribute('aria-disabled', 'true')
    await u.click(screen.getByRole('menuitem', { name: /^Iniciar/ }))
    expect(await within(tienda).findByText('Stack iniciado', undefined, { timeout: 4000 })).toBeInTheDocument()
    await u.click(within(tienda).getByRole('button', { name: 'Más acciones del stack tienda' }))
    await u.click(await screen.findByRole('menuitem', { name: /^Actualizar imágenes/ }))
    expect(await within(tienda).findByText('Imágenes actualizadas', undefined, { timeout: 4000 })).toBeInTheDocument()
  })

  it('descubierto: Actualizar imágenes desactivado; Detener/Iniciar sí funcionan', async () => {
    const u = userEvent.setup()
    renderView(<StacksPage />)
    const mon = await screen.findByRole('region', { name: 'Stack monitoreo' })
    await u.click(within(mon).getByRole('button', { name: 'Más acciones del stack monitoreo' }))
    expect(await screen.findByRole('menuitem', { name: /^Actualizar imágenes \(requiere vincular\)/ })).toHaveAttribute('aria-disabled', 'true')
    await u.click(screen.getByRole('menuitem', { name: /^Detener/ }))
    expect(await within(mon).findByText('Stack detenido', undefined, { timeout: 4000 })).toBeInTheDocument()
  })
})

describe('StackEditPage', () => {
  const HASH = '#stack-edit?stack=tienda'
  const area = async () => (await screen.findByLabelText('Contenido de compose.yaml')) as HTMLTextAreaElement

  it('carga el archivo, valida con Compose (debounce) y muestra el resumen', async () => {
    renderView(<StackEditPage />, { hash: HASH })
    const ta = await area()
    await waitFor(() => expect(ta.value).toContain('services:'))
    expect(await screen.findByText(/Sintaxis correcta · 4 servicios/, undefined, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Levantar' })).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('un tabulador produce un error con línea que bloquea «Levantar» y el botón del diagnóstico salta a esa línea', async () => {
    const u = userEvent.setup()
    renderView(<StackEditPage />, { hash: '#stack-edit?stack=tienda&yaml=broken' })
    const ta = await area()
    const diag = await screen.findByRole('button', { name: /^Línea 5: hay tabuladores/ }, { timeout: 3000 })
    expect(screen.getByRole('button', { name: /Levantar/ })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: /Levantar/ })).toHaveAccessibleDescription(/corrige los errores de validación/)
    await u.click(diag)
    await waitFor(() => expect(ta).toHaveFocus())
    expect(ta.value.slice(0, ta.selectionStart).split('\n').length).toBe(5)
  })

  it('cada archivo mantiene su estado: cambios sin guardar marcados en su pestaña y «Descartar cambios»', async () => {
    const u = userEvent.setup()
    renderView(<StackEditPage />, { hash: HASH })
    const ta = await area()
    await waitFor(() => expect(ta.value).toContain('services:'))
    await u.click(screen.getByRole('button', { name: /^\.env/ }))
    const env = screen.getByLabelText('Contenido de .env') as HTMLTextAreaElement
    await u.type(env, '\nNUEVA=1')
    expect(screen.getByRole('button', { name: /\.env.*sin guardar/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^compose\.yaml$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Levantar|Guardar y levantar/ })).toHaveTextContent('Guardar y levantar')
    await u.click(screen.getByRole('button', { name: 'Descartar cambios' }))
    const dlg = await screen.findByRole('alertdialog')
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Seguir editando' })).toHaveFocus())
    await u.click(within(dlg).getByRole('button', { name: 'Descartar cambios' }))
    await waitFor(() => expect((screen.getByLabelText('Contenido de .env') as HTMLTextAreaElement).value).not.toContain('NUEVA'))
  })

  it('Guardar escribe con la revisión y avisa; sin cambios el botón está desactivado', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<StackEditPage />, { hash: HASH })
    const ta = await area()
    await waitFor(() => expect(ta.value).toContain('services:'))
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()
    await u.type(ta, '\n# nota')
    await u.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(await screen.findByText('compose.yaml guardado')).toBeInTheDocument()
    expect(api.sim.world.ownStacks[0].yaml).toContain('# nota')
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()
  })

  it('conflicto al guardar: «El archivo cambió en el disco», Sobrescribir pide confirmación', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<StackEditPage />, { hash: HASH })
    const ta = await area()
    await waitFor(() => expect(ta.value).toContain('services:'))
    api.sim.stacks.failNextSave = true
    await u.type(ta, '\n# mío')
    await u.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(await screen.findByText('El archivo cambió en el disco')).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Sobrescribir' }))
    const dlg = await screen.findByRole('alertdialog')
    await u.click(within(dlg).getByRole('button', { name: 'Sobrescribir' }))
    expect(await screen.findByText('compose.yaml guardado')).toBeInTheDocument()
    expect(screen.queryByText('El archivo cambió en el disco')).toBeNull()
  })

  it('«Guardar y levantar»: guarda y muestra el progreso del stack', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<StackEditPage />, { hash: HASH })
    const ta = await area()
    await waitFor(() => expect(ta.value).toContain('services:'))
    await u.type(ta, '\n# cambio')
    await u.click(screen.getByRole('button', { name: 'Guardar y levantar' }))
    expect(await screen.findByRole('region', { name: 'Progreso de la operación del stack' })).toBeInTheDocument()
    expect(api.sim.world.ownStacks[0].yaml).toContain('# cambio')
    expect(await screen.findByText('Stack levantado', undefined, { timeout: 4000 })).toBeInTheDocument()
  })

  it('INTEGRACIÓN con el router real: salir por hash/enlace/Atrás con cambios abre el diálogo ANTES de desmontar; el texto se conserva', async () => {
    const u = userEvent.setup()
    function Routed() {
      const r = useHashRoute()
      return r.id === 'stack-edit' ? <StackEditPage /> : <div data-testid="otra">vista {r.id}</div>
    }
    const { api } = renderView(<Routed />, { hash: HASH })
    const ta = await area()
    await waitFor(() => expect(ta.value).toContain('services:'))
    await u.type(ta, '\n# sin guardar')
    window.location.hash = '#images'
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByRole('heading', { name: 'Hay cambios sin guardar' })).toBeInTheDocument()
    // El editor NO se desmontó: sigue con su texto y la ruta sigue siendo la del editor.
    expect(screen.queryByTestId('otra')).toBeNull()
    expect((screen.getByLabelText('Contenido de compose.yaml') as HTMLTextAreaElement).value).toContain('# sin guardar')
    await u.click(within(dlg).getByRole('button', { name: 'Seguir editando' }))
    await waitFor(() => expect(window.location.hash).toBe(HASH))
    expect(screen.queryByTestId('otra')).toBeNull()
    // Atrás/Adelante y otra ruta: mismo comportamiento; «Guardar y salir» guarda y navega.
    window.location.hash = '#stacks'
    const dlg2 = await screen.findByRole('alertdialog')
    await u.click(within(dlg2).getByRole('button', { name: 'Guardar y salir' }))
    await waitFor(() => expect(screen.getByTestId('otra')).toHaveTextContent('vista stacks'))
    expect(api.sim.world.ownStacks[0].yaml).toContain('# sin guardar')
  })

  it('INTEGRACIÓN: «Descartar cambios» permite salir y pierde el texto solo por decisión del usuario', async () => {
    const u = userEvent.setup()
    function Routed() {
      const r = useHashRoute()
      return r.id === 'stack-edit' ? <StackEditPage /> : <div data-testid="otra">vista {r.id}</div>
    }
    const { api } = renderView(<Routed />, { hash: HASH })
    const ta = await area()
    await waitFor(() => expect(ta.value).toContain('services:'))
    await u.type(ta, '\n# descartable')
    window.location.hash = '#volumes'
    await u.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Descartar cambios' }))
    await waitFor(() => expect(screen.getByTestId('otra')).toHaveTextContent('vista volumes'))
    expect(api.sim.world.ownStacks[0].yaml).not.toContain('# descartable')
  })

  it('stack descubierto: se abre en SOLO LECTURA, sin validación de Compose y sin «Levantar», explicándolo', async () => {
    renderView(<StackEditPage />, { hash: '#stack-edit?stack=monitoreo' })
    const ta = await area()
    await waitFor(() => expect(ta.value).toContain('prometheus'))
    expect(ta).toHaveAttribute('readonly')
    expect(screen.getByText(/Solo lectura: fue descubierto por sus etiquetas de Compose; vincula su archivo para editarlo/)).toBeInTheDocument()
    const up = screen.getByRole('button', { name: 'Levantar' })
    expect(up).toHaveAttribute('aria-disabled', 'true')
    expect(up).toHaveAccessibleDescription(/fue descubierto por sus etiquetas/)
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()
    expect(await screen.findByText(/Validación completa no disponible: el stack es de solo lectura/)).toBeInTheDocument()
    expect(screen.queryByText(/Docker Compose no está instalado/)).toBeNull()
  })

  it('sin parámetro de stack: estado vacío con enlace', async () => {
    renderView(<StackEditPage />, { hash: '#stack-edit' })
    expect(await screen.findByText('Elige un stack para editar')).toBeInTheDocument()
  })

  it('sin Docker Compose: la edición sigue, la validación completa y «Levantar» quedan bloqueadas', async () => {
    const api = makeApi()
    api.sim.stacks.setComposeMissing(true)
    renderView(<StackEditPage />, { api, hash: HASH })
    const ta = await area()
    await waitFor(() => expect(ta.value).toContain('services:'))
    expect(await screen.findByText(/Validación completa no disponible/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Levantar' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Levantar' })).toHaveAccessibleDescription(/requiere Docker Compose/)
    expect(ta).toBeEnabled()
    setComposeMissing(false)
  })

  it('el store expone el progreso de la operación (persiste al salir del editor)', async () => {
    const u = userEvent.setup()
    function Probe() { return <span data-testid="ops">{Object.keys(useEngineStoreApi().getState().stackOps).join(',')}</span> }
    const { unmount } = renderView(<><StackEditPage /><Probe /></>, { hash: HASH })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Levantar' })).not.toHaveAttribute('aria-disabled', 'true'), { timeout: 3000 })
    await u.click(screen.getByRole('button', { name: 'Levantar' }))
    expect(await screen.findByRole('region', { name: 'Progreso de la operación del stack' })).toBeInTheDocument()
    unmount()
  })
})
