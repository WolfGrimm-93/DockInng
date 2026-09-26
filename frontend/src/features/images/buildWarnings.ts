// Texto de los avisos de `build_plan` (puro). Todo valor viene del backend/usuario y se trata como texto.
import type { BuildWarning } from '@/data/types'
import { safeText } from '@/lib/safeText'

export function warningText(w: BuildWarning): string {
  if (w.type === 'sensitive_context') return `El contexto${typeof w.path === 'string' ? ` «${safeText(w.path, { singleLine: true })}»` : ''} es una ruta sensible (raíz, HOME o carpeta del sistema): se enviaría entera al motor.`
  if (w.type === 'secret_like_arg') return `El argumento «${safeText(String(w.name), { singleLine: true })}» parece un secreto: los ARG quedan en el historial de la imagen. Usa secretos de build (--secret) en su lugar.`
  return `Aviso del motor (${safeText(String(w.type), { singleLine: true })}).`
}

