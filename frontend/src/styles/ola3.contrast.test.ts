// Contraste de lo NUEVO de la Ola 3, medido (no a ojo) con `theme/oklch.ts` y `computeColors` en los 8 COMBOS × claro/oscuro (16 temas).
// Texto: WCAG AA 4,5:1. Elementos que no son texto (contornos, iconos, foco): 3:1 (WCAG 1.4.11).
// Los colores mezclados con `color-mix(in oklch, …)` del CSS se aproximan mezclando en OKLab (a 10–14 % de mezcla la diferencia es despreciable).
// Los tokens L/C de `--grp` (0.55/0.13 claro, 0.74/0.12 oscuro) están en styles/app.css: si esos valores cambian, cambian aquí.
import { describe, expect, it } from 'vitest'
import { STATUS_COLORS, COMBOS } from '@/theme/presets'
import { computeColors, resolveInput } from '@/theme/engine'
import { clipChroma, contrast, type Oklch } from '@/theme/oklch'

type Mode = 'light' | 'dark'
const GRP_LC: Record<Mode, [number, number]> = { light: [0.55, 0.13], dark: [0.74, 0.12] }
const AA_TEXT = 4.5
const AA_UI = 3

const lab = (o: Oklch) => [o.l, o.c * Math.cos((o.h * Math.PI) / 180), o.c * Math.sin((o.h * Math.PI) / 180)]
/** color-mix(in oklch, a p%, b) aproximado en OKLab. */
function mix(a: Oklch, p: number, b: Oklch): Oklch {
  const [x, y] = [lab(a), lab(b)]
  const m = [0, 1, 2].map((i) => x[i] * p + y[i] * (1 - p))
  return clipChroma({ l: m[0], c: Math.hypot(m[1], m[2]), h: ((Math.atan2(m[2], m[1]) * 180) / Math.PI + 360) % 360 })
}
const grp = (mode: Mode, hue: number): Oklch => clipChroma({ l: GRP_LC[mode][0], c: GRP_LC[mode][1], h: hue })

const themes = COMBOS.flatMap((c) => (['light', 'dark'] as const).map((mode) => ({ name: `${c.label} · ${mode === 'light' ? 'claro' : 'oscuro'}`, mode, t: computeColors(resolveInput({ v: 1, mode, accent: c.accent, tint: c.tint, strength: c.strength }), mode) })))
const HUES = Array.from({ length: 24 }, (_, i) => i * 15)

describe('contraste de la Ola 3 (8 combos × claro/oscuro)', () => {
  it('hay 16 temas', () => expect(themes).toHaveLength(16))

  it.each(themes)('$name: resalte de destino --grp (contorno 2px) ≥ 3:1 sobre cabecera de grupo y chip, en toda la rueda de matices', ({ mode, t }) => {
    const card = t['--card'].color
    const worst: { hue: number; ratio: number }[] = []
    for (const h of HUES) {
      const g = grp(mode, h)
      const onGroupRow = mix(g, 0.1, card) // tr.group-row td: color-mix(grp 10%, card)
      const onChipOver = mix(g, 0.14, card) // .drag-chip[data-drop=over]: color-mix(grp 14%, card)
      worst.push({ hue: h, ratio: Math.min(contrast(g, onGroupRow), contrast(g, onChipOver), contrast(g, card)) })
    }
    const min = worst.reduce((a, b) => (b.ratio < a.ratio ? b : a))
    expect(min.ratio, `matiz ${min.hue}`).toBeGreaterThanOrEqual(AA_UI)
  })

  it.each(themes)('$name: foco del asa (--ring) y línea del separador ≥ 3:1 sobre card y sobre la cabecera de tabla', ({ t }) => {
    const ring = t['--ring'].color
    const th = mix(t['--muted'].color, 0.55, t['--card'].color) // th: color-mix(muted 55%, card)
    expect(contrast(ring, t['--card'].color)).toBeGreaterThanOrEqual(AA_UI)
    expect(contrast(ring, th)).toBeGreaterThanOrEqual(AA_UI)
  })

  it.each(themes)('$name: icono de asa (--muted-foreground) ≥ 3:1 y textos de bandeja/«motivo» ≥ 4,5:1', ({ t }) => {
    const mf = t['--muted-foreground'].color
    const card = t['--card'].color
    const popover = t['--popover'].color
    expect(contrast(mf, card)).toBeGreaterThanOrEqual(AA_UI) // icono grip
    expect(contrast(mf, card)).toBeGreaterThanOrEqual(AA_TEXT) // «Contenedor detenido», «Solo en este equipo» (.why)
    expect(contrast(mf, popover)).toBeGreaterThanOrEqual(AA_TEXT) // «Soltar en» (.drag-tray-label)
    expect(contrast(t['--popover-foreground'].color, card)).toBeGreaterThanOrEqual(AA_TEXT) // texto de los chips (sobre --card dentro de la bandeja)
  })

  it.each(themes)('$name: texto del chip activo (foreground sobre grp 14 %) ≥ 4,5:1 en toda la rueda de matices', ({ mode, t }) => {
    const fg = t['--popover-foreground'].color
    const card = t['--card'].color
    for (const h of HUES) expect(contrast(fg, mix(grp(mode, h), 0.14, card)), `matiz ${h}`).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it.each(themes)('$name: borde punteado «no válido» (--destructive) ≥ 3:1 sobre la cabecera de stack y card', ({ mode, t }) => {
    const d = t['--destructive'].color
    for (const h of HUES) expect(contrast(d, mix(grp(mode, h), 0.1, t['--card'].color)), `matiz ${h}`).toBeGreaterThanOrEqual(AA_UI)
    expect(contrast(d, t['--card'].color)).toBeGreaterThanOrEqual(AA_UI)
  })

  it.each(themes)('$name: fantasma del arrastre y chrome de ventana (texto ≥ 4,5:1; cerrar al pasar el ratón)', ({ t }) => {
    expect(contrast(t['--primary-foreground'].color, t['--primary'].color)).toBeGreaterThanOrEqual(AA_TEXT) // .drag-ghost
    const bar = mix(t['--muted'].color, 0.55, t['--background'].color) // .window-chrome
    expect(contrast(t['--foreground'].color, bar)).toBeGreaterThanOrEqual(AA_TEXT)
    expect(contrast(t['--ring'].color, bar)).toBeGreaterThanOrEqual(AA_UI) // foco de los botones
    expect(contrast(t['--destructive-foreground'].color, t['--destructive'].color)).toBeGreaterThanOrEqual(AA_TEXT) // .wc-close:hover
  })
})

describe('colores de estado (no dependen del tema)', () => {
  for (const [name, c] of Object.entries(STATUS_COLORS)) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${name} · ${mode}: texto del estado sobre su fondo ≥ 4,5:1`, () => {
        const [fg, bg] = mode === 'light' ? [c.light, c.bgLight] : [c.dark, c.bgDark]
        expect(contrast({ l: fg[0], c: fg[1], h: fg[2] }, { l: bg[0], c: bg[1], h: bg[2] })).toBeGreaterThanOrEqual(AA_TEXT)
      })
    }
  }
})
