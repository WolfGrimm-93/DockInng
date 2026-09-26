// Puente Channel de Tauri -> callback + función de cancelación (síncrona para la UI).
// El backend crea la suscripción con `subscribe_*` (devuelve un SubscriptionId UUID v7) y la cancela con `unsubscribe`.
import { Channel, invoke } from '@tauri-apps/api/core'
import { toApiError } from '../../errors'
import type { ApiError, Unsubscribe } from '../../types'

export interface SubscriptionHandle {
  /** Aborta la suscripción (idempotente; si el id llega tarde se cierra al llegar). */
  unsubscribe: Unsubscribe
  /** Resuelve con el id de suscripción (null si falló o se canceló antes de tenerlo). */
  id(): Promise<string | null>
}

export function subscribeHandle<T>(
  command: string,
  args: Record<string, unknown>,
  onMessage: (m: T) => void,
  onFail?: (e: ApiError) => void,
): SubscriptionHandle {
  const channel = new Channel<T>()
  channel.onmessage = (m) => onMessage(m)
  let subscriptionId: string | null = null
  let cancelled = false
  const idPromise = invoke<string>(command, { ...args, onEvent: channel })
    .then((id) => {
      subscriptionId = id
      // Si la UI canceló antes de que llegara el id, se cierra ahora.
      if (cancelled) void invoke('unsubscribe', { subscriptionId: id }).catch(() => {})
      return cancelled ? null : id
    })
    .catch((e) => {
      if (!cancelled) onFail?.(toApiError(e))
      return null
    })
  return {
    id: () => idPromise,
    unsubscribe: () => {
      if (cancelled) return
      cancelled = true
      channel.onmessage = () => {}
      if (subscriptionId) void invoke('unsubscribe', { subscriptionId }).catch(() => {})
    },
  }
}

export function subscribe<T>(
  command: string,
  args: Record<string, unknown>,
  onMessage: (m: T) => void,
  onFail?: (e: ApiError) => void,
): Unsubscribe {
  return subscribeHandle<T>(command, args, onMessage, onFail).unsubscribe
}
