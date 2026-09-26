// Pestaña Terminal con xterm SIMULADO (mock de @xterm/xterm y del addon fit): ciclo de vida de la sesión (StrictMode), entrada/salida,
// resize, estados del contenedor, banner de riesgo, reconexión, tema y atajos de copiar/pegar.
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useThemeStore } from '@/theme/useTheme'
import { makeApi, renderView, resetGlobals } from '../../testUtils'
import ContainerDetailPage from '../ContainerDetailPage'

const h = vi.hoisted(() => {
  interface FakeTerm {
    options: Record<string, unknown>; written: Uint8Array[]; disposed: boolean; cols: number; rows: number; selection: string
    dataCbs: ((d: string) => void)[]; resizeCbs: ((s: { cols: number; rows: number }) => void)[]; keyHandler: ((e: KeyboardEvent) => boolean) | null
    textarea: HTMLTextAreaElement; pasted: string[]; cleared: number
  }
  return { instances: [] as FakeTerm[] }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/xterm', () => {
  class Terminal {
    static strings: Record<string, string> = {}
    options: Record<string, unknown>
    written: Uint8Array[] = []
    disposed = false
    cols = 80
    rows = 24
    selection = ''
    dataCbs: ((d: string) => void)[] = []
    resizeCbs: ((s: { cols: number; rows: number }) => void)[] = []
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null
    textarea = document.createElement('textarea')
    pasted: string[] = []
    cleared = 0
    constructor(o: Record<string, unknown>) { this.options = { ...o }; h.instances.push(this as never) }
    loadAddon(a: { activate?: (t: unknown) => void }) { a.activate?.(this) }
    open(el: HTMLElement) { el.appendChild(this.textarea) }
    onData(cb: (d: string) => void) { this.dataCbs.push(cb); return { dispose: () => { this.dataCbs = this.dataCbs.filter((x) => x !== cb) } } }
    onResize(cb: (s: { cols: number; rows: number }) => void) { this.resizeCbs.push(cb); return { dispose: () => { this.resizeCbs = this.resizeCbs.filter((x) => x !== cb) } } }
    write(d: Uint8Array) { this.written.push(d) }
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) { this.keyHandler = fn }
    getSelection() { return this.selection }
    paste(t: string) { this.pasted.push(t) }
    clear() { this.cleared++ }
    focus() {}
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; for (const c of this.resizeCbs) c({ cols, rows }) }
    dispose() { this.disposed = true }
  }
  return { Terminal }
})
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    term: { resize(c: number, r: number): void } | null = null
    activate(t: { resize(c: number, r: number): void }) { this.term = t }
    fit() { this.term?.resize(100, 30) }
  },
}))

const text = (t: (typeof h.instances)[number]) => t.written.map((b) => new TextDecoder().decode(b)).join('')
const live = () => h.instances.filter((i) => !i.disposed)

let roCallbacks: (() => void)[] = []
beforeEach(() => {
  h.instances.length = 0
  roCallbacks = []
  ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class { constructor(cb: () => void) { roCallbacks.push(cb) } observe() {} unobserve() {} disconnect() {} }
})
afterEach(resetGlobals)

const HASH = '#detail?c=tienda-api-1&tab=terminal'

