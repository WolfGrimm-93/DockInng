import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { clampChroma, converter, formatHex, wcagContrast } from 'culori'
import { describe, expect, it } from 'vitest'
import { auditTheme, buildThemeCss, computeColors, computeTokens, isDefaultLook, resolveInput, THEME_ALGO } from './engine'
import { clipChroma, contrast, deltaEOK, oklchToLinear, parseOklch, toHex } from './oklch'
import { COMBOS, DEFAULT_PREFS, stateClash } from './presets'
import type { ResolvedInput } from './types'

const toRgb = converter('rgb')

describe('barrido de contraste (AA garantizado para cualquier acento × tinte × intensidad × modo)', () => {
  it('0 fallos y mínimos observados', () => {
    let n = 0
    const fails: string[] = []
    const mins: Record<string, number> = {}
    const tints: (number | 'follow' | 'neutral')[] = ['follow', 'neutral']
    for (let t = 0; t < 360; t += 15) tints.push(t)
    for (let ha = 0; ha < 360; ha += 5) {
      for (const t of tints) {
        for (const k of t === 'neutral' ? [0] : [0.6, 1, 1.8]) {
          const input: ResolvedInput = { accentHue: ha, tintHue: t === 'follow' || t === 'neutral' ? ha : t, tintChroma: k }
          for (const mode of ['light', 'dark'] as const) {
            n++
            for (const c of auditTheme(input, mode)) {
              const key = `${mode}:${c.pair.replace(/\/ .*/, '/*')}`
              mins[key] = Math.min(mins[key] ?? 99, c.ratio)
              if (!c.pass) fails.push(`${mode} ha=${ha} t=${t} k=${k} ${c.pair} ${c.ratio.toFixed(2)} < ${c.min}`)
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThan(10000)
    expect(fails.slice(0, 10)).toEqual([])
    // Mínimos relevantes (se imprimen para el informe).
    if (process.env.THEME_MINS_OUT) writeFileSync(process.env.THEME_MINS_OUT, JSON.stringify(Object.fromEntries(Object.entries(mins).map(([k, v]) => [k, +v.toFixed(2)]).filter(([k]) => /primary-foreground|primary \/|muted-foreground|ring|input|chart-1|destructive|status-paused|status-running/.test(k as string)))))
  })
})

describe('oráculo independiente (culori)', () => {
  it('conversión OKLCH -> sRGB y contraste coinciden con culori', () => {
    let maxDiff = 0
    for (let ha = 0; ha < 360; ha += 20) {
      for (const mode of ['light', 'dark'] as const) {
        const colors = computeColors({ accentHue: ha, tintHue: (ha + 90) % 360, tintChroma: 1 }, mode)
        const p = colors['--primary'].color
        const bgc = colors['--background'].color
        const hexMine = toHex(p)
        // culori: mismo color OKLCH ya recortado por mí, convertido por culori
        const cul = formatHex(clampChroma({ mode: 'oklch', l: p.l, c: p.c, h: p.h }, 'oklch'))
        const diff = Math.abs(parseInt(hexMine.slice(1, 3), 16) - parseInt(cul!.slice(1, 3), 16))
        maxDiff = Math.max(maxDiff, diff)
        const a = toRgb({ mode: 'oklch', l: p.l, c: p.c, h: p.h })!
        const b = toRgb({ mode: 'oklch', l: bgc.l, c: bgc.c, h: bgc.h })!
        const ref = wcagContrast(
          { mode: 'rgb', r: Math.min(1, Math.max(0, a.r)), g: Math.min(1, Math.max(0, a.g)), b: Math.min(1, Math.max(0, a.b)) },
          { mode: 'rgb', r: Math.min(1, Math.max(0, b.r)), g: Math.min(1, Math.max(0, b.g)), b: Math.min(1, Math.max(0, b.b)) },
        )
        expect(Math.abs(contrast(p, bgc) - ref)).toBeLessThan(0.05)
      }
    }
    expect(maxDiff).toBeLessThanOrEqual(2)
  })
  it('el recorte de croma cae dentro del gamut', () => {
    const c = clipChroma({ l: 0.5, c: 0.13, h: 160 })
    expect(c.c).toBeLessThan(0.13)
    expect(Math.max(...oklchToLinear(c))).toBeLessThanOrEqual(1 + 1e-5)
  })
})

describe('paridad con los tokens estáticos de la plantilla (tema por defecto)', () => {
  const css = readFileSync(path.resolve(import.meta.dirname, '../index.css'), 'utf8')
  const blockOf = (sel: string) => css.slice(css.indexOf(`\n${sel} {`)).split('\n}')[0]
  const parseBlock = (b: string) => Object.fromEntries([...b.matchAll(/(--[\w-]+):\s*(oklch\([^;]+\));/g)].map((m) => [m[1], parseOklch(m[2])!]))
  it.each([['light', ':root'], ['dark', '.dark']] as const)('%s: ΔE-OKLab ≤ 0.02 en todos los tokens que calcula el motor', (mode, sel) => {
    const stat = parseBlock(blockOf(sel))
    const mine = computeColors(resolveInput(DEFAULT_PREFS), mode)
    const worst: [string, number][] = []
    for (const [name, { color }] of Object.entries(mine)) {
      const s = stat[name]
      if (!s) continue
      worst.push([name, deltaEOK(color, s)])
    }
    expect(worst.length).toBeGreaterThan(25)
    const bad = worst.filter(([, d]) => d > 0.02)
    expect(bad).toEqual([])
  })
})

describe('salida', () => {
  it('con ajustes por defecto no se inyecta nada', () => {
    expect(buildThemeCss(DEFAULT_PREFS)).toBe('')
    expect(buildThemeCss({ ...DEFAULT_PREFS, mode: 'light' })).toBe('')
    expect(isDefaultLook(DEFAULT_PREFS)).toBe(true)
  })
  it('las combinaciones (salvo Bosque) generan hoja con html:root y html.dark; Bosque = defecto', () => {
    expect(buildThemeCss({ v: 1, mode: 'dark', ...COMBOS[0] })).toBe('')
    for (const c of COMBOS.slice(1)) {
      const css = buildThemeCss({ v: 1, mode: 'dark', accent: c.accent, tint: c.tint, strength: c.strength })
      expect(css).toContain('html:root{--background:oklch(')
      expect(css).toContain('html.dark{--background:oklch(')
      expect(css).not.toContain('--status-')
      expect(css).not.toContain('--brand-tile')
    }
  })
  it('fallback hex: #rrggbb y alfa en bordes oscuros', () => {
    const t = computeTokens(resolveInput(DEFAULT_PREFS), 'dark', { fallbackHex: true })
    expect(t['--primary']).toMatch(/^#[0-9a-f]{6}$/)
    expect(t['--border']).toMatch(/^#[0-9a-f]{8}$/)
  })
  it('idempotente y con la versión del algoritmo', () => {
    const r = resolveInput({ ...DEFAULT_PREFS, accent: { hue: 200 } })
    expect(computeTokens(r, 'light')).toEqual(computeTokens(r, 'light'))
    expect(THEME_ALGO).toBe(1)
  })
  it('valores concretos de las combinaciones aprobadas (aprox. hex del plan)', () => {
    const want: Record<string, [string, string]> = { oceano: ['#1666aa', '#60b0ff'], atardecer: ['#9b4805', '#f98942'], lavanda: ['#6f4fa1', '#bb91ff'], miel: ['#865900', '#e39a00'], grafito: ['#007272', '#00c3c3'] }
    for (const [id, [l, d]] of Object.entries(want)) {
      const c = COMBOS.find((x) => x.id === id)!
      const r = resolveInput({ v: 1, mode: 'dark', accent: c.accent, tint: c.tint, strength: c.strength })
      const dist = (a: string, b: string) => Math.max(...[1, 3, 5].map((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16))))
      expect(dist(toHex(computeColors(r, 'light')['--primary'].color), l), `${id} claro`).toBeLessThan(40)
      expect(dist(toHex(computeColors(r, 'dark')['--primary'].color), d), `${id} oscuro`).toBeLessThan(40)
    }
  })
  it('choques de matiz con estados', () => {
    expect(stateClash(128)).toBe('En ejecución')
    expect(stateClash(25)).toContain('Muerto')
    expect(stateClash(75)).toBe('Pausado')
    expect(stateClash(160)).toBeNull()
    expect(stateClash(250)).toBeNull()
  })
})
