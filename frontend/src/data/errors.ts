// Errores estructurados del backend (ApiError) y su texto para el usuario. Contrato:
//   isApiError(e) / toApiError(e)      normaliza cualquier cosa lanzada por invoke (string, Error, objeto)
//   apiErrorMessage(e)                 mensaje en español para toasts (traduce por `code`, detalle = message del motor)
import type { ApiError, ApiErrorCode } from './types'

export function isApiError(e: unknown): e is ApiError {
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e && typeof (e as ApiError).code === 'string'
}

export function toApiError(e: unknown): ApiError {
  if (isApiError(e)) return e
  // Backend anterior a la ronda: devolvía String. Se conserva como error interno con el texto.
  if (typeof e === 'string') return { code: 'internal', message: e }
  if (e instanceof Error) return { code: 'internal', message: e.message }
  return { code: 'internal', message: 'Error desconocido' }
}

const TITLE: Record<ApiErrorCode, string> = {
  connection: 'No se pudo hablar con el motor de Docker',
  not_found: 'El recurso ya no existe',
  conflict: 'Docker rechazó la operación por el estado actual',
  invalid_input: 'Datos no válidos',
  engine: 'El motor de Docker devolvió un error',
  timeout: 'El motor tardó demasiado en responder',
  policy_denied: 'El motor de seguridad rechazó la acción',
  ticket_invalid: 'La confirmación ya no es válida',
  ticket_expired: 'La confirmación caducó',
  typed_mismatch: 'El texto de confirmación no coincide',
  state_changed: 'El recurso cambió mientras confirmabas',
  not_implemented: 'Todavía no disponible',
  internal: 'Error interno de la aplicación',
}

export function apiErrorTitle(e: ApiError): string {
  return TITLE[e.code]
}

/** Título + detalle (el `message` del motor va como subtexto: puede venir en inglés). */
export function apiErrorMessage(e: unknown): { title: string; detail: string } {
  const a = toApiError(e)
  // El backend usa `conflict` también para «demasiados planes pendientes» (tope de tickets): mensaje propio, no «Docker rechazó…».
  if (a.code === 'conflict' && /demasiad[oa]s?\s+(planes|tickets|acciones)|too many (pending )?(plans|tickets)/i.test(a.message)) {
    return { title: 'Hay demasiadas acciones pendientes de confirmar; cancela alguna o espera unos minutos', detail: '' }
  }
  return { title: TITLE[a.code], detail: a.message }
}
