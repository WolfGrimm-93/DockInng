// Puente Channel de Tauri -> callback + función de cancelación (síncrona para la UI).
// El backend crea la suscripción con `subscribe_*` (devuelve un SubscriptionId UUID v7) y la cancela con `unsubscribe`.
import { Channel, invoke } from '@tauri-apps/api/core'
import { toApiError } from '../../errors'
import type { ApiError, Unsubscribe } from '../../types'

export function subscribe<T>(
  command: string,
  args: Record<string, unknown>,
  onMessage: (m: T) => void,
  onFail?: (e: ApiError) => void,
): Unsubscribe {
  const channel = new Channel<T>()
  channel.onmessage = (m) => onMessage(m)
  let subscriptionId: string | null = null
  let cancelled = false
  invoke<string>(command, { ...args, onEvent: channel })
    .then((id) => {
      subscriptionId = id
      // Si la UI canceló antes de que llegara el id, se cierra ahora.
      if (cancelled) void invoke('unsubscribe', { subscriptionId: id }).catch(() => {})
    })
    .catch((e) => {
      if (!cancelled) onFail?.(toApiError(e))
    })
  return () => {
    if (cancelled) return
    cancelled = true
    channel.onmessage = () => {}
    if (subscriptionId) void invoke('unsubscribe', { subscriptionId }).catch(() => {})
  }
}
