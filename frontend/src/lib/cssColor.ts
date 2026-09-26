// Colores CSS -> RGB para pintar en canvas/xterm (que no entienden var() ni oklch()). Contrato:
//   parseCssColor(s) -> [r,g,b] 0..255 | null      (#rgb/#rrggbb, rgb()/rgba(), oklch(), color(srgb …))
//   toHexRgb(rgb) · mixRgb(a, b, t) · lightenRgb(rgb, amount)
//   resolveCssVarColor(name, fallbackHex, root?) -> '#rrggbb'  (resuelve var(--x) con getComputedStyle; cae al fallback si no se puede)
import { parseOklch, toSrgb } from '@/theme/oklch'

export type Rgb255 = [number, number, number]
const clamp = (v: number): number => Math.min(255, Math.max(0, Math.round(v)))

export function parseCssColor(input: string): Rgb255 | null {
  const s = input.trim().toLowerCase()
  let m = /^#([0-9a-f]{3,8})$/.exec(s)
  if (m) {
    const h = m[1]
    if (h.length === 3 || h.length === 4) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
    if (h.length === 6 || h.length === 8) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
    return null
  }
  m = /^rgba?\(\s*([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*,\s*|\s+)([\d.]+)/.exec(s)
  if (m) return [clamp(Number(m[1])), clamp(Number(m[2])), clamp(Number(m[3]))]
  const ok = parseOklch(s)
  if (ok) {
    const [r, g, b] = toSrgb(ok)
    return [clamp(r * 255), clamp(g * 255), clamp(b * 255)]
  }
  m = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s)
  if (m) return [clamp(Number(m[1]) * 255), clamp(Number(m[2]) * 255), clamp(Number(m[3]) * 255)]
  return null
}

export const toHexRgb = ([r, g, b]: Rgb255): string => `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`

export function mixRgb(a: Rgb255, b: Rgb255, t: number): Rgb255 {
  return [clamp(a[0] + (b[0] - a[0]) * t), clamp(a[1] + (b[1] - a[1]) * t), clamp(a[2] + (b[2] - a[2]) * t)]
}
export const lightenRgb = (c: Rgb255, amount: number): Rgb255 => mixRgb(c, [255, 255, 255], amount)

/** Resuelve `var(--name)` a RGB con un elemento sonda (funciona con oklch, hex de respaldo y cualquier combinación del motor de temas). */
export function resolveCssVarRgb(name: string, fallback: Rgb255, root: HTMLElement = document.documentElement): Rgb255 {
  try {
    const probe = document.createElement('span')
    probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;color:var(${name})`
    root.appendChild(probe)
    const computed = getComputedStyle(probe).color
    probe.remove()
    const direct = parseCssColor(computed)
    if (direct) return direct
    // Formato desconocido (p. ej. lab()/color-mix sin resolver): se pasa por un canvas 1×1, que sí devuelve sRGB.
    const ctx = computed ? document.createElement('canvas').getContext('2d', { willReadFrequently: true }) : null
    if (ctx) {
      ctx.fillStyle = '#000'
      ctx.fillStyle = computed
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0], d[1], d[2]]
    }
  } catch { /* jsdom u otro entorno sin canvas */ }
  return fallback
}
