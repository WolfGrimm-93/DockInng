// Simulado (Ola 3): bandeja, notificaciones, ventana propia y cierre controlado. No abre nada ni notifica de verdad: REGISTRA las llamadas
// para que los tests (y los guiones E2E) comprueben qué habría hecho el backend.
import type { EngineApi } from '../../api'
import type { BusySummary, NotifyRequest, TrayStatus, WindowEdge } from '../../types'

export interface SimWindowControls {
  /** Puertos «abiertos en el navegador» (llamadas a `containers.openPort`). */
  openedPorts: { id: string; port: number; scheme: string }[]
  /** Notificaciones enviadas con `notify_user`. */
  notifications: NotifyRequest[]
  /** Llamadas de ventana en orden: `minimize`, `toggleMaximize`, `close`, `startDrag`, `startResize:North`, `setDecorations:false`, `quit:true`… */
  calls: string[]
  /** Estado de la bandeja simulada (por defecto disponible). */
  tray: TrayStatus
  /** Operaciones en curso simuladas (`busy_summary`). */
  busy: BusySummary
  /** Simula que el backend pide confirmar la salida (evento `app://quit-requested`). */
  requestQuit(summary?: BusySummary): void
}

export function createSimWindow(): { api: EngineApi['window']; controls: SimWindowControls } {
  const listeners = new Set<(s: BusySummary) => void>()
  const controls: SimWindowControls = {
    openedPorts: [], notifications: [], calls: [],
    tray: { available: true, error: null },
    busy: { stacks: 0, pulls: 0, builds: 0, terminals: 0 },
    requestQuit(summary) { for (const cb of [...listeners]) cb(summary ?? { ...controls.busy }) },
  }
  const rec = (c: string) => async (): Promise<void> => { controls.calls.push(c) }
  const api: EngineApi['window'] = {
    trayStatus: async () => ({ ...controls.tray }),
    busySummary: async () => ({ ...controls.busy }),
    notifyUser: async (n) => { controls.notifications.push({ ...n }) },
    quitApp: async (confirmed) => { controls.calls.push(`quit:${confirmed}`) },
    setDecorations: async (enabled) => { controls.calls.push(`setDecorations:${enabled}`) },
    minimize: rec('minimize'),
    toggleMaximize: rec('toggleMaximize'),
    close: rec('close'),
    startDrag: rec('startDrag'),
    startResize: async (edge: WindowEdge) => { controls.calls.push(`startResize:${edge}`) },
    onQuitRequested(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
  return { api, controls }
}
