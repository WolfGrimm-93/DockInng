// Validación y conversión del formulario «Nuevo contenedor» (puro, testeable). Contrato:
//   validateCreateForm(form, ctx) -> { errors: Record<clave, mensaje>, order: clave[] }   claves: image · name · command · ports.<id>.host|container · vols.<id>.source|target · env.<id>.key · network
//   toCreateSpec(form) -> CreateContainerSpec (números, no strings; ignora filas vacías)
//   backendFieldToKey(form, field) -> clave del formulario para un `field` del backend («ports[0].host_port»)
import type { CreateContainerSpec, Restart } from '@/data/types'
import { normalizeImageRef, validateImageRef } from './imageRef'

export interface PortRow { id: string; hostIp: 'local' | 'all'; host: string; container: string; protocol: 'tcp' | 'udp' }
export interface VolRow { id: string; source: string; target: string; readOnly: boolean }
export interface EnvRow { id: string; key: string; value: string }
export interface CreateForm { image: string; name: string; command: string; restart: Restart; network: string; ports: PortRow[]; vols: VolRow[]; env: EnvRow[] }

export interface FormContext {
  containerNames: readonly string[]
  /** puerto publicado -> nombre del contenedor en ejecución que lo usa. */
  publishedPorts: ReadonlyMap<number, string>
  networks: readonly string[]
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const HOST_IP = { local: '127.0.0.1', all: '0.0.0.0' } as const

const portNum = (s: string): number | null => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null)
const portOk = (n: number | null): n is number => n !== null && n >= 1 && n <= 65535

export function validateCreateForm(f: CreateForm, ctx: FormContext): { errors: Record<string, string>; order: string[] } {
  const e: Record<string, string> = {}
  const order: string[] = []
  const put = (k: string, m: string) => { if (!(k in e)) { e[k] = m; order.push(k) } }

  const img = validateImageRef(f.image)
  if (img) put('image', img)
  const name = f.name.trim()
  if (name) {
    if (!NAME_RE.test(name)) put('name', 'Solo letras, números, punto, guion y guion bajo; debe empezar por letra o número.')
    else if (name.length > 128) put('name', 'Máximo 128 caracteres.')
    else if (ctx.containerNames.includes(name)) put('name', `Ya existe un contenedor llamado ${name}.`)
  }
  const seenHost = new Map<string, string>()
  for (const p of f.ports) {
    if (!p.host.trim() && !p.container.trim()) continue
    const c = portNum(p.container)
    if (!p.container.trim()) put(`ports.${p.id}.container`, 'Indica el puerto del contenedor.')
    else if (!portOk(c)) put(`ports.${p.id}.container`, 'Puerto del contenedor: un número de 1 a 65535.')
    if (p.host.trim()) {
      const h = portNum(p.host)
      if (!portOk(h)) put(`ports.${p.id}.host`, 'Puerto del equipo: un número de 1 a 65535.')
      else {
        const key = `${p.hostIp}:${h}/${p.protocol}`
        if (seenHost.has(key)) put(`ports.${p.id}.host`, `El puerto ${h}/${p.protocol} ya está en otra fila.`)
        seenHost.set(key, p.id)
        const by = ctx.publishedPorts.get(h)
        if (by && p.protocol === 'tcp') put(`ports.${p.id}.host`, `El puerto ${h} del equipo ya lo usa ${by}.`)
      }
    }
  }
  const seenTarget = new Set<string>()
  for (const v of f.vols) {
    if (!v.source.trim() && !v.target.trim()) continue
    if (!v.source.trim()) put(`vols.${v.id}.source`, 'Indica el origen (volumen o ruta absoluta).')
    else if (/^\.{1,2}(\/|$)/.test(v.source.trim())) put(`vols.${v.id}.source`, 'Usa una ruta absoluta (/…) o el nombre de un volumen; las rutas relativas no se admiten.')
    else if (/[,:]/.test(v.source.trim())) put(`vols.${v.id}.source`, 'El origen no puede contener «:» ni «,».')
    if (!v.target.trim()) put(`vols.${v.id}.target`, 'Indica la ruta dentro del contenedor.')
    else if (!v.target.trim().startsWith('/')) put(`vols.${v.id}.target`, 'La ruta del contenedor debe ser absoluta (empieza por «/»).')
    else if (seenTarget.has(v.target.trim())) put(`vols.${v.id}.target`, 'Esa ruta ya se usa en otra fila.')
    seenTarget.add(v.target.trim())
  }
  const seenKey = new Set<string>()
  for (const v of f.env) {
    if (!v.key.trim() && !v.value) continue
    if (!ENV_RE.test(v.key.trim())) put(`env.${v.id}.key`, 'Nombre no válido: letras, números y «_», sin empezar por número.')
    else if (seenKey.has(v.key.trim())) put(`env.${v.id}.key`, 'Variable repetida.')
    seenKey.add(v.key.trim())
  }
  if (f.network && !['bridge', 'host', 'none'].includes(f.network) && !ctx.networks.includes(f.network)) put('network', `No existe la red ${f.network}.`)
  return { errors: e, order }
}

export function toCreateSpec(f: CreateForm, labels: Record<string, string> = {}): CreateContainerSpec {
  return {
    image: f.image.trim(),
    name: f.name.trim() || null,
    ports: f.ports.filter((p) => p.container.trim()).map((p) => ({
      host_ip: p.host.trim() ? HOST_IP[p.hostIp] : null,
      host_port: p.host.trim() ? Number(p.host) : null,
      container_port: Number(p.container),
      protocol: p.protocol,
    })),
    volumes: f.vols.filter((v) => v.source.trim() && v.target.trim()).map((v) => ({ source: v.source.trim(), target: v.target.trim(), read_only: v.readOnly })),
    env: f.env.filter((v) => v.key.trim()).map((v) => ({ key: v.key.trim(), value: v.value })),
    network: f.network || null,
    restart: f.restart,
    restart_max_retries: null,
    command: f.command.trim() || null,
    labels,
  }
}

/** Traduce el `field` del backend («ports[1].host_port», «volumes[0].source», «env[2].key», «name») a la clave del formulario. */
export function backendFieldToKey(f: CreateForm, field: string): string {
  const m = /^(ports|volumes|env)\[(\d+)\]\.(\w+)$/.exec(field)
  if (!m) return field
  const i = Number(m[2])
  if (m[1] === 'ports') {
    const rows = f.ports.filter((p) => p.container.trim())
    return rows[i] ? `ports.${rows[i].id}.${m[3] === 'host_port' || m[3] === 'host_ip' ? 'host' : 'container'}` : field
  }
  if (m[1] === 'volumes') {
    const rows = f.vols.filter((v) => v.source.trim() && v.target.trim())
    return rows[i] ? `vols.${rows[i].id}.${m[3] === 'target' ? 'target' : 'source'}` : field
  }
  const rows = f.env.filter((v) => v.key.trim())
  return rows[i] ? `env.${rows[i].id}.key` : field
}

/** ¿La imagen ya está en este equipo? Compara la forma normalizada (`postgres` == `postgres:latest`). */
export function imageIsLocal(images: readonly { reference: string; id: string }[], ref: string): boolean {
  const n = normalizeImageRef(ref)
  return images.some((i) => i.reference === n || i.id === ref.trim() || i.id.startsWith(`sha256:${ref.trim()}`))
}