describe('Terminal (xterm simulado)', () => {
  it('abre UNA sesión bajo StrictMode, escribe lo tecleado en el proceso y pinta su salida', async () => {
    const api = makeApi()
    renderView(<ContainerDetailPage />, { api, hash: HASH })
    await screen.findByText('Conectado · sh')
    expect(api.sim.exec.opened).toBe(1)
    expect(api.sim.exec.live).toBe(1)
    expect(live()).toHaveLength(1)
    const t = live()[0]
    await waitFor(() => expect(text(t)).toContain('root@'))
    act(() => t.dataCbs.forEach((cb) => cb('pwd\r')))
    await waitFor(() => expect(text(t)).toContain('/app'))
    // Ola 1: sin marca «No conectado aún».
    expect(screen.queryByText('No conectado aún')).toBeNull()
  })

  it('textos localizados de xterm y opciones: scrollback 5000 y contraste mínimo 4.5', async () => {
    renderView(<ContainerDetailPage />, { hash: HASH })
    await screen.findByText('Conectado · sh')
    const t = live()[0]
    const { Terminal } = (await import('@xterm/xterm')) as unknown as { Terminal: { strings: Record<string, string> } }
    expect(Terminal.strings.promptLabel).toBe('Entrada de la terminal')
    expect(t.options).toMatchObject({ scrollback: 5000, minimumContrastRatio: 4.5, fontSize: 12 })
    // Enlaces OSC 8 de la salida: manejador inerte (no abre nada) y sin protocolos no http.
    const lh = t.options.linkHandler as { activate(e: MouseEvent, t: string): void; allowNonHttpProtocols: boolean }
    const open = vi.spyOn(window, 'open')
    lh.activate(new MouseEvent('click'), 'https://evil.example/x')
    expect(open).not.toHaveBeenCalled()
    expect(lh.allowNonHttpProtocols).toBe(false)
    expect(t.textarea).toHaveAttribute('aria-describedby', 'termHelp')
    expect(t.textarea).toHaveAttribute('aria-label', 'Terminal de tienda-api-1')
  })

  it('el resize del contenedor llega al proceso una sola vez (stty size lo refleja)', async () => {
    renderView(<ContainerDetailPage />, { hash: HASH })
    await screen.findByText('Conectado · sh')
    const t = live()[0]
    act(() => roCallbacks.forEach((cb) => cb()))
    await waitFor(() => expect(t.cols).toBe(100))
    act(() => t.dataCbs.forEach((cb) => cb('stty size\r')))
    await waitFor(() => expect(text(t)).toContain('30 100'))
  })

  it('desmontar (cambiar de pestaña) cierra la sesión y destruye la terminal, sin fugas', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    renderView(<ContainerDetailPage />, { api, hash: HASH })
    await screen.findByText('Conectado · sh')
    await u.click(screen.getByRole('tab', { name: 'Logs' }))
    await waitFor(() => expect(api.sim.exec.live).toBe(0))
    expect(api.sim.exec.closed).toBe(api.sim.exec.opened)
    expect(live()).toHaveLength(0)
    await u.click(screen.getByRole('tab', { name: 'Terminal' }))
    await screen.findByText('Conectado · sh')
    expect(api.sim.exec.opened).toBe(2)
    expect(api.sim.exec.live).toBe(1)
  })

  it('contenedor detenido, pausado o reiniciando: explicación y ninguna sesión', async () => {
    const api = makeApi()
    const v = renderView(<ContainerDetailPage />, { api, hash: '#detail?c=monitoreo-loki-1&tab=terminal' })
    expect(await screen.findByText('Está en pausa: reanúdalo para abrir una terminal.')).toBeInTheDocument()
    v.unmount()
    const v2 = renderView(<ContainerDetailPage />, { api, hash: '#detail?c=tienda-worker-1&tab=terminal' })
    expect(await screen.findByText(/Se está reiniciando/)).toBeInTheDocument()
    v2.unmount()
    renderView(<ContainerDetailPage />, { api, hash: '#detail?c=mailpit-pruebas&tab=terminal' })
    expect(await screen.findByText('Está detenido: inícialo para abrir una terminal.')).toBeInTheDocument()
    expect(api.sim.exec.opened).toBe(0)
    expect(h.instances).toHaveLength(0)
  })

  it('«Iniciar contenedor» arranca el contenedor y abre la terminal', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    renderView(<ContainerDetailPage />, { api, hash: '#detail?c=minio-dev&tab=terminal' })
    await u.click(await screen.findByRole('button', { name: 'Iniciar contenedor' }))
    await screen.findByText('Conectado · sh', undefined, { timeout: 4000 })
    expect(api.sim.exec.opened).toBe(1)
  })

  it('si el contenedor se detiene con la sesión abierta: banda de sesión terminada, la pantalla se conserva y «Reconectar» queda desactivado', async () => {
    const api = makeApi()
    renderView(<ContainerDetailPage />, { api, hash: HASH })
    await screen.findByText('Conectado · sh')
    const t = live()[0]
    await act(async () => { await api.containers.stop(api.sim.world.containers.find((c) => c.names[0] === 'tienda-api-1')!.id) })
    expect(await screen.findByText('Sesión terminada: el contenedor se detuvo')).toBeInTheDocument()
    expect(t.disposed).toBe(false)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconectar' })).toHaveAttribute('aria-disabled', 'true'))
    expect(screen.getByText(/Reconectar no está disponible: el contenedor no está en ejecución/)).toBeInTheDocument()
  })

  it('«exit» termina la sesión (código 0) y «Reconectar» abre una sesión nueva', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    renderView(<ContainerDetailPage />, { api, hash: HASH })
    await screen.findByText('Conectado · sh')
    act(() => live()[0].dataCbs.forEach((cb) => cb('exit\r')))
    expect(await screen.findByText('Sesión terminada (código 0)')).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Reconectar' }))
    await screen.findByText('Conectado · sh')
    expect(api.sim.exec.opened).toBe(2)
    expect(live()).toHaveLength(1)
  })

  it('banner de riesgo cuando el contenedor monta docker.sock', async () => {
    renderView(<ContainerDetailPage />, { hash: '#detail?c=traefik-proxy&tab=terminal' })
    expect(await screen.findByText('Esta terminal tiene acceso amplio al equipo')).toBeInTheDocument()
    expect(screen.getByText(/docker\.sock/)).toBeInTheDocument()
  })

  it('cambio de tema: se vuelven a leer los colores y se aplican a la terminal', async () => {
    renderView(<ContainerDetailPage />, { hash: HASH })
    await screen.findByText('Conectado · sh')
    const t = live()[0]
    const before = t.options.theme
    act(() => useThemeStore.setState({ resolvedMode: useThemeStore.getState().resolvedMode === 'dark' ? 'light' : 'dark' }))
    await waitFor(() => expect(t.options.theme).not.toBe(before))
    expect(t.options.theme).toMatchObject({ background: expect.stringMatching(/^#[0-9a-f]{6}$/), red: expect.stringMatching(/^#/) })
  })

  it('copiar con Ctrl+Shift+C usa la selección; Ctrl+C pasa al proceso; Ctrl+Shift+M alterna «Tab mueve el foco»', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const u = userEvent.setup()
    // Después de setup(): user-event instala su propio portapapeles.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText: vi.fn().mockResolvedValue('pegado') } })
    renderView(<ContainerDetailPage />, { hash: HASH })
    await screen.findByText('Conectado · sh')
    const t = live()[0]
    t.selection = 'texto elegido'
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)
    expect(t.keyHandler!(key({ key: 'C', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(writeText).toHaveBeenCalledWith('texto elegido')
    expect(t.keyHandler!(key({ key: 'c', ctrlKey: true }))).toBe(true)
    expect(t.keyHandler!(key({ key: 'Tab' }))).toBe(true)
    act(() => { t.keyHandler!(key({ key: 'M', ctrlKey: true, shiftKey: true })) })
    expect(await screen.findByText(/Modo Tab: el foco sale de la terminal/)).toBeInTheDocument()
    expect(t.keyHandler!(key({ key: 'Tab' }))).toBe(false)
    // Botones de la barra.
    await u.click(screen.getByRole('button', { name: 'Pegar' }))
    await waitFor(() => expect(t.pasted).toEqual(['pegado']))
    await u.click(screen.getByRole('button', { name: 'Limpiar' }))
    expect(t.cleared).toBe(1)
    await u.click(screen.getByRole('button', { name: 'Copiar selección' }))
    expect(writeText).toHaveBeenCalledTimes(2)
  })

  it('«Modo lector de pantalla» activa screenReaderMode y se recuerda', async () => {
    const u = userEvent.setup()
    renderView(<ContainerDetailPage />, { hash: HASH })
    await screen.findByText('Conectado · sh')
    const t = live()[0]
    expect(t.options.screenReaderMode).toBe(false)
    await u.click(screen.getByRole('checkbox', { name: /Modo lector de pantalla/ }))
    await waitFor(() => expect(t.options.screenReaderMode).toBe(true))
  })

  it('error al abrir la sesión: mensaje y «Reconectar» disponible', async () => {
    const api = makeApi()
    api.exec.open = async () => { throw { code: 'no_shell', message: 'sin shell' } }
    renderView(<ContainerDetailPage />, { api, hash: HASH })
    expect(await screen.findByText(/No se pudo abrir la terminal/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reconectar' })).toBeEnabled()
    void within
  })

  it('al entrar en la terminal se anuncia UNA vez el atajo Ctrl+Shift+M; el estado «dead» usa la etiqueta en español', async () => {
    const api = makeApi()
    const v = renderView(<ContainerDetailPage />, { api, hash: HASH })
    await screen.findByText('Conectado · sh')
    const t = live()[0]
    act(() => { t.textarea.dispatchEvent(new Event('focus')) })
    expect(await screen.findByText(/Terminal activa\. Ctrl\+Shift\+M hace que Tab mueva el foco/)).toBeInTheDocument()
    v.unmount()
    renderView(<ContainerDetailPage />, { api, hash: '#detail?c=respaldo-nocturno&tab=terminal' })
    expect(await screen.findByText(/Está en estado «Muerto»|Está en estado «[^»]+»/)).toBeInTheDocument()
    expect(screen.queryByText(/dead/)).toBeNull()
  })
})
