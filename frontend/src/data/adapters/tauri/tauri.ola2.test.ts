// Contrato IPC de la Ola 2 (20 comandos nuevos) con `invoke` y `Channel` simulados: nombre de comando, argumentos camelCase EXACTOS,
// parseo de las fixtures serde y reglas de seguridad (el secreto solo viaja en registry_save; connection_select no cambia `activeId` si falla).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = []
let handler: (cmd: string, args?: Record<string, unknown>) => unknown = () => undefined

vi.mock('@tauri-apps/api/core', () => {
  class Channel<T> { onmessage: (m: T) => void = () => {} }
  return {
    Channel,
    isTauri: () => true,
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args })
      const r = handler(cmd, args)
      if (r && typeof r === 'object' && 'reject' in r) throw (r as { reject: unknown }).reject
      return r
    },
  }
})

import { createTauriApi } from '.'
import { Replay, REPLAY_MAX_BYTES } from './exec'
import * as F from './contract.fixtures'
import type { ActionRequest, GroupOp } from '../../types'

const flush = () => new Promise((r) => setTimeout(r, 5))
beforeEach(() => { calls.length = 0; handler = () => undefined })

describe('IPC Ola 2: grupos y preferencias', () => {
  it('groups_load / groups_mutate / groups_import_legacy / prefs_get / prefs_set con los argumentos exactos', async () => {
    const api = createTauriApi()
    handler = (cmd) => (cmd === 'groups_load' || cmd === 'groups_mutate' ? F.groupsSnapshot : cmd === 'groups_import_legacy' ? F.importReport : cmd === 'prefs_get' ? true : undefined)
    expect((await api.groups.load()).groups[0].name).toBe('Trabajo')
    const op: GroupOp = { type: 'assign', connection_id: 'local', names: ['a'], group_id: null }
    const create: GroupOp = { type: 'create_group', name: 'G', hue: null }
    expect((await api.groups.mutate(op)).stack_hues).toEqual({ tienda: 140 })
    expect(await api.groups.importLegacy({ v: 1, groups: [], assign: {}, stackHue: {} })).toMatchObject({ already_imported: false })
    await api.groups.mutate(create)
    expect(await api.prefs.get('polling')).toBe(true)
    await api.prefs.set('last_connection_id', 'local')
    expect(calls).toEqual([
      { cmd: 'groups_load', args: undefined },
      { cmd: 'groups_mutate', args: { op } },
      { cmd: 'groups_import_legacy', args: { payload: { v: 1, groups: [], assign: {}, stackHue: {} } } },
      { cmd: 'groups_mutate', args: { op: create } },
      { cmd: 'prefs_get', args: { key: 'polling' } },
      { cmd: 'prefs_set', args: { key: 'last_connection_id', value: 'local' } },
    ])
  })
  it('un snapshot con forma inesperada no rompe la UI (se normaliza a vacío)', async () => {
    const api = createTauriApi()
    handler = () => ({ legacy_imported: 1 })
    expect(await api.groups.load()).toEqual({ groups: [], assignments: [], stack_hues: {}, legacy_imported: true })
  })
})

