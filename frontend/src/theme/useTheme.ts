// ESTADO DEL TEMA (zustand) + hook público. Contrato:
//   useTheme(): { prefs, resolvedMode, setMode(ThemeMode), toggle(), setAccent(AccentSel), setTint(TintSel), setStrength(s),
//                 applyCombo(id), reset(), report: ContrastCheck[] (auditoría del modo actual), isDefault }
//   toggle(): alterna claro/oscuro EFECTIVO fijando modo explícito (el botón del sidebar); «Sistema» solo desde Apariencia.
//   Cada cambio: aplica al DOM + persiste (`dockinng.theme.v1` y la hoja precompilada para el script pre-pintado).
import { useMemo } from 'react'
import { create } from 'zustand'
import { applyTheme, resolveMode } from './apply'
import { auditTheme, isDefaultLook, resolveInput } from './engine'
import { ensureCssCache, loadPrefs, savePrefs } from './prefs'
import { COMBOS, DEFAULT_PREFS } from './presets'
import type { AccentSel, ContrastCheck, ThemeMode, ThemePrefs, TintSel, TintStrength } from './types'

export type ResolvedMode = 'light' | 'dark'
interface ThemeState {
  prefs: ThemePrefs
  resolvedMode: ResolvedMode
  /** Llamado al montar: sincroniza con lo que dejó el script pre-pintado. */
  init(): void
  setPrefs(p: ThemePrefs, o?: { persist?: boolean }): void
  /** Re-evalúa el modo `system` (cambio de prefers-color-scheme). */
  syncSystem(): void
}

const domMode = (): ResolvedMode => (typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light')

export const useThemeStore = create<ThemeState>((set, get) => ({
  prefs: loadPrefs(),
  resolvedMode: domMode(),
  init() {
    // El script inline ya fijó clase y hoja; aquí solo se alinea el estado y se garantiza la hoja (sin tocar el modo, que puede venir de ?theme=).
    ensureCssCache(get().prefs)
    applyTheme(get().prefs, { keepMode: true })
    set({ resolvedMode: domMode() })
  },
  setPrefs(p, o = {}) {
    const mode = applyTheme(p)
    if (o.persist !== false) savePrefs(p)
    set({ prefs: p, resolvedMode: mode })
  },
  syncSystem() {
    if (get().prefs.mode !== 'system') return
    const mode = applyTheme(get().prefs)
    set({ resolvedMode: mode })
  },
}))

export function useTheme() {
  const prefs = useThemeStore((s) => s.prefs)
  const resolvedMode = useThemeStore((s) => s.resolvedMode)
  const setPrefs = useThemeStore((s) => s.setPrefs)
  const report = useMemo<ContrastCheck[]>(() => auditTheme(resolveInput(prefs), resolvedMode), [prefs, resolvedMode])
  return {
    prefs,
    resolvedMode,
    report,
    /** Los COLORES son los de fábrica (el modo no cuenta). */
    isDefault: isDefaultLook(prefs),
    setMode: (mode: ThemeMode) => setPrefs({ ...prefs, mode }),
    toggle: () => setPrefs({ ...prefs, mode: resolvedMode === 'dark' ? 'light' : 'dark' }),
    setAccent: (accent: AccentSel) => setPrefs({ ...prefs, accent }),
    setTint: (tint: TintSel) => setPrefs({ ...prefs, tint }),
    setStrength: (strength: TintStrength) => setPrefs({ ...prefs, strength }),
    applyCombo: (id: string) => {
      const c = COMBOS.find((x) => x.id === id)
      if (c) setPrefs({ ...prefs, accent: c.accent, tint: c.tint, strength: c.strength })
    },
    /** Restablece solo los colores (acento, tinte, intensidad); el modo claro/oscuro/sistema se conserva. */
    reset: () => setPrefs({ ...DEFAULT_PREFS, mode: prefs.mode }),
  }
}

export { resolveMode }
