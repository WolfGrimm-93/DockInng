// Validación en el borde y construcción del spec de una conexión (SSH o TLS) desde el formulario «Nueva conexión».
// Pura: sin React. El backend vuelve a validar; esto solo evita enviar datos claramente inválidos.
import type { ConnSpec } from '@/data/types'

export type Kind = 'ssh' | 'tls'
export type Mode = 'explicit' | 'alias'
export type Ident = 'agent' | 'file'
export type ConnFormErrors = Partial<Record<'name' | 'host' | 'port' | 'user' | 'identity' | 'ca' | 'cert' | 'key', string>>

/** Campos del formulario tal como los edita el usuario (texto sin normalizar). */
export interface ConnFormValues {
  kind: Kind
  name: string
  host: string
  port: string
  user: string
  mode: Mode
  ident: Ident
  identPath: string
  ca: string
  cert: string
  keyPath: string
}

const HOST_RE = /^(?:[A-Za-z0-9._-]{1,253}|\[[0-9A-Fa-f:.]+\])$/
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/

/** `editId` excluye la propia conexión al comprobar nombres duplicados. */
export function buildConnSpec(v: ConnFormValues, existing: readonly { id: string; name: string }[], editId: string | null):
  { spec: ConnSpec; errors: null } | { spec: null; errors: ConnFormErrors } {
  const ssh = v.kind === 'ssh'
  const e: ConnFormErrors = {}
  const p = Number(v.port)
  if (!v.name.trim() || v.name.trim().length > 40) e.name = 'Escribe un nombre (1–40 caracteres).'
  else if (v.name.trim().toLowerCase() === 'local') e.name = 'El nombre «Local» está reservado.'
  else if (existing.some((c) => c.id !== editId && c.name.trim().toLowerCase() === v.name.trim().toLowerCase())) e.name = 'Ya existe una conexión con ese nombre: elige otro (o elimínala antes desde Configuración).'
  if (!HOST_RE.test(v.host.trim()) || v.host.trim().startsWith('-')) e.host = ssh && v.mode === 'alias' ? 'Alias no válido (letras, números, punto, guion).' : 'Host no válido (nombre, IPv4 o [IPv6]).'
  if (!Number.isInteger(p) || p < 1 || p > 65535) e.port = 'Puerto entre 1 y 65535.'
  if (ssh) {
    if (v.mode === 'explicit' && !USER_RE.test(v.user.trim())) e.user = 'Usuario no válido (minúsculas, números, _ y -).'
    if (v.ident === 'file' && !v.identPath.trim().startsWith('/')) e.identity = 'Indica la ruta ABSOLUTA de la llave privada.'
  } else {
    if (!v.ca.trim().startsWith('/')) e.ca = 'Ruta absoluta del certificado CA.'
    if (!v.cert.trim().startsWith('/')) e.cert = 'Ruta absoluta del certificado de cliente.'
    if (!v.keyPath.trim().startsWith('/')) e.key = 'Ruta absoluta de la llave de cliente.'
  }
  if (Object.keys(e).length) return { spec: null, errors: e }
  const base = { name: v.name.trim(), host: v.host.trim(), port: p }
  const spec: ConnSpec = ssh
    ? { kind: 'ssh', ...base, user: v.user.trim(), mode: v.mode, identity: v.ident === 'agent' ? { type: 'agent' } : { type: 'file', path: v.identPath.trim() } }
    : { kind: 'tls', ...base, ca_path: v.ca.trim(), cert_path: v.cert.trim(), key_path: v.keyPath.trim() }
  return { spec, errors: null }
}
