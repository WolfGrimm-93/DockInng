// Validadores puros de nombres/valores de recursos de Docker y Compose (volúmenes, redes, stacks) y textos de error del pull.
// Contrato: validateVolumeName · validateLabelKey · validateNetworkName · validateSubnet · validateGateway · STACK_NAME_RE · stackTemplate · pullErrorText
import { apiErrorMessage } from '@/data/errors'
import type { ApiError, Network } from '@/data/types'
import { cidrOverlaps, gatewayInside, isValidIp, parseCidr } from './cidr'

// ---- Volúmenes
export const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/
const LABEL_KEY_RE = /^[a-z0-9][a-z0-9._/-]{0,127}$/
const RESERVED_LABELS = ['com.docker.', 'io.docker.', 'org.opencontainers.']

export function validateVolumeName(name: string, existing: readonly string[]): string | null {
  if (!name) return 'Escribe un nombre.'
  if (name.length > 128) return 'Máximo 128 caracteres.'
  if (!VOLUME_NAME_RE.test(name)) return 'Mínimo 2 caracteres: letras, números, «_», «.» o «-», y empieza por letra o número.'
  if (existing.includes(name)) return 'Ya existe un volumen con ese nombre.'
  return null
}
export function validateLabelKey(key: string): string | null {
  if (!LABEL_KEY_RE.test(key)) return 'Clave no válida: minúsculas, números, «.», «_», «-» o «/».'
  if (RESERVED_LABELS.some((p) => key.startsWith(p))) return 'Ese prefijo está reservado por Docker.'
  return null
}

// ---- Redes
const NET_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/
const RESERVED_NETS = ['bridge', 'host', 'none', 'default']

export function validateNetworkName(name: string, existing: readonly string[]): string | null {
  if (!name) return 'Escribe un nombre.'
  if (name.length > 128) return 'Máximo 128 caracteres.'
  if (!NET_NAME_RE.test(name)) return 'Mínimo 2 caracteres: letras, números, «_», «.» o «-», y empieza por letra o número.'
  if (RESERVED_NETS.includes(name.toLowerCase())) return `«${name}» es un nombre reservado por Docker.`
  if (existing.includes(name)) return 'Ya existe una red con ese nombre.'
  return null
}
export function validateSubnet(subnet: string, others: readonly Pick<Network, 'name' | 'subnets'>[]): string | null {
  const s = subnet.trim()
  if (!s) return null
  if (!parseCidr(s)) return 'Subred no válida: usa el formato CIDR, por ejemplo 172.30.0.0/16.'
  for (const n of others) for (const o of n.subnets) if (cidrOverlaps(o, s)) return `Se solapa con la red «${n.name}» (${o}).`
  return null
}
export function validateGateway(gateway: string, subnet: string): string | null {
  const g = gateway.trim()
  if (!g) return null
  if (!subnet.trim()) return 'La puerta de enlace necesita una subred.'
  if (!isValidIp(g)) return 'Dirección IP no válida.'
  if (!gatewayInside(subnet, g)) return 'La puerta de enlace debe estar dentro de la subred.'
  return null
}

// ---- Stacks
export const STACK_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/
export const stackTemplate = (name: string): string => `name: ${name}\n\nservices:\n  app:\n    image: nginx:1.27-alpine\n    ports:\n      - "127.0.0.1:8080:80"\n`

// ---- Pull
/** Texto de error en español según el código del backend. */
export function pullErrorText(ref: string, e: ApiError): string {
  switch (e.code) {
    case 'auth_required': return 'El registro pidió autenticación. Iniciar sesión en registros llegará en una próxima versión; por ahora solo se pueden descargar imágenes públicas.'
    case 'image_missing': return `No se encontró la imagen ${ref}. Revisa el nombre y la etiqueta.`
    case 'registry_unreachable': return 'No se pudo contactar con el registro. Revisa tu conexión a internet.'
    case 'invalid_input': return `La referencia «${ref}» no es válida.`
    default: return /429|toomanyrequests|rate limit/i.test(e.message) ? 'El registro respondió 429 (demasiadas peticiones). Espera unos minutos o inicia sesión en el registro.' : apiErrorMessage(e).detail || apiErrorMessage(e).title
  }
}

// ---- Errores del backend con formato «campo: mensaje; campo: mensaje»
/** Separa los errores por campo conocidos; lo que no case queda en `rest` (error general). */
export function parseFieldErrors(text: string, known: readonly string[]): { fields: Record<string, string>; rest: string } {
  const fields: Record<string, string> = {}
  const rest: string[] = []
  for (const part of text.split(';')) {
    const m = /^\s*([A-Za-z_][\w.[\]-]*):\s*(.+?)\s*$/.exec(part)
    const key = m ? known.find((k) => m[1] === k || m[1].startsWith(`${k}[`)) : undefined
    if (m && key) fields[key] = fields[key] ? `${fields[key]}; ${m[2]}` : m[2]
    else if (part.trim()) rest.push(part.trim())
  }
  return { fields, rest: rest.join('; ') }
}
