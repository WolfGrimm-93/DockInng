// Animaciones infinitas (optimización de repintado): solo el indicador del DETALLE se anima; filas y cabeceras de grupo son estáticas;
// se respeta prefers-reduced-motion y la ventana sin foco (html.window-blurred) pausa lo que quede animado. Se comprueba sobre el CSS real.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync(`${process.cwd()}/src/styles/app.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const rules = (src: string): { sel: string; body: string }[] => [...src.matchAll(/([^{}@][^{}]*)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }))
const all = rules(css)
const withAnimation = all.filter((r) => /animation\s*:[^;]*infinite/.test(r.body))

describe('animaciones infinitas', () => {
  it('ninguna regla infinita cuelga de filas/cabeceras de grupo: solo el detalle (.is-live), transitorios (.spin, skeleton, progreso) y el resto conocido', () => {
    const sels = withAnimation.map((r) => r.sel)
    expect(sels.some((s) => /\.live-dot/.test(s))).toBe(false) // punto de cabecera de grupo: estático
    expect(sels.some((s) => /^\.status-restarting \.i$/.test(s))).toBe(false) // «Reiniciando» en filas: estático
    expect(sels).toContain('.status-restarting.is-live .i') // solo en el detalle
    expect(sels.some((s) => /is-live \.dot-halo/.test(s))).toBe(true)
  })
  it('el punto de grupo conserva su forma y un anillo fijo (sin animation ni ::after animado)', () => {
    const dot = all.find((r) => r.sel === '.live-dot')!
    expect(dot.body).not.toMatch(/animation/)
    expect(dot.body).toMatch(/box-shadow/)
    expect(all.some((r) => /\.live-dot::after/.test(r.sel))).toBe(false)
  })
  it('prefers-reduced-motion apaga el giro y el halo', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.status-restarting \.i, \.spin \{ animation: none !important/)
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.status\.is-live \.dot-halo, \.status\.is-live \.dot-core \{ animation: none; \}/)
  })
  it('sin foco (html.window-blurred) se pausan las animaciones que quedan', () => {
    const r = all.find((x) => x.sel.includes('html.window-blurred .spin'))!
    expect(r.body).toMatch(/animation-play-state:\s*paused/)
    for (const piece of ['.status.is-live .dot-halo', '.status.is-live .dot-core', '.status-restarting.is-live .i', '.skeleton']) expect(r.sel).toContain(piece)
  })
})
