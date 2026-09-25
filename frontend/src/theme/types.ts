// Tipos del motor de temas (PLAN_frontend §4.2).
export type ThemeMode = 'light' | 'dark' | 'system'
export type AccentId = 'emerald' | 'teal' | 'blue' | 'indigo' | 'violet' | 'pink' | 'red' | 'amber' | 'orange'
export type TintId = 'green' | 'blue' | 'warm' | 'violet' | 'pink'
export type AccentSel = { preset: AccentId } | { hue: number }
export type TintSel = 'follow' | 'neutral' | { preset: TintId } | { hue: number }
export type TintStrength = 'soft' | 'normal' | 'strong'

export interface ThemePrefs {
  v: 1
  mode: ThemeMode
  accent: AccentSel
  tint: TintSel
  strength: TintStrength
}

/** Entrada ya resuelta del cálculo: matiz de acento, matiz de superficies y multiplicador de croma de superficie. */
export interface ResolvedInput {
  accentHue: number
  tintHue: number
  /** Multiplicador del croma de superficie (0 = neutro; suave .6 · normal 1 · intensa 1.8). */
  tintChroma: number
}

export type TokenMap = Record<string, string>

export interface ContrastCheck {
  pair: string
  ratio: number
  min: number
  pass: boolean
}
