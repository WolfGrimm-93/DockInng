import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppShell } from '@/app/AppShell'
import { Providers } from '@/app/providers'
import { createSimApi } from '@/data/adapters/sim'
import { loadPrefs, savePrefs } from '@/theme/prefs'
import { DEFAULT_PREFS } from '@/theme/presets'
import { useThemeStore } from '@/theme/useTheme'
import { clearMemoryStorage, safeStorage } from './safeStorage'

const real = Object.getOwnPropertyDescriptor(window, 'localStorage')!
beforeEach(() => {
  clearMemoryStorage()
  Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError') } })
})
afterEach(() => Object.defineProperty(window, 'localStorage', real))

describe('almacenamiento bloqueado (SecurityError al acceder a window.localStorage)', () => {
  it('safeStorage nunca lanza y funciona en memoria', () => {
    const s = safeStorage()
    expect(s.getItem('a')).toBeNull()
    s.setItem('a', '1')
    expect(s.getItem('a')).toBe('1')
    s.removeItem('a')
    expect(s.getItem('a')).toBeNull()
  })
  it('las prefs de tema se cargan (defaults) y se guardan en memoria', () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS)
    savePrefs({ ...DEFAULT_PREFS, accent: { preset: 'blue' } })
    expect(loadPrefs().accent).toEqual({ preset: 'blue' })
  })
  it('la app MONTA y el tema funciona en memoria', async () => {
    render(<Providers api={createSimApi({ latency: 0 })}><AppShell /></Providers>)
    expect(await screen.findByText('Saltar al contenido')).toBeInTheDocument()
    useThemeStore.getState().setPrefs({ ...DEFAULT_PREFS, accent: { preset: 'violet' } })
    expect(document.getElementById('dk-theme')?.textContent).toContain('--primary')
    useThemeStore.getState().setPrefs(DEFAULT_PREFS)
  })
})