describe('IPC Ola 2: conexiones', () => {
  it('comandos y argumentos exactos', async () => {
    const api = createTauriApi()
    handler = (cmd) => ({ connection_probe_host_key: F.probeUnknown, connection_trust_host_key: { ...F.probeUnknown, state: 'trusted' }, connection_test: F.testOk, connection_save: F.profileSshRaw, connection_status: F.statusConnected, connection_select: F.statusConnected } as Record<string, unknown>)[cmd]
    expect((await api.connections.probeHostKey(F.sshSpec)).state).toBe('unknown')
    expect((await api.connections.trustHostKey(F.sshSpec, F.probeUnknown.fingerprint_sha256)).state).toBe('trusted')
    expect((await api.connections.test(F.tlsSpec)).ok).toBe(true)
    expect(await api.connections.save(F.sshSpecFile)).toEqual(F.profileSsh) // spec aplanado -> perfil completo con destino legible
    await api.connections.remove('id-1', true)
    await api.connections.select('id-1')
    expect(calls.map((c) => c.cmd)).toEqual(['connection_probe_host_key', 'connection_trust_host_key', 'connection_test', 'connection_save', 'connection_delete', 'connection_select'])
    expect(calls[1].args).toEqual({ spec: F.sshSpec, fingerprint: F.probeUnknown.fingerprint_sha256 })
    expect(calls[4].args).toEqual({ id: 'id-1', confirmed: true })
    expect(calls[5].args).toEqual({ id: 'id-1' })
  })
  it('el spec SSH/TLS viaja con la forma serde (puerto numérico, identidad etiquetada, solo rutas)', () => {
    expect(JSON.parse(JSON.stringify(F.sshSpec))).toEqual({ kind: 'ssh', name: 'prod', host: '203.0.113.10', port: 22, user: 'deploy', mode: 'explicit', identity: { type: 'agent' } })
    expect(Object.keys(F.tlsSpec).sort()).toEqual(['ca_path', 'cert_path', 'host', 'key_path', 'kind', 'name', 'port'])
  })
  it('connection_select fallido NO cambia la conexión activa; uno correcto sí', async () => {
    const api = createTauriApi()
    handler = () => ({ reject: { code: 'connection', message: 'Host key verification failed', cause: 'host_key_changed' } })
    await expect(api.connections.select('x')).rejects.toMatchObject({ code: 'connection', cause: 'host_key_changed' })
    expect(api.connection.activeId()).toBe('local')
    handler = () => F.statusConnected
    await api.connections.select('01935f00-0000-7000-8000-0000000000aa')
    expect(api.connection.activeId()).toBe('01935f00-0000-7000-8000-0000000000aa')
  })
  it('connection_list sin «local» lo sintetiza primero; un fallo IPC llega como ApiError', async () => {
    const api = createTauriApi()
    handler = () => [F.profileSshRaw, F.profileTlsRaw]
    const list = await api.connections.list()
    expect(list.map((p) => p.id)).toEqual(['local', F.profileSshRaw.id, F.profileTlsRaw.id])
    expect(list.map((p) => p.target)).toEqual(['unix:///var/run/docker.sock', 'ssh://deploy@203.0.113.10', 'tcp://10.0.0.5:2376'])
    expect(list.slice(1).every((p) => p.remote && !p.simulated)).toBe(true)
    handler = () => ({ reject: 'boom' })
    await expect(api.connections.list()).rejects.toEqual({ code: 'internal', message: 'boom' })
  })
})

describe('IPC Ola 2: perfil local frente a conexión remota activa', () => {
  it('al activar una conexión remota, «Local» conserva su destino y versión y la remota recibe la versión del motor activo', async () => {
    const api = createTauriApi()
    const local = { ...F.statusConnected }
    const remote = { state: 'connected', endpoint: 'ssh://deploy@203.0.113.10', server: { version: '26.1.4', api_version: '1.45', os: 'linux', arch: 'x86_64' } } as const
    handler = (cmd) => (cmd === 'connection_status' ? local : cmd === 'connection_select' ? remote : cmd === 'connection_list' ? [F.profileSshRaw] : undefined)
    await api.connection.status()
    await api.connections.select(F.profileSshRaw.id)
    const list = await api.connections.list()
    expect(list[0]).toMatchObject({ id: 'local', target: 'unix:///var/run/docker.sock', version: 'Docker 27.3.1 · API 1.47' })
    expect(list[1]).toMatchObject({ id: F.profileSshRaw.id, version: 'Docker 26.1.4 · API 1.45' })
  })
})

describe('IPC Ola 2: registries', () => {
  it('el secreto viaja SOLO en registry_save; list/test/delete no lo llevan ni lo devuelven', async () => {
    const api = createTauriApi()
    handler = (cmd) => (cmd === 'registry_list' ? [F.registry] : cmd === 'registry_save' ? F.registry : undefined)
    const saved = await api.registries.save({ server: 'ghcr.io', username: 'casaluna', secret: 'S3CRET' })
    expect(JSON.stringify(saved)).not.toContain('S3CRET')
    expect(await api.registries.list()).toEqual([F.registry])
    expect(await api.registries.test(F.registry.id)).toEqual({ ok: true }) // el comando devuelve ()
    await api.registries.remove(F.registry.id, true)
    expect(calls[0]).toEqual({ cmd: 'registry_save', args: { server: 'ghcr.io', username: 'casaluna', secret: 'S3CRET' } })
    expect(calls.slice(1).map((c) => c.cmd)).toEqual(['registry_list', 'registry_test', 'registry_delete'])
    for (const c of calls.slice(1)) expect(JSON.stringify(c.args ?? {})).not.toContain('S3CRET')
    expect(calls[3].args).toEqual({ id: F.registry.id, confirmed: true })
  })
})

