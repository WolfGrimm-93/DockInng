// Aplica el tema al documento. Contrato:
//   resolveMode(prefs.mode) -> 'light'|'dark'       ('system' sigue prefers-color-scheme)
//   applyTheme(prefs, {mode?: 'light'|'dark'})      hoja <style id="dk-theme"> (o la quita si son los tokens de fábrica), clase .dark,
//                                                   <meta name="theme-color">. Usa hex si el motor no soporta oklch().
//   watchSystemMode(cb) -> unsubscribe               notifica cuando cambia prefers-color-scheme
import { buildThemeCss, computeColors, resolveInput } from './engine'
import { toHex } from './oklch'
import type { ThemeMode, ThemePrefs } from './types'

const STYLE_ID = 'dk-theme'
const mq = (): MediaQueryList | null => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null)

export function resolveMode(m: ThemeMode): 'light' | 'dark' {
  if (m === 'system') return mq()?.matches ? 'dark' : 'light'
  return m
}

function supportsOklch(): boolean {
  try { return typeof CSS !== 'undefined' && !!CSS.supports && CSS.supports('color', 'oklch(0 0 0)') } catch { return true }
}

export function applyTheme(p: ThemePrefs, o: { mode?: 'light' | 'dark'; keepMode?: boolean } = {}): 'light' | 'dark' {
  const doc = document
  const css = buildThemeCss(p, { fallbackHex: !supportsOklch() })
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (css) {
    if (!el) {
      el = doc.createElement('style')
      el.id = STYLE_ID
      doc.head.appendChild(el)
    }
    if (el.textContent !== css) el.textContent = css
  } else el?.remove()
  const mode = o.mode ?? resolveMode(p.mode)
  if (!o.keepMode) doc.documentElement.classList.toggle('dark', mode === 'dark')
  const meta = doc.querySelector('meta[name="theme-color"]')
  // <meta name="theme-color"> = fondo del tema efectivo (hex calculado por el motor: válido en cualquier navegador).
  meta?.setAttribute('content', toHex(computeColors(resolveInput(p), mode)['--background'].color))
  return mode
}

export function watchSystemMode(cb: () => void): () => void {
  const m = mq()
  if (!m) return () => {}
  m.addEventListener('change', cb)
  return () => m.removeEventListener('change', cb)
}
