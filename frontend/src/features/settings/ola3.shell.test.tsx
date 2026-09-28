// Ola 3: ajustes de notificaciones y ventana, chrome de ventana sin marco y diálogo de salir.
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WindowChrome } from '@/components/shell/WindowChrome'
import { useQuitGuard } from '@/app/quitGuard'
import { resetShellPrefs, useShellPrefs } from '@/data/shellPrefs'
import { makeApi, renderView, resetGlobals } from '../testUtils'
import { NotificationsSection } from './NotificationsSection'
import { WindowSection } from './WindowSection'

beforeEach(resetShellPrefs)
afterEach(() => { resetGlobals(); resetShellPrefs(); document.documentElement.classList.remove('has-chrome') })

function Harness() {
  useQuitGuard()
  return null
}

describe('NotificationsSection', () => {
  it('apagado por defecto; los eventos están desactivados hasta activar los avisos; guarda en el backend', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    renderView(<NotificationsSection />, { api })
    const master = screen.getByRole('switch', { name: 'Avisos del sistema' })
    expect(master).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Un contenedor se detiene con error' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Enviar aviso de prueba/ })).toBeDisabled()
    await u.click(master)
    expect(await api.prefs.get('notify_enabled')).toBe(true)
    const die = screen.getByRole('switch', { name: 'Un contenedor se detiene con error' })
    expect(die).toBeEnabled()
    expect(die).toBeChecked()
    await u.click(die)
    expect(await api.prefs.get('notify_events')).toEqual({ die: false, oom: true, unhealthy: true, op_done: true })
    await u.click(screen.getByRole('button', { name: /Enviar aviso de prueba/ }))
    await waitFor(() => expect(api.sim.window.notifications).toHaveLength(1))
  })

  it('con la bandeja no disponible muestra el aviso', async () => {
    const api = makeApi()
    api.sim.window.tray = { available: false, error: 'sin appindicator' }
    await useShellPrefs.getState().load(api)
    renderView(<NotificationsSection />, { api })
    expect(screen.getByText('La bandeja del sistema no está disponible')).toBeInTheDocument()
  })
})

describe('WindowSection', () => {
  it('cerrar a la bandeja OFF por defecto; con bandeja se activa y se guarda', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    await useShellPrefs.getState().load(api)
    renderView(<WindowSection />, { api })
    const sw = screen.getByRole('switch', { name: 'Cerrar a la bandeja' })
    expect(sw).not.toBeChecked()
    expect(sw).toBeEnabled()
    await u.click(sw)
    expect(await api.prefs.get('close_to_tray')).toBe(true)
    expect(screen.getByRole('switch', { name: 'Iniciar minimizada' })).not.toBeChecked()
  })

  it('sin bandeja: «Cerrar a la bandeja» queda desactivado con el motivo visible', async () => {
    const api = makeApi()
    api.sim.window.tray = { available: false, error: null }
    await useShellPrefs.getState().load(api)
    renderView(<WindowSection />, { api })
    expect(screen.getByRole('switch', { name: 'Cerrar a la bandeja' })).toBeDisabled()
    expect(screen.getByText('Necesita una bandeja del sistema disponible.')).toBeVisible()
  })

  it('ventana sin marco: llama a window_set_decorations y revierte si el backend falla', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    await useShellPrefs.getState().load(api)
    renderView(<WindowSection />, { api })
    const sw = screen.getByRole('switch', { name: 'Ventana sin marco' })
    expect(sw).not.toBeChecked()
    await u.click(sw)
    expect(api.sim.window.calls).toContain('setDecorations:false')
    expect(sw).toBeChecked()
    api.window.setDecorations = () => Promise.reject({ code: 'internal', message: 'fallo' })
    await u.click(sw)
    await waitFor(() => expect(sw).toBeChecked()) // revertido: sigue sin marco
    expect(await screen.findByText('No se pudo cambiar la barra de la ventana')).toBeInTheDocument()
  })
})

