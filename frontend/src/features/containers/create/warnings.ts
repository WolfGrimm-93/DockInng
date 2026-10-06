// Textos de los avisos del plan de creación (el backend decide cuáles aplican; aquí solo se traducen a frases).
import { safeText } from '@/lib/safeText'
import type { CreateWarning } from '@/data/types'

/** Frase para un aviso del plan; null si el aviso no se muestra. */
export function warningLine(w: CreateWarning): string | null {
  switch (w.type) {
    case 'sensitive_bind': return `Ruta sensible ${safeText(w.source, { singleLine: true })}: ${safeText(w.reason, { singleLine: true })}`
    case 'docker_socket': return '/var/run/docker.sock da control total de Docker al contenedor.'
    case 'host_network': return 'Usa la red del equipo (network=host): el contenedor no está aislado de la red.'
    case 'remote_bind': return `El montaje ${safeText(w.source, { singleLine: true })} se resuelve en el servidor remoto, no en tu equipo.`
    default: return null
  }
}