describe('IPC Ola 2: registry_test', () => {
  it('un ApiError del comando (credenciales rechazadas) NO lanza: llega como resultado {ok:false,error}', async () => {
    const api = createTauriApi()
    handler = () => ({ reject: { code: 'auth_required', message: 'unauthorized' } })
    expect(await api.registries.test('id')).toEqual({ ok: false, error: { code: 'auth_required', message: 'unauthorized' } })
  })
})

describe('IPC Ola 2: build, limpieza y Podman', () => {
  it('build_plan / cleanup_report / podman_detect con los argumentos exactos', async () => {
    const api = createTauriApi()
    handler = (cmd) => ({ build_plan: F.buildPlanSensitive, cleanup_report: F.cleanupReport, podman_detect: F.podman } as Record<string, unknown>)[cmd]
    expect((await api.images.planBuild(F.buildSpec)).ticket).toMatch(/^[0-9a-f-]{36}$/)
    expect((await api.system.cleanupReport({ minAgeDays: 30 })).categories).toHaveLength(3)
    expect((await api.system.podmanDetect())[0].rootless).toBe(true)
    expect(calls).toEqual([
      { cmd: 'build_plan', args: { spec: F.buildSpec } },
      { cmd: 'cleanup_report', args: { minAgeDays: 30 } },
      { cmd: 'podman_detect', args: undefined },
    ])
  })
  it('subscribe_build: Channel con los feeds, ticket en los args y cancelación por unsubscribe', async () => {
    const api = createTauriApi()
    handler = (cmd) => (cmd === 'subscribe_build' ? 'sub-b' : undefined)
    const got: unknown[] = []
    const off = api.images.build(F.buildSpec, 'tk-1', (f) => got.push(f))
    const sub = calls.find((c) => c.cmd === 'subscribe_build')!
    expect(sub.args).toMatchObject({ spec: F.buildSpec, ticket: 'tk-1' })
    const ch = sub.args!.onEvent as { onmessage: (m: unknown) => void }
    for (const f of F.buildFeeds) ch.onmessage(f)
    expect(got).toEqual(F.buildFeeds)
    await flush()
    off()
    await flush()
    expect(calls.some((c) => c.cmd === 'unsubscribe' && (c.args as { subscriptionId: string }).subscriptionId === 'sub-b')).toBe(true)
  })
  it('un fallo al abrir subscribe_build llega como ended:failed (nunca se queda colgado)', async () => {
    const api = createTauriApi()
    handler = () => ({ reject: { code: 'policy_denied', message: 'contexto sensible sin ticket' } })
    const got: unknown[] = []
    api.images.build(F.buildSpec, null, (f) => got.push(f))
    await flush()
    expect(got).toEqual([{ type: 'ended', outcome: 'failed', image_id: null, error: { code: 'policy_denied', message: 'contexto sensible sin ticket' } }])
  })
  it('ActionRequest cleanup viaja tal cual en plan_action', async () => {
    const api = createTauriApi()
    handler = () => F.planConfirm
    const req: ActionRequest = { type: 'cleanup', selection: { containers: ['c1'], images: [], volumes: ['v1'], networks: [] } }
    await api.actions.plan(req)
    expect(calls[0]).toEqual({ cmd: 'plan_action', args: { request: req } })
  })
})

describe('exec: el búfer de reproducción tiene tope', () => {
  it('descarta lo más antiguo al superar el tope de bytes y conserva siempre lo último', () => {
    const r = new Replay<Uint8Array>(100, (b) => b.length)
    for (let i = 0; i < 50; i++) r.emit(new Uint8Array(30).fill(i))
    const got: number[] = []
    r.on((b) => got.push(b[0]))
    expect(got.length).toBeLessThanOrEqual(4) // 100 / 30
    expect(got[got.length - 1]).toBe(49)
  })
  it('un único bloque mayor que el tope se conserva (no se pierde el último dato)', () => {
    const r = new Replay<Uint8Array>(10, (b) => b.length)
    r.emit(new Uint8Array(500))
    const got: number[] = []
    r.on((b) => got.push(b.length))
    expect(got).toEqual([500])
  })
  it('con suscriptor no se retiene nada y el tope por defecto es 2 MiB', () => {
    const r = new Replay<number>()
    const seen: number[] = []
    r.on((v) => seen.push(v))
    r.emit(1)
    expect(seen).toEqual([1])
    expect(REPLAY_MAX_BYTES).toBe(2 * 1024 * 1024)
  })
})
