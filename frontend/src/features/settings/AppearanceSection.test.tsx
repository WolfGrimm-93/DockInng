import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSimApi } from '@/data/adapters/sim'
import { EngineProvider } from '@/data/EngineProvider'
import { CSS_KEY, PREFS_KEY, loadPrefs } from '@/theme/prefs'
import { DEFAULT_PREFS } from '@/theme/presets'
import { useThemeStore } from '@/theme/useTheme'
import { AppearanceSection } from './AppearanceSection'

const mount = () => render(<EngineProvider api={createSimApi({ latency: 0 })}><AppearanceSection /></EngineProvider>)
const accent = (name: string, o: { checked?: boolean } = {}) => within(screen.getByRole('radiogroup', { name: 'Color de acento' })).getByRole('radio', { name, ...o })
const style = () => document.getElementById('dk-theme')?.textContent ?? ''

beforeEach(() => {
  localStorage.clear()
  document.getElementById('dk-theme')?.remove()
  document.documentElement.className = 'dark'
  useThemeStore.setState({ prefs: DEFAULT_PREFS, resolvedMode: 'dark' })
})

describe('AppearanceSection', () => {
  it('semántica: radiogroups con aria-checked y un solo elemento tabulable por grupo', () => {
    mount()
    for (const name of ['Tema', 'Combinaciones', 'Color de acento', 'Tinte de las superficies', 'Intensidad del tinte']) {
      const g = screen.getByRole('radiogroup', { name })
      const radios = within(g).getAllByRole('radio')
      expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true').length).toBeLessThanOrEqual(1)
      expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1)
    }
    expect(accent('Esmeralda')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /Bosque/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Oscuro' })).toHaveAttribute('aria-checked', 'true')
  })
  it('cambiar el acento aplica variables CSS al documento y persiste; los estados no cambian', async () => {
    const u = userEvent.setup()
    mount()
    expect(style()).toBe('')
    await u.click(accent('Azul'))
    expect(style()).toContain('html:root{--background:oklch(')
    expect(style()).toContain('--primary:oklch(')
    expect(style()).not.toContain('--status-running')
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY)!)
    expect(saved).toMatchObject({ v: 1, accent: { preset: 'blue' } })
    expect(localStorage.getItem(CSS_KEY)).toContain('"algo":1')
    expect(accent('Azul')).toHaveAttribute('aria-checked', 'true')
  })
  it('teclado: flechas mueven la selección del acento y Home/End saltan', async () => {
    const u = userEvent.setup()
    mount()
    accent('Esmeralda').focus()
    await u.keyboard('{ArrowRight}')
    expect(accent('Teal')).toHaveFocus()
    expect(accent('Teal')).toHaveAttribute('aria-checked', 'true')
    await u.keyboard('{End}')
    expect(accent('Personalizado', { checked: true })).toHaveFocus()
    await u.keyboard('{Home}')
    expect(accent('Esmeralda')).toHaveAttribute('aria-checked', 'true')
  })
  it('combinación con nombre: aplica acento + tinte + intensidad; Bosque vuelve a los tokens de fábrica', async () => {
    const u = userEvent.setup()
    mount()
    await u.click(screen.getByRole('radio', { name: /Atardecer/ }))
    expect(loadPrefs()).toMatchObject({ accent: { preset: 'orange' }, tint: { hue: 60 } })
    expect(style()).not.toBe('')
    await u.click(screen.getByRole('radio', { name: /Sakura/ }))
    expect(loadPrefs().strength).toBe('soft')
    await u.click(screen.getByRole('radio', { name: /Bosque/ }))
    expect(style()).toBe('')
  })
  it('acento personalizado: matiz con vista previa, número y aviso de choque no bloqueante', async () => {
    const u = userEvent.setup()
    mount()
    await u.click(accent('Personalizado', { checked: false }))
    const num = screen.getByLabelText('Matiz del acento en grados')
    await u.clear(num)
    await u.type(num, '128')
    expect(loadPrefs().accent).toEqual({ hue: 128 })
    expect(screen.getByText('Este color se parece al de un estado')).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
    await u.clear(num)
    await u.type(num, '250')
    expect(screen.queryByText('Este color se parece al de un estado')).not.toBeInTheDocument()
    expect(screen.getByText(/Texto sobre botón/)).toHaveTextContent(/:1 · AA/)
  })
  it('ámbar en claro avisa del tono bronce', async () => {
    const u = userEvent.setup()
    document.documentElement.classList.remove('dark')
    useThemeStore.setState({ resolvedMode: 'light', prefs: { ...DEFAULT_PREFS, mode: 'light' } })
    mount()
    await u.click(accent('Ámbar'))
    expect(screen.getByText(/tono bronce/)).toBeInTheDocument()
  })
  it('modo: claro/oscuro/sistema cambian la clase de <html>; sistema reacciona a prefers-color-scheme', async () => {
    const u = userEvent.setup()
    let listener: (() => void) | null = null
    let dark = false
    const orig = window.matchMedia
    window.matchMedia = ((q: string) => ({ get matches() { return dark }, media: q, addEventListener: (_: string, l: () => void) => { listener = l }, removeEventListener() {} })) as unknown as typeof window.matchMedia
    const { ThemeProvider } = await import('@/theme/ThemeProvider')
    render(<EngineProvider api={createSimApi({ latency: 0 })}><ThemeProvider><AppearanceSection /></ThemeProvider></EngineProvider>)
    await u.click(screen.getByRole('radio', { name: 'Claro' }))
    expect(document.documentElement).not.toHaveClass('dark')
    await u.click(screen.getByRole('radio', { name: 'Sistema' }))
    expect(document.documentElement).not.toHaveClass('dark')
    dark = true
    await waitFor(() => expect(listener).not.toBeNull())
    listener!()
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'))
    expect(screen.getByText(/ahora: Oscuro/)).toBeInTheDocument()
    window.matchMedia = orig
  })
  it('Restablecer colores conserva el modo y la maqueta de vista previa es decorativa (aria-hidden)', async () => {
    const u = userEvent.setup()
    document.documentElement.classList.remove('dark')
    useThemeStore.setState({ resolvedMode: 'light', prefs: { ...DEFAULT_PREFS, mode: 'light' } })
    const { container } = mount()
    expect(container.querySelector('.preview-box')).toHaveAttribute('aria-hidden', 'true')
    await u.click(screen.getByRole('radio', { name: /Océano/ }))
    await u.click(screen.getByRole('button', { name: 'Restablecer colores' }))
    expect(loadPrefs().mode).toBe('light')
    expect(loadPrefs().accent).toEqual({ preset: 'emerald' })
    expect(document.documentElement).not.toHaveClass('dark')
  })
  it('Restablecer vuelve a los valores de fábrica y borra la hoja cacheada', async () => {
    const u = userEvent.setup()
    mount()
    const reset = screen.getByRole('button', { name: /Restablecer colores/ })
    expect(reset).toBeDisabled()
    await u.click(screen.getByRole('radio', { name: /Océano/ }))
    expect(localStorage.getItem(CSS_KEY)).not.toBeNull()
    await u.click(reset)
    expect(style()).toBe('')
    expect(localStorage.getItem(CSS_KEY)).toBeNull()
    expect(loadPrefs()).toEqual(DEFAULT_PREFS)
  })
  it('intensidad deshabilitada con tinte neutro', async () => {
    const u = userEvent.setup()
    mount()
    await u.click(screen.getByRole('radio', { name: 'Neutro' }))
    expect(screen.getByRole('radio', { name: 'Suave' })).toBeDisabled()
  })
})

describe('preferencias corruptas', () => {
  it.each(['{no es json', '"x"', '{"v":2}', '{"v":1,"mode":"neon","accent":{"preset":"emerald"},"tint":"follow","strength":"normal"}', '{"v":1,"mode":"dark","accent":{"hue":999},"tint":"follow","strength":"normal"}', 'null'])('cae a defaults: %s', (raw) => {
    localStorage.setItem(PREFS_KEY, raw)
    expect(loadPrefs()).toEqual(DEFAULT_PREFS)
  })
  it('storage que lanza excepciones no rompe carga ni guardado', async () => {
    const boom = { getItem() { throw new Error('x') }, setItem() { throw new Error('x') }, removeItem() { throw new Error('x') } }
    const { savePrefs } = await import('@/theme/prefs')
    expect(loadPrefs(boom)).toEqual(DEFAULT_PREFS)
    expect(() => savePrefs(DEFAULT_PREFS, boom)).not.toThrow()
  })
})
