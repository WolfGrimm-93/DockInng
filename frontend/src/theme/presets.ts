// Presets de acento, tinte y combinaciones con nombre (PLAN_frontend §4.4; nombres/valores pendientes de aprobación D5).
import type { AccentId, AccentSel, ThemePrefs, TintId, TintSel, TintStrength } from './types'

export const ACCENTS: { id: AccentId; label: string; hue: number }[] = [
  { id: 'emerald', label: 'Esmeralda', hue: 160 },
  { id: 'teal', label: 'Teal', hue: 195 },
  { id: 'blue', label: 'Azul', hue: 250 },
  { id: 'indigo', label: 'Índigo', hue: 275 },
  { id: 'violet', label: 'Violeta', hue: 300 },
  { id: 'pink', label: 'Rosa', hue: 350 },
  { id: 'red', label: 'Rojo', hue: 25 },
  { id: 'amber', label: 'Ámbar', hue: 75 },
  { id: 'orange', label: 'Naranja', hue: 50 },
]

export const TINTS: { id: TintId; label: string; hue: number }[] = [
  { id: 'green', label: 'Verde', hue: 165 },
  { id: 'blue', label: 'Azul', hue: 245 },
  { id: 'warm', label: 'Cálido', hue: 65 },
  { id: 'violet', label: 'Violeta', hue: 300 },
  { id: 'pink', label: 'Rosa', hue: 350 },
]

export const STRENGTH_MULT: Record<TintStrength, number> = { soft: 0.6, normal: 1, strong: 1.8 }
export const STRENGTH_LABEL: Record<TintStrength, string> = { soft: 'Suave', normal: 'Normal', strong: 'Intensa' }

export const accentHue = (a: AccentSel): number => ('preset' in a ? (ACCENTS.find((x) => x.id === a.preset)?.hue ?? 160) : a.hue)
export const tintHueOf = (t: TintSel, accent: number): number =>
  t === 'follow' || t === 'neutral' ? accent : 'preset' in t ? (TINTS.find((x) => x.id === t.preset)?.hue ?? 165) : t.hue

export interface Combo { id: string; label: string; accent: AccentSel; tint: TintSel; strength: TintStrength }
/** Las 8 combinaciones aprobadas. `Bosque` = valores de la plantilla (por defecto). */
export const COMBOS: Combo[] = [
  { id: 'bosque', label: 'Bosque', accent: { preset: 'emerald' }, tint: { preset: 'green' }, strength: 'normal' },
  { id: 'oceano', label: 'Océano', accent: { preset: 'blue' }, tint: { preset: 'blue' }, strength: 'normal' },
  { id: 'medianoche', label: 'Medianoche', accent: { preset: 'indigo' }, tint: { hue: 265 }, strength: 'strong' },
  { id: 'atardecer', label: 'Atardecer', accent: { preset: 'orange' }, tint: { hue: 60 }, strength: 'normal' },
  { id: 'lavanda', label: 'Lavanda', accent: { preset: 'violet' }, tint: { preset: 'violet' }, strength: 'normal' },
  { id: 'sakura', label: 'Sakura', accent: { preset: 'pink' }, tint: { preset: 'pink' }, strength: 'soft' },
  { id: 'grafito', label: 'Grafito', accent: { preset: 'teal' }, tint: 'neutral', strength: 'normal' },
  { id: 'miel', label: 'Miel', accent: { preset: 'amber' }, tint: { hue: 70 }, strength: 'normal' },
]

export const DEFAULT_PREFS: ThemePrefs = { v: 1, mode: 'dark', accent: { preset: 'emerald' }, tint: { preset: 'green' }, strength: 'normal' }

/** Colores semánticos de estado (NO cambian con el acento): [L, C, H] claro / oscuro y su fondo. Copia de tokens.css. */
export const STATUS_COLORS: Record<string, { light: [number, number, number]; dark: [number, number, number]; bgLight: [number, number, number]; bgDark: [number, number, number] }> = {
  running: { light: [0.42, 0.14, 128], dark: [0.84, 0.19, 130], bgLight: [0.94, 0.06, 128], bgDark: [0.27, 0.07, 130] },
  paused: { light: [0.48, 0.11, 75], dark: [0.82, 0.15, 85], bgLight: [0.95, 0.06, 90], bgDark: [0.28, 0.06, 85] },
  restarting: { light: [0.46, 0.13, 245], dark: [0.78, 0.12, 235], bgLight: [0.94, 0.03, 235], bgDark: [0.27, 0.05, 235] },
  exited: { light: [0.45, 0.02, 165], dark: [0.72, 0.02, 165], bgLight: [0.94, 0.008, 165], bgDark: [0.27, 0.012, 165] },
  dead: { light: [0.48, 0.19, 25], dark: [0.72, 0.19, 25], bgLight: [0.95, 0.03, 25], bgDark: [0.27, 0.07, 25] },
  created: { light: [0.46, 0.14, 290], dark: [0.78, 0.11, 290], bgLight: [0.95, 0.03, 290], bgDark: [0.27, 0.05, 290] },
}

/**
 * Avisos NO bloqueantes: acentos cuyo matiz se parece al de un estado (los estados siempre llevan icono y texto).
 * Rangos de matiz aproximados (±): running 128 (lima), dead/destructive 25, paused 75-90.
 */
export function stateClash(hue: number): string | null {
  const d = (a: number) => Math.abs(((hue - a + 540) % 360) - 180)
  if (d(128) <= 22) return 'En ejecución'
  if (d(25) <= 20) return 'Muerto y Eliminar'
  if (d(80) <= 18) return 'Pausado'
  return null
}
