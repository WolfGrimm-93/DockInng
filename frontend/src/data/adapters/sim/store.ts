// Simulado: almacén persistente del backend (grupos, preferencias) + registries + conexiones remotas (perfiles, huellas de host).
// Es memoria en RAM (los tests parten de cero). Con `persist` (solo navegador) los grupos se guardan en localStorage para que el
// desarrollo con Vite sea usable entre recargas. Replica las validaciones del backend en el borde (nombres, matiz, límites).
// Nada de esto es real: los perfiles remotos creados aquí son `simulated:true`.
import { uuidv7 } from '@/lib/uuid7'
import { MAX_ASSIGNMENTS, MAX_GROUPS, clampHue, isUuidV7, sanitizeGroups, validateGroupName } from '@/lib/groupRules'
import { GROUP_HUES } from '@/features/common/groupColor'
import type { EngineApi } from '../../api'
import type {
  ConnSpec, ConnTestResult, ConnectionProfile, GroupOp, GroupsSnapshot, HostKeyProbe, PrefKey, RegistrySummary,
} from '../../types'
import { apiError, sleep, type SimCtx } from './ctx'

const SEP = '\u0000'
const nextFreeHue = (used: readonly number[]): number => GROUP_HUES.find((h) => !used.includes(h)) ?? GROUP_HUES[used.length % GROUP_HUES.length]
const PREF_KEYS: readonly PrefKey[] = ['polling', 'last_connection_id', 'notify_enabled', 'notify_events', 'tray_enabled', 'close_to_tray', 'window_decorations', 'start_minimized']
const BOOL_PREFS: readonly PrefKey[] = ['notify_enabled', 'tray_enabled', 'close_to_tray', 'window_decorations', 'start_minimized']
/** Validación de forma como la del backend: booleanos estrictos y `notify_events` con solo sus 4 claves (opcionales) booleanas. */
function validPref(key: PrefKey, value: unknown): boolean {
  if (BOOL_PREFS.includes(key)) return typeof value === 'boolean'
  if (key === 'notify_events') {
    const v = value as Record<string, unknown> | null
    return !!v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v).every(([k, x]) => ['die', 'oom', 'unhealthy', 'op_done'].includes(k) && typeof x === 'boolean')
  }
  return true
}
const SIM_GROUPS_KEY = 'dockinng.sim.groups.v1'

export interface SimStoreOptions {
  /** Persistencia en localStorage (solo el navegador; los tests no la usan). */
  persist?: boolean
}
export interface SimStoreControls {
  /** Huellas de host aceptadas (host:puerto -> fingerprint). */
  trustedHosts: Map<string, string>
}

/** Huella SHA256 falsa y determinista por host (formato de OpenSSH). Marcada como simulada en la UI. */
export function fakeFingerprint(host: string, salt = ''): string {
  let h = 2166136261
  const s = host + salt
  const bytes: number[] = []
  for (let i = 0; i < 32; i++) {
    h = Math.imul(h ^ (s.charCodeAt(i % Math.max(1, s.length)) || 7 + i), 16777619) >>> 0
    bytes.push(h & 255)
  }
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/=+$/, '')
  return `SHA256:${b64}`
}

type Stores = { connections: Omit<EngineApi['connections'], 'select'> } & Pick<EngineApi, 'registries' | 'groups' | 'prefs'>

