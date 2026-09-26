// Paleta ANSI de la terminal a partir de los tokens --console-*: mapa completo de 16 colores y contraste legible sobre el fondo.
import { describe, expect, it } from 'vitest'
import { parseCssColor, type Rgb255 } from '@/lib/cssColor'
import { terminalThemeFrom, readConsoleColors, readTerminalTheme } from './terminalTheme'

const lum = ([r, g, b]: Rgb255) => {
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (a: Rgb255, b: Rgb255) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)

// Tokens de src/index.css (claro/oscuro): los de texto son iguales; el fondo cambia de L=0.17 a L=0.13.
const TOKENS = { fg: 'oklch(0.9 0.01 165)', muted: 'oklch(0.72 0.02 165)', info: 'oklch(0.78 0.12 235)', warn: 'oklch(0.82 0.15 85)', error: 'oklch(0.76 0.17 25)', debug: 'oklch(0.72 0.11 290)', ok: 'oklch(0.78 0.17 145)' }

describe('terminalTheme', () => {
  it('en un entorno sin CSS resuelve con la paleta de respaldo y define los 16 colores + fondo, primer plano, cursor y selección', () => {
    const t = readTerminalTheme()
    for (const k of ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const) {
      expect(t[k], k).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it.each([['claro', 0.17], ['oscuro', 0.13]])('contraste ≥ 4.5 de los colores de texto sobre el fondo (%s)', (_n, l) => {
    const c = readConsoleColors()
    c.bg = parseCssColor(`oklch(${l} 0.014 165)`)!
    for (const [k, v] of Object.entries(TOKENS)) (c as Record<string, Rgb255>)[k] = parseCssColor(v)!
    const theme = terminalThemeFrom(c)
    const bg = parseCssColor(theme.background!)!
    for (const k of ['foreground', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const) {
      expect(contrast(parseCssColor(theme[k]!)!, bg), `${k} sobre ${_n}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('los brillantes son más claros que los normales', () => {
    const t = terminalThemeFrom(readConsoleColors())
    expect(lum(parseCssColor(t.brightRed!)!)).toBeGreaterThan(lum(parseCssColor(t.red!)!))
  })
})
