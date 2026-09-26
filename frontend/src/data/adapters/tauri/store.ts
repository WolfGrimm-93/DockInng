// Comandos IPC de la Ola 2 que no son streams: grupos/preferencias (`groups_*`, `prefs_*`), registries (`registry_*`) y el listado de
// conexiones (`connection_list`). Los tipos siguen la forma serde (snake_case) descrita en DISEÑO Ola 2 §G; los campos que el backend
// pudiera omitir se normalizan aquí para que la UI reciba siempre un perfil completo.
import { invoke } from '@tauri-apps/api/core'
import type { EngineApi } from '../../api'
import { toApiError } from '../../errors'
import type { ConnectionProfile, GroupsSnapshot, RegistrySummary } from '../../types'

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (e) {
    throw toApiError(e)
  }
}

/** Forma serde de `connection_list`/`connection_save` (engine-core `ConnectionProfile` con el spec aplanado): SIN target/icono/versión. */
export type RawProfile = Partial<ConnectionProfile> & { id: string; name: string; kind: ConnectionProfile['kind'] } & {
  host?: string; port?: number; user?: string; mode?: 'explicit' | 'alias'
}

/** Destino legible a partir del spec aplanado (`ssh://user@host:port`, alias sin usuario, `tcp://host:port`). */
export function targetOf(raw: RawProfile): string {
  if (raw.target) return raw.target
  if (raw.kind === 'local') return 'unix:///var/run/docker.sock'
  const host = raw.host ?? ''
  if (raw.kind === 'tls') return `tcp://${host}${raw.port ? `:${raw.port}` : ''}`
  const user = raw.mode !== 'alias' && raw.user ? `${raw.user}@` : ''
  return `ssh://${user}${host}${raw.port && raw.port !== 22 ? `:${raw.port}` : ''}`
}

/** Rellena lo que el backend no calcula (icono, versión, destino legible) y fuerza `simulated:false`. */
export function normalizeProfile(raw: RawProfile): ConnectionProfile {
  const remote = raw.remote ?? raw.kind !== 'local'
  return {
    id: raw.id,
    name: raw.name,
    kind: raw.kind,
    target: targetOf(raw),
    icon: remote ? 'server' : 'monitor',
    remote,
    version: raw.version ?? '',
    simulated: false,
    host_key_fp: raw.host_key_fp ?? null,
  }
}

const LOCAL: ConnectionProfile = normalizeProfile({ id: 'local', name: 'Local', kind: 'local' })

/** Defensa: el snapshot llega de Rust, pero una forma inesperada no debe tumbar la UI. */
function safeSnapshot(s: GroupsSnapshot): GroupsSnapshot {
  return {
    groups: Array.isArray(s?.groups) ? s.groups : [],
    assignments: Array.isArray(s?.assignments) ? s.assignments : [],
    stack_hues: s?.stack_hues && typeof s.stack_hues === 'object' ? s.stack_hues : {},
    legacy_imported: Boolean(s?.legacy_imported),
  }
}

export function createTauriStore(): {
  listProfiles(): Promise<ConnectionProfile[]>
  registries: EngineApi['registries']
  groups: EngineApi['groups']
  prefs: EngineApi['prefs']
} {
  return {
    async listProfiles() {
      const rows = await call<RawProfile[]>('connection_list')
      const list = (Array.isArray(rows) ? rows : []).map(normalizeProfile)
      // «Local» siempre primero (si el backend no lo lista, se sintetiza).
      const local = list.find((p) => p.id === 'local') ?? LOCAL
      return [local, ...list.filter((p) => p.id !== 'local')]
    },
    registries: {
      list: () => call<RegistrySummary[]>('registry_list'),
      // El secreto viaja SOLO en esta llamada. Nunca se registra ni se devuelve.
      save: ({ server, username, secret }) => call<RegistrySummary>('registry_save', { server, username, secret }),
      remove: (id, confirmed) => call<void>('registry_delete', { id, confirmed }),
      // El comando devuelve `()` si las credenciales valen o un ApiError (auth_required, registry_unreachable…): se convierte en resultado.
      async test(id) {
        try { await call<void>('registry_test', { id }); return { ok: true } } catch (e) { return { ok: false, error: toApiError(e) } }
      },
    },
    groups: {
      load: async () => safeSnapshot(await call<GroupsSnapshot>('groups_load')),
      mutate: async (op) => safeSnapshot(await call<GroupsSnapshot>('groups_mutate', { op })),
      importLegacy: (payload) => call('groups_import_legacy', { payload }),
    },
    prefs: {
      get: (key) => call<unknown>('prefs_get', { key }),
      set: (key, value) => call<void>('prefs_set', { key, value }),
    },
  }
}