/** `getActive`: id de la conexión activa (la mantiene index.ts junto con el estado de fallos simulados). */
export function createSimStore(ctx: SimCtx, getActive: () => string, opts: SimStoreOptions = {}): { api: Stores; controls: SimStoreControls } {
  const trustedHosts = new Map<string, string>()
  // Hosts «cambiados» de ejemplo que el usuario ya olvidó: a partir de ahí se ven como desconocidos.
  const olvidados = new Set<string>()
  const prefs = new Map<string, unknown>()
  const registries: RegistrySummary[] = []

  // ------------------------------------------------------------- grupos
  let groups: GroupsSnapshot = { groups: [], assignments: [], stack_hues: {}, legacy_imported: false }
  if (opts.persist) {
    try {
      const raw = JSON.parse(window.localStorage.getItem(SIM_GROUPS_KEY) ?? 'null') as GroupsSnapshot | null
      if (raw && Array.isArray(raw.groups)) groups = raw
    } catch { /* sin storage */ }
  }
  const save = () => {
    if (!opts.persist) return
    try { window.localStorage.setItem(SIM_GROUPS_KEY, JSON.stringify(groups)) } catch { /* sin storage */ }
  }
  const snap = (): GroupsSnapshot => structuredClone(groups)
  const connKnown = (id: string) => id === 'local' || ctx.world.profiles.some((p) => p.id === id)

  function applyOp(op: GroupOp): void {
    const g = groups
    switch (op.type) {
      case 'create_group': {
        if (g.groups.length >= MAX_GROUPS) throw apiError('invalid_input', `Máximo ${MAX_GROUPS} grupos.`)
        const bad = validateGroupName(op.name, g.groups)
        if (bad) throw apiError('invalid_input', bad)
        // El id lo genera el backend (UUID v7), como el real: la UI lo conoce por el snapshot.
        g.groups.push({ id: uuidv7(), name: op.name.trim(), hue: op.hue === null ? nextFreeHue(g.groups.map((x) => x.hue)) : clampHue(op.hue) })
        return
      }
      case 'rename_group': {
        const t = g.groups.find((x) => x.id === op.id)
        if (!t) throw apiError('not_found', 'El grupo ya no existe.')
        const bad = validateGroupName(op.name, g.groups, op.id)
        if (bad) throw apiError('invalid_input', bad)
        t.name = op.name.trim()
        return
      }
      case 'set_group_hue': {
        const t = g.groups.find((x) => x.id === op.id)
        if (!t) throw apiError('not_found', 'El grupo ya no existe.')
        t.hue = clampHue(op.hue)
        return
      }
      case 'delete_group':
        g.groups = g.groups.filter((x) => x.id !== op.id)
        g.assignments = g.assignments.filter((a) => a.group_id !== op.id) // FK ON DELETE CASCADE
        return
      case 'assign': {
        if (!connKnown(op.connection_id)) throw apiError('not_found', 'La conexión no existe.')
        if (op.group_id !== null && !g.groups.some((x) => x.id === op.group_id)) throw apiError('not_found', 'El grupo ya no existe.')
        const names = new Set(op.names)
        g.assignments = g.assignments.filter((a) => !(a.connection_id === op.connection_id && names.has(a.container_name)))
        if (op.group_id !== null) {
          for (const n of names) g.assignments.push({ connection_id: op.connection_id, container_name: n, group_id: op.group_id })
          if (g.assignments.length > MAX_ASSIGNMENTS) throw apiError('invalid_input', 'Demasiadas asignaciones.')
        }
        return
      }
      case 'set_stack_hue':
        if (op.hue === null) delete g.stack_hues[op.project]
        else g.stack_hues[op.project] = clampHue(op.hue)
        return
      case 'prune_assignments': {
        if (!connKnown(op.connection_id)) throw apiError('not_found', 'La conexión no existe.')
        const vivos = new Set(op.live_names)
        g.assignments = g.assignments.filter((a) => a.connection_id !== op.connection_id || vivos.has(a.container_name))
        return
      }
    }
  }

  // ------------------------------------------------------------- conexiones
  const hostKey = (spec: ConnSpec) => `${spec.host.toLowerCase()}:${spec.port}`
  function validateSpec(spec: ConnSpec): void {
    const name = spec.name.trim()
    if (!name || name.length > 40) throw apiError('invalid_input', 'El nombre debe tener entre 1 y 40 caracteres.')
    if (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) throw apiError('invalid_input', 'El puerto debe estar entre 1 y 65535.')
    if (!/^(?:[A-Za-z0-9._-]{1,253}|\[[0-9A-Fa-f:.]+\])$/.test(spec.host) || spec.host.startsWith('-')) throw apiError('invalid_input', 'El host no es válido.')
    if (spec.kind === 'ssh') {
      if (spec.mode === 'explicit' && !/^[a-z_][a-z0-9_-]{0,31}$/.test(spec.user)) throw apiError('invalid_input', 'El usuario no es válido.')
      if (spec.identity.type === 'file' && !spec.identity.path.startsWith('/')) throw apiError('invalid_input', 'La ruta de la llave debe ser absoluta.')
    } else if (![spec.ca_path, spec.cert_path, spec.key_path].every((p) => p.startsWith('/'))) {
      throw apiError('invalid_input', 'Las rutas de certificados deben ser absolutas.')
    }
  }
  function probeOf(spec: ConnSpec): HostKeyProbe {
    const fp = fakeFingerprint(spec.host, 'ed25519')
    const known = trustedHosts.get(hostKey(spec))
    if (/changed|mitm/i.test(spec.host) && !olvidados.has(hostKey(spec))) return { key_type: 'ssh-ed25519', fingerprint_sha256: fakeFingerprint(spec.host, 'nueva'), state: 'changed', known_fingerprint_sha256: fp }
    return { key_type: 'ssh-ed25519', fingerprint_sha256: fp, state: known === fp ? 'trusted' : 'unknown' }
  }

  const api: Stores = {
    connections: {
      async list() { return ctx.world.profiles.map((p) => ({ ...p })) },
      async probeHostKey(spec) {
        await sleep(Math.min(ctx.latency, 300))
        validateSpec(spec)
        if (spec.kind !== 'ssh') throw apiError('invalid_input', 'La huella de host solo aplica a SSH.')
        if (/offline/i.test(spec.host)) throw apiError('connection', 'No se pudo alcanzar el host para leer su clave.')
        return probeOf(spec)
      },
      async trustHostKey(spec, fingerprint) {
        await sleep(Math.min(ctx.latency, 200))
        const p = probeOf(spec)
        if (p.state === 'changed') throw apiError('connection', 'La clave del servidor cambió respecto a la de confianza: no se acepta automáticamente.', 'host_key_changed')
        if (p.fingerprint_sha256 !== fingerprint) throw apiError('conflict', 'La huella del servidor cambió desde que la viste: vuelve a sondear.')
        trustedHosts.set(hostKey(spec), fingerprint)
        return { ...p, state: 'trusted' }
      },
      async forgetHostKey(spec, confirmedHost) {
        await sleep(Math.min(ctx.latency, 200))
        validateSpec(spec)
        if (spec.kind !== 'ssh') throw apiError('invalid_input', 'La huella de host solo aplica a SSH.')
        // Mismo criterio que el backend: confirmación escrita exacta (sin recortar mayúsculas).
        if (confirmedHost.trim() !== spec.host.trim()) throw apiError('policy_denied', 'Escribe exactamente el nombre indicado para confirmar.')
        trustedHosts.delete(hostKey(spec))
        olvidados.add(hostKey(spec))
      },
      async test(spec): Promise<ConnTestResult> {
        await sleep(Math.min(ctx.latency + 400, 1200))
        validateSpec(spec)
        const fail = (cause: NonNullable<ConnTestResult['cause']>, message: string): ConnTestResult => ({ ok: false, cause, error: { code: 'connection', message, cause } })
        if (spec.kind === 'ssh') {
          const p = probeOf(spec)
          if (p.state === 'changed') return fail('host_key_changed', 'Host key verification failed.')
          if (p.state === 'unknown') return fail('host_key_unknown', 'La clave del host no está confirmada.')
          if (/unreach/i.test(spec.host)) return fail('unreachable', 'Connection timed out')
          if (/auth|fail/i.test(spec.host)) return fail('auth_failed', 'Permission denied (publickey).')
          if (/nodocker/i.test(spec.host)) return fail('remote_docker_missing', 'docker: command not found')
        } else {
          if (/badca|tls/i.test(spec.host)) return fail('tls_invalid', 'x509: certificate signed by unknown authority')
          if (/unreach|offline/i.test(spec.host)) return fail('unreachable', 'connection refused')
        }
        return { ok: true, server: { version: '26.1.4', api_version: '1.45', os: 'linux', arch: 'x86_64' } }
      },
      async save(spec, id) {
        await sleep(Math.min(ctx.latency, 200))
        validateSpec(spec)
        const name = spec.name.trim()
        if (name.toLowerCase() === 'local') throw apiError('invalid_input', 'El nombre «Local» está reservado.')
        const target = spec.kind === 'ssh'
          ? `ssh://${spec.mode === 'alias' ? '' : `${spec.user}@`}${spec.host}${spec.port === 22 ? '' : `:${spec.port}`}`
          : `tcp://${spec.host}:${spec.port}`
        if (ctx.world.profiles.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw apiError('conflict', `Ya existe una conexión llamada «${name}».`)
        if (id !== undefined) {
          if (!ctx.world.profiles.some((x) => x.id === id)) throw apiError('not_found', 'La conexión ya no existe.')
          if (id === getActive()) throw apiError('conflict', 'La conexión activa no se puede editar: cambia a otra antes.')
        }
        const p: ConnectionProfile = {
          id: id ?? uuidv7(), name, target, kind: spec.kind, icon: 'server', remote: true, version: '', simulated: true,
          host_key_fp: spec.kind === 'ssh' ? trustedHosts.get(hostKey(spec)) ?? null : null,
          spec: structuredClone(spec),
        }
        const at = ctx.world.profiles.findIndex((x) => x.id === p.id)
        if (at >= 0) ctx.world.profiles[at] = p
        else ctx.world.profiles.push(p)
        return { ...p }
      },
      async remove(id, confirmed) {
        if (!confirmed) throw apiError('policy_denied', 'Falta la confirmación para eliminar la conexión.')
        if (id === 'local') throw apiError('policy_denied', 'La conexión local no se puede eliminar.')
        if (id === getActive()) throw apiError('conflict', 'No puedes eliminar la conexión activa: cambia a otra antes.')
        const i = ctx.world.profiles.findIndex((p) => p.id === id)
        if (i < 0) throw apiError('not_found', 'La conexión ya no existe.')
        ctx.world.profiles.splice(i, 1)
        groups.assignments = groups.assignments.filter((a) => a.connection_id !== id) // FK CASCADE
        save()
      },
    },
    registries: {
      async list() { return registries.map((r) => ({ ...r })) },
      async save({ server, username, secret }) {
        const srv = server.trim().toLowerCase()
        if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/.test(srv)) throw apiError('invalid_input', 'El servidor del registro no es válido (ej. ghcr.io).')
        if (!username.trim() || username.length > 256) throw apiError('invalid_input', 'El usuario es obligatorio (máx. 256).')
        if (!secret || secret.length > 4096) throw apiError('invalid_input', 'La contraseña o token es obligatoria (máx. 4096).')
        await sleep(Math.min(ctx.latency, 200))
        // El secreto NO se conserva: en el backend real va al llavero del sistema y jamás vuelve a salir.
        const existing = registries.find((r) => r.server === srv)
        if (existing) { existing.username = username.trim(); return { ...existing } }
        const r: RegistrySummary = { id: uuidv7(), server: srv, username: username.trim() }
        registries.push(r)
        return { ...r }
      },
      async remove(id, confirmed) {
        if (!confirmed) throw apiError('policy_denied', 'Falta la confirmación para eliminar el registro.')
        const i = registries.findIndex((r) => r.id === id)
        if (i < 0) throw apiError('not_found', 'El registro ya no existe.')
        registries.splice(i, 1)
      },
      async test(id) {
        const r = registries.find((x) => x.id === id)
        if (!r) throw apiError('not_found', 'El registro ya no existe.')
        await sleep(Math.min(ctx.latency + 300, 900))
        if (/bad|wrong|invalid/i.test(r.username)) return { ok: false, error: { code: 'auth_required', message: 'unauthorized: incorrect username or password' } }
        if (/offline|unreach/i.test(r.server)) return { ok: false, error: { code: 'registry_unreachable', message: 'dial tcp: connection refused' } }
        return { ok: true }
      },
    },
    groups: {
      async load() { return snap() },
      async mutate(op) {
        const backup = snap()
        try { applyOp(op) } catch (e) { groups = backup; throw e }
        save()
        return snap()
      },
      async importFile() {
        // El navegador no puede abrir un archivo elegido con diálogo nativo: la importación es de la app de escritorio.
        throw apiError('not_implemented', 'Importar grupos requiere la app de escritorio.')
      },
      async exportGroups() {
        // Navegador: la descarga la hace el propio navegador (no hay diálogo nativo).
        const s = snap()
        const doc = { format: 'dockinng-groups', version: 1, groups: s.groups, assignments: s.assignments, stack_hues: s.stack_hues }
        const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }))
        const a = document.createElement('a')
        a.href = url
        a.download = 'dockinng-grupos.json'
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 0)
        return 'dockinng-grupos.json'
      },
      async importLegacy(payload) {
        if (groups.legacy_imported) return { already_imported: true, imported_groups: 0, imported_assignments: 0, dropped_assignments: 0, snapshot: snap() }
        const clean = sanitizeGroups(payload)
        const idMap = new Map<string, string>()
        const out = structuredClone(groups)
        for (const g of clean.groups) {
          const id = isUuidV7(g.id) && !out.groups.some((x) => x.id === g.id) ? g.id : uuidv7()
          idMap.set(g.id, id)
          out.groups.push({ ...g, id })
        }
        let discarded = 0
        for (const [k, gid] of Object.entries(clean.assign)) {
          const [conn, ...rest] = k.split(SEP)
          const name = rest.join(SEP)
          const newId = idMap.get(gid)
          if (!newId || !name || !connKnown(conn)) { discarded++; continue }
          out.assignments.push({ connection_id: conn, container_name: name, group_id: newId })
        }
        out.stack_hues = { ...out.stack_hues, ...clean.stackHue }
        out.legacy_imported = true
        groups = out
        save()
        return { already_imported: false, imported_groups: clean.groups.length, imported_assignments: Object.keys(clean.assign).length - discarded, dropped_assignments: discarded, snapshot: snap() }
      },
    },
    prefs: {
      async get(key) {
        if (!PREF_KEYS.includes(key)) throw apiError('invalid_input', 'Preferencia no permitida.')
        return prefs.has(key) ? prefs.get(key) : null
      },
      async set(key, value) {
        if (!PREF_KEYS.includes(key)) throw apiError('invalid_input', 'Preferencia no permitida.')
        if (!validPref(key, value)) throw apiError('invalid_input', `Valor no válido para la preferencia ${key}.`)
        prefs.set(key, value)
      },
    },
  }
  return { api, controls: { trustedHosts } }
}
