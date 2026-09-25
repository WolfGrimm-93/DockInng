// El script inline de index.html debe producir el mismo estado que applyTheme (paridad) y usar la misma versión de algoritmo.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyTheme } from './apply'
import { THEME_ALGO } from './engine'
import { CSS_KEY, PREFS_KEY, ensureCssCache, savePrefs, themeSig } from './prefs'
import { COMBOS, DEFAULT_PREFS } from './presets'
import type { ThemePrefs } from './types'

const html = readFileSync(path.resolve(import.meta.dirname, '../../index.html'), 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]

function runScript() {
  document.documentElement.className = 'dark no-anim'
  document.getElementById('dk-theme')?.remove()
  new Function(script)()
  return { dark: document.documentElement.classList.contains('dark'), css: document.getElementById('dk-theme')?.textContent ?? '' }
}
const combo = (id: string, mode: ThemePrefs['mode']): ThemePrefs => {
  const c = COMBOS.find((x) => x.id === id)!
  return { v: 1, mode, accent: c.accent, tint: c.tint, strength: c.strength }
}

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/')
  document.getElementById('dk-theme')?.remove()
})

describe('script pre-pintado', () => {
  it('la versión del algoritmo coincide con THEME_ALGO', () => {
    expect(script).toContain(`c.algo === ${THEME_ALGO}`)
  })
  it('sin nada guardado: oscuro, sin hoja', () => {
    expect(runScript()).toEqual({ dark: true, css: '' })
  })
  it.each(['oceano', 'atardecer', 'miel'])('paridad con applyTheme para «%s» (claro y oscuro)', (id) => {
    for (const mode of ['light', 'dark'] as const) {
      const p = combo(id, mode)
      savePrefs(p)
      const pre = runScript()
      applyTheme(p)
      expect(pre.dark).toBe(document.documentElement.classList.contains('dark'))
      expect(pre.css).toBe(document.getElementById('dk-theme')!.textContent)
      expect(pre.css.length).toBeGreaterThan(100)
    }
  })
  it('por defecto no hay hoja cacheada y modo claro se respeta', () => {
    savePrefs({ ...DEFAULT_PREFS, mode: 'light' })
    expect(localStorage.getItem(CSS_KEY)).toBeNull()
    expect(runScript()).toEqual({ dark: false, css: '' })
  })
  it('modo sistema sigue prefers-color-scheme', () => {
    const orig = window.matchMedia
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    savePrefs({ ...DEFAULT_PREFS, mode: 'system' })
    expect(runScript().dark).toBe(true)
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    expect(runScript().dark).toBe(false)
    window.matchMedia = orig
  })
  it('valores corruptos o versión distinta de la hoja: no rompe y no inyecta', () => {
    localStorage.setItem(PREFS_KEY, '{no es json')
    localStorage.setItem(CSS_KEY, JSON.stringify({ algo: 99, css: 'html{}' }))
    expect(runScript()).toEqual({ dark: true, css: '' })
  })
  it('?theme=light gana sobre lo guardado', () => {
    savePrefs({ ...DEFAULT_PREFS, mode: 'dark' })
    window.history.replaceState({}, '', '/?theme=light')
    expect(runScript().dark).toBe(false)
  })
  it('migra el valor heredado dockinng.theme', () => {
    localStorage.setItem('dockinng.theme', 'light')
    expect(runScript().dark).toBe(false)
  })
})


describe('pre-pintado: validación completa y hoja obsoleta', () => {
  const okPrefs = { v: 1, mode: 'light', accent: { preset: 'blue' }, tint: 'follow', strength: 'normal' }
  const setup = (prefs: unknown, cache?: unknown) => {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    if (cache !== undefined) localStorage.setItem(CSS_KEY, JSON.stringify(cache))
  }
  it.each([
    ['matiz fuera de rango', { ...okPrefs, accent: { hue: 999 } }],
    ['intensidad inválida', { ...okPrefs, strength: 'ultra' }],
    ['id de acento inexistente', { ...okPrefs, accent: { preset: 'lima' } }],
    ['tinte inválido', { ...okPrefs, tint: { preset: 'x' } }],
    ['versión distinta', { ...okPrefs, v: 2 }],
  ])('%s: valores de fábrica (oscuro, sin hoja) aunque el modo sea válido', (_n, prefs) => {
    setup(prefs, { algo: 1, sig: 'x', css: 'html:root{--primary:red}', hex: 'html:root{--primary:red}' })
    expect(runScript()).toEqual({ dark: true, css: '' })
  })
  it('hoja obsoleta (sig distinta): NO se pinta ni un instante; ensureCssCache la regenera y entonces sí', () => {
    setup(okPrefs, { algo: 1, sig: themeSig({ accent: { preset: 'red' }, tint: 'follow', strength: 'normal' }), css: 'html:root{--primary:red}', hex: 'x' })
    expect(runScript().css).toBe('')
    ensureCssCache(okPrefs as never)
    const pre = runScript()
    expect(pre.css).toContain('html:root{--background:oklch(')
    expect(pre.css).not.toContain('red')
  })
  it('subir THEME_ALGO invalida la hoja: el script la ignora (algo distinto) y ensureCssCache la reescribe', () => {
    setup(okPrefs, { algo: THEME_ALGO + 1, sig: themeSig(okPrefs as never), css: 'html:root{--primary:red}', hex: 'x' })
    expect(runScript().css).toBe('')
    ensureCssCache(okPrefs as never)
    expect(JSON.parse(localStorage.getItem(CSS_KEY)!).algo).toBe(THEME_ALGO)
  })
  it('<meta name="theme-color"> sigue al fondo del tema efectivo', () => {
    const m = document.createElement('meta')
    m.setAttribute('name', 'theme-color')
    document.head.appendChild(m)
    applyTheme({ ...DEFAULT_PREFS, mode: 'light' })
    const light = m.getAttribute('content')
    applyTheme({ ...DEFAULT_PREFS, mode: 'dark' })
    expect(light).toMatch(/^#[0-9a-f]{6}$/)
    expect(light).not.toBe(m.getAttribute('content'))
    m.remove()
  })
})
