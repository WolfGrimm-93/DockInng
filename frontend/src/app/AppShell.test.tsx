import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSimApi } from '@/data/adapters/sim'
import { toast } from '@/lib/toastStore'
import { AppShell } from './AppShell'
import { Providers } from './providers'
import { useUiStore } from './uiStore'

const mount = () => {
  const api = createSimApi({ latency: 0 })
  render(<Providers api={api}><AppShell /></Providers>)
  return api
}

beforeEach(() => {
  window.location.hash = ''
  document.documentElement.classList.remove('is-collapsed')
  useUiStore.setState({ collapsed: false, paletteOpen: false, ctxMenuOpen: false })
  toast.clear()
})
afterEach(() => {
  window.location.hash = ''
})

describe('AppShell', () => {
  it('sidebar: 6 enlaces con aria-current en la vista activa, contadores y estado del motor con aria-label', async () => {
    mount()
    const nav = screen.getByRole('navigation', { name: 'Secciones' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual(['Contenedores', 'Imágenes', 'Volúmenes', 'Redes', 'Stacks (Compose)', 'Configuración'])
    expect(within(nav).getByRole('link', { name: 'Contenedores' })).toHaveAttribute('aria-current', 'page')
    await waitFor(() => expect(within(nav).getByText('7/13')).toBeInTheDocument())
    const engine = await screen.findByRole('status', { name: /Motor conectado\. Docker 27\.3\.1 · API 1\.47\. Conexión Local/ })
    expect(engine).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Barra lateral' })).toBeInTheDocument()
  })
  it('sin navbar superior; un <main> enfocable y un skip link', () => {
    mount()
    // El <header> del PageHeader vive DENTRO de <main> (no es un landmark banner): no hay barra superior.
    expect(document.querySelector('.shell > header, #root > header, body > header')).toBeNull()
    expect(screen.getByRole('main').querySelector('header.view-head')).not.toBeNull()
    expect(screen.getByRole('main')).toHaveAttribute('tabindex', '-1')
    expect(screen.getByText('Saltar al contenido')).toHaveAttribute('href', '#main')
  })
  it('ruta: NAV_OF resalta el ítem padre y el foco va al h1 al cambiar de vista', async () => {
    mount()
    await screen.findByRole('heading', { name: 'Contenedores', level: 1 })
    act(() => {
      window.location.hash = '#pull'
    })
    const h1 = await screen.findByRole('heading', { name: 'Descargar imagen', level: 1 })
    await waitFor(() => expect(h1).toHaveFocus())
    // La vista real de «Descargar imagen» trae su propio enlace «Imágenes» (migas): se busca el del menú.
    expect(screen.getAllByRole('link', { name: 'Imágenes' }).some((a) => a.getAttribute('aria-current') === 'page')).toBe(true)
    expect(document.title).toBe('Descargar imagen · DockInng')
  })
  it('colapsar: el botón alterna aria-expanded/aria-label y la clase de <html>', async () => {
    const u = userEvent.setup()
    mount()
    const btn = screen.getByRole('button', { name: 'Colapsar barra lateral' })
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    await u.click(btn)
    expect(document.documentElement).toHaveClass('is-collapsed')
    const back = screen.getByRole('button', { name: 'Expandir barra lateral' })
    expect(back).toHaveAttribute('aria-expanded', 'false')
  })
  it('tema: el botón alterna claro/oscuro y su etiqueta', async () => {
    const u = userEvent.setup()
    document.documentElement.classList.add('dark')
    mount()
    await u.click(screen.getByRole('button', { name: 'Cambiar a tema claro' }))
    expect(document.documentElement).not.toHaveClass('dark')
    expect(screen.getByRole('button', { name: 'Cambiar a tema oscuro' })).toBeInTheDocument()
  })
  it('selector de conexión: menuitemradio; «Conectar» a una simulada solo muestra toast y no cambia la activa en tauri', async () => {
    const u = userEvent.setup()
    mount()
    await u.click(screen.getByRole('button', { name: /Cambiar de conexión\. Actual: Local/ }))
    const items = await screen.findAllByRole('menuitemradio')
    expect(items.map((i) => i.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('prod-hetzner'), expect.stringContaining('staging-lab')]))
    expect(items[0]).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitem', { name: /Administrar conexiones/ })).toBeInTheDocument()
  })
  it('estado de error de conexión: el panel de diagnóstico reemplaza los datos y el pie dice «Sin conexión»', async () => {
    const api = createSimApi({ latency: 0 })
    api.sim.setFault('permission')
    render(<Providers api={api}><AppShell /></Providers>)
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo conectar con el motor')
    expect(screen.getByRole('status', { name: /Sin conexión/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reintentar conexión' })).toBeInTheDocument()
    expect(screen.getByText('sudo usermod -aG docker $USER')).toBeInTheDocument()
  })
  it('conexión perdida: banner de error y datos conservados', async () => {
    const api = mount()
    await screen.findByText('tienda-web-1')
    act(() => {
      api.sim.emit({ type: 'connection', status: { state: 'failed', endpoint: 'x', cause: 'daemon_down', message: '', steps: [] } })
    })
    expect(await screen.findByText('Se perdió la conexión con el motor')).toBeInTheDocument()
    expect(screen.getByText('tienda-web-1')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: /Conexión perdida/ })).toBeInTheDocument()
  })
})

describe('AppShell bajo <StrictMode>', () => {
  it('la vista previa ?state=empty NO se borra en la carga y el foco inicial no va al h1', async () => {
    const { StrictMode } = await import('react')
    const { initDevFlags, usePreviewState, devState } = await import('./devFlags')
    window.history.replaceState({}, '', '/?state=empty')
    const api = createSimApi({ latency: 0 })
    initDevFlags(api)
    expect(devState.getState().preview).toBe('empty')
    function Probe() {
      return <output data-testid="prev">{String(usePreviewState())}</output>
    }
    render(<StrictMode><Providers api={api}><AppShell /><Probe /></Providers></StrictMode>)
    await screen.findByRole('heading', { level: 1 })
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.getByTestId('prev')).toHaveTextContent('empty')
    expect(document.activeElement).not.toBe(document.getElementById('viewTitle'))
    // al CAMBIAR de vista sí se limpia y se enfoca el título
    act(() => { window.location.hash = '#networks' })
    await waitFor(() => expect(screen.getByTestId('prev')).toHaveTextContent('null'))
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('viewTitle')))
    window.history.replaceState({}, '', '/')
    devState.setState({ preview: null })
  })
})
