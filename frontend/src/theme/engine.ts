// MOTOR DE TEMAS (TS puro, sin React). Contrato:
//   resolveInput(prefs) -> ResolvedInput
//   computeColors(input, mode) -> Record<token, {color: Oklch, alpha?}>     (colores recortados al gamut sRGB; los usa auditTheme)
//   computeTokens(input, mode, {fallbackHex?}) -> TokenMap                   ('--primary' -> 'oklch(…)' | '#rrggbb[aa]')
//   buildThemeCss(prefs, {fallbackHex?}) -> string                           ('' si los ajustes de color son los de fábrica)
//   auditTheme(input, mode) -> ContrastCheck[]                               (pares con mínimo WCAG y resultado)
//   THEME_ALGO                                                               versión del algoritmo (script pre-pintado la comprueba)
// Curvas de luminosidad ancladas a los tokens de la plantilla + SOLVER de luminosidad (`fit`): parte de L0 y se mueve en pasos de
// 0.005 hacia más contraste (claro: oscurece; oscuro: aclara) hasta cumplir todos los mínimos (con margen +0.1 sobre el requisito).
// Nunca cambia: --status-*, --console-* (salvo console-bg), --overlay, --sh-*, --brand-tile, tipografía, radios.
import { clipChroma, contrast, toHex, wrapHue, type Oklch } from './oklch'
import { DEFAULT_PREFS, STATUS_COLORS, STRENGTH_MULT, accentHue, tintHueOf } from './presets'
import type { ContrastCheck, ResolvedInput, ThemePrefs, TokenMap } from './types'

export const THEME_ALGO = 1
type Mode = 'light' | 'dark'
export interface Colored { color: Oklch; alpha?: number }

const M = 0.1 // margen sobre el requisito
const MIN_TEXT = 4.5 + M
const MIN_UI = 3 + M // ring/input/chart

export function resolveInput(p: ThemePrefs): ResolvedInput {
  const ah = wrapHue(accentHue(p.accent))
  const th = wrapHue(tintHueOf(p.tint, ah))
  return { accentHue: ah, tintHue: th, tintChroma: p.tint === 'neutral' ? 0 : STRENGTH_MULT[p.strength] }
}

const col = (l: number, c: number, h: number): Oklch => clipChroma({ l, c, h })

interface Check { against: Oklch[]; min: number }
/** Mueve L desde L0 en `dir` (−1 oscurece, +1 aclara) hasta cumplir todas las restricciones. */
function fit(h: number, c: number, l0: number, dir: 1 | -1, checks: Check[]): Oklch {
  let l = l0
  let cur = col(l, c, h)
  for (let i = 0; i < 200; i++) {
    cur = col(l, c, h)
    if (checks.every((k) => k.against.every((a) => contrast(cur, a) >= k.min))) return cur
    l += dir * 0.005
    if (l < 0.02 || l > 0.99) break
  }
  return cur
}

