// Preferencias de bandeja, notificaciones y ventana (Ola 3), cacheadas en un store de zustand para que Ajustes, el chrome de ventana y las
// notificaciones lean lo mismo. La fuente de verdad es el backend (`prefs_get/prefs_set`; la decoración además pasa por `window_set_decorations`).
// Valores por defecto = los del backend: notificaciones APAGADAS (opt-in), bandeja activa, cerrar a bandeja APAGADO, ventana con barra del
// sistema, sin iniciar minimizada. Cualquier forma inesperada de lo guardado vuelve al valor por defecto (nunca rompe la UI).
import { create } from 'zustand'
import type { EngineApi } from './api'
import { apiErrorMessage } from './errors'
import type { NotifyEvents, PrefKey, TrayStatus } from './types'
import { toast } from '@/lib/toastStore'

export const DEFAULT_NOTIFY_EVENTS: NotifyEvents = { die: true, oom: true, unhealthy: true, op_done: true }
export const NOTIFY_EVENT_KEYS = ['die', 'oom', 'unhealthy', 'op_done'] as const

export const parseBool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def)
export function parseNotifyEvents(v: unknown): NotifyEvents {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>
  return { die: parseBool(o.die, true), oom: parseBool(o.oom, true), unhealthy: parseBool(o.unhealthy, true), op_done: parseBool(o.op_done, true) }
}

export interface ShellPrefsState {
  /** Ya se leyeron las preferencias del backend (antes, los valores son los de fábrica). */
  loaded: boolean
  notifyEnabled: boolean
  notifyEvents: NotifyEvents
  trayEnabled: boolean
  closeToTray: boolean
  decorations: boolean
  startMinimized: boolean
  /** null = aún sin consultar. */
  tray: TrayStatus | null
  load(api: EngineApi): Promise<void>
  /** Cambio optimista de una preferencia booleana/objeto; si el backend la rechaza se revierte y se avisa. */
  setPref(api: EngineApi, key: Exclude<PrefKey, 'polling' | 'last_connection_id' | 'window_decorations'>, value: boolean | NotifyEvents): Promise<void>
  /** Barra del sistema (true) o ventana sin marco (false). Revierte si el backend falla. */
  setDecorations(api: EngineApi, enabled: boolean): Promise<void>
}

const FIELD = { notify_enabled: 'notifyEnabled', notify_events: 'notifyEvents', tray_enabled: 'trayEnabled', close_to_tray: 'closeToTray', start_minimized: 'startMinimized' } as const

const initial = { loaded: false, notifyEnabled: false, notifyEvents: DEFAULT_NOTIFY_EVENTS, trayEnabled: true, closeToTray: false, decorations: true, startMinimized: false, tray: null as TrayStatus | null }

export const useShellPrefs = create<ShellPrefsState>()((set, get) => ({
  ...initial,
  async load(api) {
    const read = async (k: PrefKey): Promise<unknown> => { try { return await api.prefs.get(k) } catch { return null } }
    const [ne, ev, te, ct, wd, sm, tray] = await Promise.all([
      read('notify_enabled'), read('notify_events'), read('tray_enabled'), read('close_to_tray'), read('window_decorations'), read('start_minimized'),
      api.window.trayStatus().catch((): TrayStatus => ({ available: false, error: null })),
    ])
    set({
      loaded: true, notifyEnabled: parseBool(ne, false), notifyEvents: parseNotifyEvents(ev), trayEnabled: parseBool(te, true), closeToTray: parseBool(ct, false),
      decorations: parseBool(wd, true), startMinimized: parseBool(sm, false), tray,
    })
  },
  async setPref(api, key, value) {
    const field = FIELD[key]
    const prev = get()[field]
    set({ [field]: value } as Partial<ShellPrefsState>)
    try {
      await api.prefs.set(key, value)
      // La bandeja pudo aparecer/desaparecer: se vuelve a consultar.
      if (key === 'tray_enabled') set({ tray: await api.window.trayStatus().catch(() => get().tray) })
    } catch (e) {
      set({ [field]: prev } as Partial<ShellPrefsState>)
      const m = apiErrorMessage(e)
      toast.err('No se pudo guardar el ajuste', { sub: m.detail || m.title })
    }
  },
  async setDecorations(api, enabled) {
    const prev = get().decorations
    set({ decorations: enabled })
    try {
      await api.window.setDecorations(enabled)
    } catch (e) {
      set({ decorations: prev })
      const m = apiErrorMessage(e)
      toast.err('No se pudo cambiar la barra de la ventana', { sub: m.detail || m.title })
    }
  },
}))

/** Solo tests. */
export const resetShellPrefs = (): void => useShellPrefs.setState({ ...initial })
