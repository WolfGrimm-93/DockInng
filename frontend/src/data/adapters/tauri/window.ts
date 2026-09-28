// Comandos IPC de la Ola 3 que no son streams: bandeja, notificaciones, ventana propia (sin marco) y cierre controlado.
// El cierre con operaciones en curso llega por el canal de `subscribe_app_events` (`{type:'quit_requested', summary}`; NO son eventos de Tauri:
// escucharlos exigiría `core:event:*`); la UI responde con `quit_app(true)` o no responde (cancelar).
import { invoke } from '@tauri-apps/api/core'
import type { EngineApi } from '../../api'
import { toApiError } from '../../errors'
import { subscribe } from './streams'
import type { AppFeed, BusySummary, TrayStatus } from '../../types'

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (e) {
    throw toApiError(e)
  }
}


/** Defensa: el payload llega de Rust, pero una forma inesperada no debe tumbar el diálogo de salida. */
export function normalizeBusy(p: unknown): BusySummary {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
  const n = (k: string): number => (typeof o[k] === 'number' && Number.isFinite(o[k]) && (o[k] as number) > 0 ? Math.floor(o[k] as number) : 0)
  return { stacks: n('stacks'), pulls: n('pulls'), builds: n('builds'), terminals: n('terminals') }
}

export function createTauriWindow(): EngineApi['window'] {
  return {
    trayStatus: () => call<TrayStatus>('tray_status'),
    busySummary: async () => normalizeBusy(await call<unknown>('busy_summary')),
    notifyUser: (n) => call<void>('notify_user', { kind: n.kind, title: n.title, body: n.body }),
    quitApp: (confirmed) => call<void>('quit_app', { confirmed }),
    setDecorations: (enabled) => call<void>('window_set_decorations', { enabled }),
    minimize: () => call<void>('window_minimize'),
    toggleMaximize: () => call<void>('window_toggle_maximize'),
    close: () => call<void>('window_close'),
    startDrag: () => call<void>('window_start_drag'),
    startResize: (edge) => call<void>('window_start_resize', { direction: edge }),
    onQuitRequested: (cb) =>
      subscribe<AppFeed>('subscribe_app_events', {}, (f) => { if (f.type === 'quit_requested') cb(normalizeBusy(f.summary)) }),
  }
}