export function computeColors({ accentHue: ha, tintHue: ts, tintChroma: k }: ResolvedInput, mode: Mode): Record<string, Colored> {
  const d = mode === 'dark'
  const pick = <T,>(light: T, dark: T) => (d ? dark : light)
  const dir: 1 | -1 = d ? 1 : -1
  const out: Record<string, Colored> = {}

  // ---- superficies (matiz de tinte; croma × k) ----
  const bg = col(pick(0.985, 0.155), pick(0.005, 0.014) * k, ts)
  const card = col(pick(0.995, 0.19), pick(0.003, 0.015) * k, ts)
  const popover = col(pick(1, 0.21), pick(0, 0.016) * k, ts)
  const muted = col(pick(0.955, 0.245), pick(0.01, 0.016) * k, ts)
  const sidebar = col(pick(0.975, 0.2), pick(0.008, 0.016) * k, ts)
  const fg = col(pick(0.21, 0.955), pick(0.02, 0.008) * k, ts)
  // ---- superficies de acento (matiz de acento; croma fijo) ----
  const accent = col(pick(0.94, 0.29), pick(0.03, 0.035), ha)
  const sidebarAccent = col(pick(0.93, 0.29), pick(0.03, 0.035), ha)
  const surfaces = [bg, card, popover, muted, sidebar, accent, sidebarAccent]
  const base4 = [bg, card, popover, sidebar]

  const primaryFg = col(pick(0.985, 0.17), pick(0.01, 0.03), ha)
  const primary = fit(ha, pick(0.13, 0.16), pick(0.5, 0.74), dir, [{ against: [primaryFg, ...surfaces], min: MIN_TEXT }])
  const mutedFg = fit(ts, 0.02 * k, pick(0.47, 0.72), dir, [{ against: surfaces, min: MIN_TEXT }])
  const accentFg = fit(ha, pick(0.06, 0.03), pick(0.3, 0.95), (d ? 1 : -1) as 1 | -1, [{ against: [accent], min: 7 }])
  const sidebarAccentFg = fit(ha, pick(0.06, 0.03), pick(0.28, 0.95), dir, [{ against: [sidebarAccent], min: 7 }])
  const ring = fit(ha, pick(0.14, 0.16), pick(0.58, 0.74), dir, [{ against: base4, min: MIN_UI }])
  const input = fit(ts, 0.02 * k, pick(0.62, 0.52), dir, [{ against: base4, min: MIN_UI + 0.1 }])
  const destructiveFg = col(pick(0.985, 0.15), pick(0.01, 0.03), 25)
  const destructive = fit(27, pick(0.2, 0.19), pick(0.52, 0.7), dir, [{ against: [destructiveFg, ...surfaces], min: MIN_TEXT }])
  const secondaryFg = d ? fg : col(0.25, 0.03, ts)

  const charts: Oklch[] = [
    fit(ha, pick(0.13, 0.16), pick(0.55, 0.74), dir, [{ against: [card, bg, popover, sidebar, muted], min: MIN_UI }]),
    ...[
      [75, pick(0.55, 0.72), pick(0.12, 0.12)],
      [-75, pick(0.6, 0.8), pick(0.13, 0.14)],
      [130, pick(0.52, 0.72), pick(0.15, 0.13)],
      [-135, pick(0.58, 0.7), pick(0.17, 0.17)],
    ].map(([off, l, c]) => fit(wrapHue(ha + off), c, l, dir, [{ against: [card, bg, popover, sidebar, muted], min: MIN_UI }])),
  ]

  const set = (name: string, color: Oklch, alpha?: number) => (out[name] = { color, alpha })
  set('--background', bg)
  set('--foreground', fg)
  set('--card', card)
  set('--card-foreground', fg)
  set('--popover', popover)
  set('--popover-foreground', fg)
  set('--primary', primary)
  set('--primary-foreground', primaryFg)
  set('--secondary', muted)
  set('--secondary-foreground', secondaryFg)
  set('--muted', muted)
  set('--muted-foreground', mutedFg)
  set('--accent', accent)
  set('--accent-foreground', accentFg)
  set('--destructive', destructive)
  set('--destructive-foreground', destructiveFg)
  set('--border', col(pick(0.89, 0.96), pick(0.012, 0.03) * k, ts), pick(undefined, 0.1))
  set('--input', input)
  set('--ring', ring)
  charts.forEach((c, i) => set(`--chart-${i + 1}`, c))
  set('--sidebar', sidebar)
  set('--sidebar-foreground', d ? fg : col(0.25, 0.02 * k, ts))
  set('--sidebar-primary', primary)
  set('--sidebar-primary-foreground', primaryFg)
  set('--sidebar-accent', sidebarAccent)
  set('--sidebar-accent-foreground', sidebarAccentFg)
  set('--sidebar-border', col(pick(0.88, 0.96), pick(0.014, 0.03) * k, ts), pick(undefined, 0.12))
  set('--sidebar-ring', ring)
  set('--console-bg', col(pick(0.17, 0.13), pick(0.014, 0.012) * k, ts))
  return out
}

const num = (v: number, digits = 4) => String(+v.toFixed(digits))

