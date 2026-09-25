// Persistencia de preferencias de tema. Contrato:
//   loadPrefs(storage?) -> ThemePrefs        localStorage `dockinng.theme.v1` (JSON versionado); inválido/corrupto -> defaults
//   savePrefs(p, storage?)                   guarda prefs + hoja precompilada `dockinng.theme.css.v1` = {algo, css, hex} para el script pre-pintado
//   validatePrefs(unknown) -> ThemePrefs | null
//   Migración: `dockinng.theme` heredado ('light'|'dark') -> mode. TODO acceso a storage va en try/catch.
import { safeStorage } from '@/lib/safeStorage'
import { THEME_ALGO, buildThemeCss, isDefaultLook } from './engine'
import { ACCENTS, DEFAULT_PREFS, TINTS } from './presets'
import type { AccentSel, ThemeMode, ThemePrefs, TintSel, TintStrength } from './types'

export const PREFS_KEY = 'dockinng.theme.v1'
export const CSS_KEY = 'dockinng.theme.css.v1'
export const LEGACY_KEY = 'dockinng.theme'

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const defaultStore = (): Store | null => safeStorage()

const hueOk = (h: unknown): h is number => typeof h === 'number' && Number.isFinite(h) && h >= 0 && h <= 360
const MODES: ThemeMode[] = ['light', 'dark', 'system']
const STRENGTHS: TintStrength[] = ['soft', 'normal', 'strong']

function validAccent(a: unknown): a is AccentSel {
  if (!a || typeof a !== 'object') return false
  const o = a as Record<string, unknown>
  return 'preset' in o ? ACCENTS.some((x) => x.id === o.preset) : hueOk(o.hue)
}
function validTint(t: unknown): t is TintSel {
  if (t === 'follow' || t === 'neutral') return true
  if (!t || typeof t !== 'object') return false
  const o = t as Record<string, unknown>
  return 'preset' in o ? TINTS.some((x) => x.id === o.preset) : hueOk(o.hue)
}

export function validatePrefs(x: unknown): ThemePrefs | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  if (o.v !== 1 || !MODES.includes(o.mode as ThemeMode) || !validAccent(o.accent) || !validTint(o.tint) || !STRENGTHS.includes(o.strength as TintStrength)) return null
  return { v: 1, mode: o.mode as ThemeMode, accent: o.accent, tint: o.tint, strength: o.strength as TintStrength }
}

export function loadPrefs(store: Store | null = defaultStore()): ThemePrefs {
  if (!store) return DEFAULT_PREFS
  try {
    const raw = store.getItem(PREFS_KEY)
    if (raw) {
      const p = validatePrefs(JSON.parse(raw))
      if (p) return p
    }
  } catch { /* JSON corrupto o storage bloqueado -> defaults */ }
  try {
    const legacy = store.getItem(LEGACY_KEY)
    if (legacy === 'light' || legacy === 'dark') return { ...DEFAULT_PREFS, mode: legacy }
  } catch { /* nada */ }
  return DEFAULT_PREFS
}

/** Firma de la parte de color de las prefs: liga la hoja precompilada a los ajustes que la generaron. */
export const themeSig = (p: Pick<ThemePrefs, 'accent' | 'tint' | 'strength'>): string => JSON.stringify([p.accent, p.tint, p.strength])

/** Regenera la hoja precompilada si falta, es de otra versión de algoritmo o no corresponde a las prefs (arranque). */
export function ensureCssCache(p: ThemePrefs, store: Store | null = defaultStore()): void {
  if (!store) return
  try {
    const raw = store.getItem(CSS_KEY)
    const c = raw ? JSON.parse(raw) : null
    const want = !isDefaultLook(p)
    if (want && !(c && c.algo === THEME_ALGO && c.sig === themeSig(p))) savePrefs(p, store)
    else if (!want && raw) store.removeItem(CSS_KEY)
  } catch { savePrefs(p, store) }
}

export function savePrefs(p: ThemePrefs, store: Store | null = defaultStore()): void {
  if (!store) return
  try {
    store.setItem(PREFS_KEY, JSON.stringify(p))
    const css = buildThemeCss(p)
    if (css) store.setItem(CSS_KEY, JSON.stringify({ algo: THEME_ALGO, sig: themeSig(p), css, hex: buildThemeCss(p, { fallbackHex: true }) }))
    else store.removeItem(CSS_KEY)
  } catch { /* cuota o storage bloqueado: la preferencia vive solo en memoria */ }
}