describe('WindowChrome', () => {
  it('con la barra del sistema (por defecto) no dibuja nada', async () => {
    const api = makeApi()
    await useShellPrefs.getState().load(api)
    renderView(<WindowChrome />, { api })
    expect(screen.queryByRole('toolbar', { name: 'Controles de la ventana' })).toBeNull()
    expect(document.documentElement).not.toHaveClass('has-chrome')
  })

  it('sin marco: controles con nombre accesible, arrastre, doble clic, cierre y 8 bordes de redimensionado', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    await api.prefs.set('window_decorations', false)
    await useShellPrefs.getState().load(api)
    renderView(<WindowChrome />, { api })
    const bar = await screen.findByRole('toolbar', { name: 'Controles de la ventana' })
    expect(document.documentElement).toHaveClass('has-chrome')
    await u.click(within(bar).getByRole('button', { name: 'Minimizar' }))
    await u.click(within(bar).getByRole('button', { name: 'Maximizar o restaurar' }))
    await u.click(within(bar).getByRole('button', { name: 'Cerrar' }))
    expect(api.sim.window.calls).toEqual(['minimize', 'toggleMaximize', 'close'])
    api.sim.window.calls.length = 0
    const drag = screen.getByTestId('window-drag')
    await u.pointer({ keys: '[MouseLeft>]', target: drag })
    expect(api.sim.window.calls).toEqual(['startDrag'])
    await u.dblClick(drag)
    expect(api.sim.window.calls).toContain('toggleMaximize')
    const edges = document.querySelectorAll('.win-edge')
    expect(edges).toHaveLength(8)
    api.sim.window.calls.length = 0
    await u.pointer({ keys: '[MouseLeft>]', target: document.querySelector('[data-edge="south_east"]') as Element })
    expect(api.sim.window.calls).toEqual(['startResize:south_east'])
  })

  it('«Volver a la barra del sistema» restaura las decoraciones y oculta el chrome', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    await api.prefs.set('window_decorations', false)
    await useShellPrefs.getState().load(api)
    renderView(<WindowChrome />, { api })
    await u.click(await screen.findByRole('button', { name: 'Volver a la barra del sistema' }))
    expect(api.sim.window.calls).toContain('setDecorations:true')
    await waitFor(() => expect(screen.queryByRole('toolbar')).toBeNull())
    expect(document.documentElement).not.toHaveClass('has-chrome')
  })
})

describe('salir con operaciones en curso (quitGuard)', () => {
  it('muestra el resumen y responde quit_app(true) al confirmar', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    renderView(<Harness />, { api })
    act(() => api.sim.window.requestQuit({ stacks: 1, pulls: 2, builds: 0, terminals: 1 }))
    const dlg = await screen.findByRole('alertdialog', { name: '¿Salir de DockInng?' })
    expect(within(dlg).getByText(/1 operación de stack/)).toBeInTheDocument()
    expect(within(dlg).getByText(/2 descargas de imágenes/)).toBeInTheDocument()
    expect(within(dlg).getByText(/1 terminal abierta/)).toBeInTheDocument()
    expect(within(dlg).queryByText(/construcci/)).toBeNull()
    await u.click(within(dlg).getByRole('button', { name: 'Salir' }))
    await waitFor(() => expect(api.sim.window.calls).toEqual(['quit:true']))
  })

  it('cancelar NO llama al backend (quit_app(false) volvería a pedir confirmación); una segunda petición con el diálogo abierto se ignora', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    renderView(<Harness />, { api })
    act(() => { api.sim.window.requestQuit({ stacks: 1, pulls: 0, builds: 0, terminals: 0 }); api.sim.window.requestQuit({ stacks: 0, pulls: 1, builds: 0, terminals: 0 }) })
    const dlg = await screen.findByRole('alertdialog', { name: '¿Salir de DockInng?' })
    expect(within(dlg).queryByText(/descarga/)).toBeNull()
    await u.click(within(dlg).getByRole('button', { name: 'Seguir en DockInng' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.sim.window.calls).toEqual([])
  })
})