export function computeTokens(input: ResolvedInput, mode: Mode, o: { fallbackHex?: boolean } = {}): TokenMap {
  const map: TokenMap = {}
  for (const [name, { color, alpha }] of Object.entries(computeColors(input, mode))) {
    if (o.fallbackHex) map[name] = toHex(color, alpha)
    else map[name] = `oklch(${num(color.l)} ${num(color.c)} ${num(color.h, 2)}${alpha !== undefined ? ` / ${Math.round(alpha * 100)}%` : ''})`
  }
  return map
}

/** ¿Los ajustes de color son los de fábrica? (el modo no cuenta: no cambia la paleta.) */
export function isDefaultLook(p: ThemePrefs): boolean {
  const a = resolveInput(p)
  const b = resolveInput(DEFAULT_PREFS)
  return a.accentHue === b.accentHue && a.tintHue === b.tintHue && a.tintChroma === b.tintChroma
}

const block = (sel: string, t: TokenMap) => `${sel}{${Object.entries(t).map(([k, v]) => `${k}:${v}`).join(';')}}`

/** Hoja completa (claro + oscuro). '' si son los ajustes por defecto: quedan los tokens estáticos de la plantilla. */
export function buildThemeCss(p: ThemePrefs, o: { fallbackHex?: boolean } = {}): string {
  if (isDefaultLook(p)) return ''
  const r = resolveInput(p)
  return `${block('html:root', computeTokens(r, 'light', o))}\n${block('html.dark', computeTokens(r, 'dark', o))}`
}

function statusChecks(mode: Mode, colors: Record<string, Colored>): ContrastCheck[] {
  const res: ContrastCheck[] = []
  const surf = ['--background', '--card', '--popover', '--sidebar', '--muted', '--accent']
  for (const [name, s] of Object.entries(STATUS_COLORS)) {
    const fgc = clipChroma({ l: (mode === 'dark' ? s.dark : s.light)[0], c: (mode === 'dark' ? s.dark : s.light)[1], h: (mode === 'dark' ? s.dark : s.light)[2] })
    const bgc = mode === 'dark' ? s.bgDark : s.bgLight
    const bgCol = clipChroma({ l: bgc[0], c: bgc[1], h: bgc[2] })
    const r = contrast(fgc, bgCol)
    res.push({ pair: `status-${name} / su fondo`, ratio: r, min: 4.5, pass: r >= 4.5 })
    for (const sn of surf) {
      const rr = contrast(fgc, colors[sn].color)
      res.push({ pair: `status-${name} / ${sn.slice(2)}`, ratio: rr, min: 4.5, pass: rr >= 4.5 })
    }
  }
  return res
}

export function auditTheme(input: ResolvedInput, mode: Mode): ContrastCheck[] {
  const c = computeColors(input, mode)
  const at = (n: string) => c[n].color
  const out: ContrastCheck[] = []
  const add = (a: string, b: string, min: number) => {
    const ratio = contrast(at(a), at(b))
    out.push({ pair: `${a.slice(2)} / ${b.slice(2)}`, ratio, min, pass: ratio >= min })
  }
  const surfaces = ['--background', '--card', '--popover', '--muted', '--secondary', '--sidebar', '--accent', '--sidebar-accent']
  const base4 = ['--background', '--card', '--popover', '--sidebar']
  add('--primary-foreground', '--primary', 4.5)
  for (const s of surfaces) add('--primary', s, 4.5)
  for (const s of surfaces) add('--muted-foreground', s, 4.5)
  for (const s of ['--background', '--card', '--popover', '--sidebar']) add('--foreground', s, 7)
  add('--accent-foreground', '--accent', 4.5)
  add('--sidebar-accent-foreground', '--sidebar-accent', 4.5)
  add('--secondary-foreground', '--secondary', 4.5)
  add('--destructive-foreground', '--destructive', 4.5)
  for (const s of surfaces) add('--destructive', s, 4.5)
  for (const s of base4) add('--ring', s, 3)
  for (const s of base4) add('--input', s, 3)
  for (let i = 1; i <= 5; i++) for (const s of ['--card', '--background', '--popover', '--sidebar', '--muted']) add(`--chart-${i}`, s, 3)
  return [...out, ...statusChecks(mode, c)]
}
