// Referencias de imagen: normalización para comparar «postgres» con «postgres:latest» / «docker.io/library/postgres:latest».
// Contrato: normalizeImageRef(ref) -> string · hasExplicitTag(ref) -> boolean · validateImageRef(ref) -> string | null (mensaje en español)

/** ¿La referencia trae etiqueta o digest? Un `:` solo cuenta como etiqueta si va después de la última `/` (puerto de registro). */
export function hasExplicitTag(ref: string): boolean {
  const r = ref.trim()
  if (r.includes('@')) return true
  const slash = r.lastIndexOf('/')
  return r.indexOf(':', slash + 1) >= 0
}

/** Forma canónica para comparar con la lista local: sin `docker.io/` ni `library/`, con `:latest` si no hay etiqueta. */
export function normalizeImageRef(ref: string): string {
  let r = ref.trim()
  r = r.replace(/^(?:index\.)?docker\.io\//, '').replace(/^library\//, '')
  return hasExplicitTag(r) ? r : `${r}:latest`
}

/** `null` = válida. Solo validación ligera de forma (el motor tiene la última palabra). */
export function validateImageRef(ref: string): string | null {
  const r = ref.trim()
  if (!r) return 'Indica la imagen.'
  if (r.length > 255) return 'La referencia es demasiado larga (máximo 255 caracteres).'
  if (/\s/.test(r)) return 'La referencia no puede tener espacios.'
  if (/^-/.test(r)) return 'La referencia no puede empezar por un guion.'
  const name = r.split('@')[0].replace(/:[^:/]*$/, '')
  if (/[A-Z]/.test(name)) return 'El nombre de la imagen debe ir en minúsculas.'
  if (!/^[a-z0-9][a-zA-Z0-9._:/@-]*$/.test(r)) return 'Formato no válido: usa «nombre:etiqueta» o «registro/nombre:etiqueta».'
  return null
}

/** Servidor del registro de una referencia (`ghcr.io/x/y:1` → `ghcr.io`; sin host explícito → `docker.io`). */
export function registryOf(ref: string): string {
  const r = ref.trim().replace(/^https?:\/\//, '')
  const first = r.split('/')[0]
  return r.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost') ? first.toLowerCase() : 'docker.io'
}
