// Matemática de color propia (sin dependencias): OKLCH <-> sRGB, recorte de croma al gamut sRGB, contraste WCAG y ΔE-OKLab.
// La validez de estas matrices/fórmulas se comprueba en engine.test.ts contra un ORÁCULO independiente (culori).
export interface Oklch { l: number; c: number; h: number }
export type Rgb = [number, number, number]

const rad = (d: number) => (d * Math.PI) / 180

/** OKLCH -> sRGB lineal (sin recortar: puede salirse de [0,1]). */
export function oklchToLinear({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos(rad(h))
  const b = c * Math.sin(rad(h))
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
}

const EPS = 1e-6
export const inGamut = (rgb: Rgb): boolean => rgb.every((v) => v >= -EPS && v <= 1 + EPS)

/** Reduce el croma (manteniendo L y matiz) hasta entrar en sRGB. */
export function clipChroma(o: Oklch): Oklch {
  const l = Math.min(1, Math.max(0, o.l))
  if (l <= 0 || l >= 1) return { l, c: 0, h: o.h }
  if (inGamut(oklchToLinear({ ...o, l }))) return { ...o, l }
  let lo = 0
  let hi = o.c
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (inGamut(oklchToLinear({ l, c: mid, h: o.h }))) lo = mid
    else hi = mid
  }
  return { l, c: lo, h: o.h }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)

/** sRGB codificado (0..1) del color ya recortado. */
export function toSrgb(o: Oklch): Rgb {
  const lin = oklchToLinear(clipChroma(o))
  return [gamma(clamp01(lin[0])), gamma(clamp01(lin[1])), gamma(clamp01(lin[2]))]
}

export function toHex(o: Oklch, alpha?: number): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  const [r, g, b] = toSrgb(o)
  return `#${h(r)}${h(g)}${h(b)}${alpha !== undefined && alpha < 1 ? h(alpha) : ''}`
}

/** Luminancia relativa WCAG del color recortado al gamut. */
export function luminance(o: Oklch): number {
  const [r, g, b] = oklchToLinear(clipChroma(o)).map(clamp01) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: Oklch, b: Oklch): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Distancia euclídea en OKLab (ΔE-OK; ≈0.02 es el umbral de diferencia perceptible). */
export function deltaEOK(a: Oklch, b: Oklch): number {
  const ab = (o: Oklch) => [o.l, o.c * Math.cos(rad(o.h)), o.c * Math.sin(rad(o.h))]
  const [x, y] = [ab(a), ab(b)]
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

/** Lee `oklch(L C H)` o `oklch(L C H / A%)`. */
export function parseOklch(s: string): (Oklch & { alpha: number }) | null {
  const m = s.trim().match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/)
  if (!m) return null
  const alpha = m[4] === undefined ? 1 : m[5] ? Number(m[4]) / 100 : Number(m[4])
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]), alpha }
}

export const wrapHue = (h: number): number => ((h % 360) + 360) % 360
