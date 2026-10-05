// Contrato IPC contra los fixtures de Rust (`contract.generated.ts`): cada llamada que hace el adaptador Tauri usa un comando
// que existe en el backend y EXACTAMENTE sus argumentos (camelCase), y los errores serializados por Rust llegan intactos a la UI.
// `invoke` y `Channel` se simulan; las respuestas son los resultados reales serializados por Rust (`COMMANDS[cmd].result`).
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Call = { cmd: string; args: Record<string, unknown> | undefined }
const calls: Call[] = []
let failWith: unknown = undefined

vi.mock('@tauri-apps/api/core', async () => {
  const { COMMANDS } = await import('./contract.generated')
  class Channel<T> {
    onmessage: (m: T) => void = () => {}
  }
  return {
    Channel,
    isTauri: () => true,
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args })
      if (!(cmd in COMMANDS)) throw new Error(`comando IPC sin fixture de Rust: ${cmd}`)
      if (failWith !== undefined) throw failWith
      return COMMANDS[cmd as keyof typeof COMMANDS].result
    },
  }
})

import { API_ERROR_QUIESCED, API_ERRORS_BY_CAUSE, API_ERRORS_BY_CODE, COMMANDS } from './contract.generated'
import { createTauriApi } from '.'
import { toApiError } from '../../errors'

/** Argumentos que Rust declara `Option` y el adaptador omite a propósito (Tauri los trata como None). */
const OMITTABLE: Record<string, string[]> = { connection_save: ['id'], compose_info: ['recheck'] }

function assertCallMatchesRust(c: Call) {
  expect(c.cmd in COMMANDS, `comando ${c.cmd} sin fixture`).toBe(true)
  const expected = Object.keys(COMMANDS[c.cmd as keyof typeof COMMANDS].args).sort()
  const sent = Object.keys(c.args ?? {}).sort()
  const missing = expected.filter((k) => !sent.includes(k) && !(OMITTABLE[c.cmd] ?? []).includes(k))
  const extra = sent.filter((k) => !expected.includes(k))
  expect({ cmd: c.cmd, missing, extra }).toEqual({ cmd: c.cmd, missing: [], extra: [] })
}

beforeEach(() => {
  calls.length = 0
  failWith = undefined
})

const spec = {} as never // los valores no importan aquí: se comprueba el NOMBRE de comando y las CLAVES de argumentos

describe('contrato IPC: comandos y argumentos del adaptador frente a Rust', () => {
  it('cada llamada del adaptador usa un comando de Rust con sus argumentos exactos', async () => {
    const api = createTauriApi()
    await api.connection.status()
    await api.connection.reconnect()
    await api.connections.list()
    await api.connections.select('0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d')
    await api.connections.save(spec, '0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d')
    await api.connections.save(spec)
    await api.connections.remove('id', true)
    await api.connections.test(spec)
    await api.connections.probeHostKey(spec)
    await api.connections.trustHostKey(spec, 'SHA256:x')
    await api.actions.plan({ type: 'prune_images' })
    await api.actions.execute('tk', 'typed')
    await api.actions.execute('tk')
    await api.actions.cancel('tk')
    await api.containers.list(true)
    await api.containers.inspect('x')
    await api.containers.start('x')
    await api.containers.stop('x')
    await api.containers.restart('x')
    await api.containers.statsSnapshot(['x'])
    await api.containers.openPort('x', 80, 'http')
    await api.containers.planCreate(spec)
    await api.containers.create(spec, true, null)
    api.containers.streamLogs('x', { tail: 10, follow: false }, () => {})
    api.containers.streamStats('x', () => {})
    await api.system.usage()
    await api.system.gpu()
    await api.system.cleanupReport({ minAgeDays: 30 })
    await api.system.podmanDetect()
    await api.images.list()
    await api.images.planBuild(spec)
    api.images.build(spec, null, () => {})
    api.images.pull('nginx', () => {})
    await api.volumes.list()
    await api.volumes.create(spec)
    await api.networks.list()
    await api.networks.create(spec)
    api.events.subscribe(() => {})
    const term = await api.exec.open('x', { cols: 80, rows: 24 })
    term.write('ls\n')
    term.resize(100, 30)
    await vi.waitFor(() => expect(calls.some((c) => c.cmd === 'exec_write')).toBe(true))
    term.close()
    await api.stacks.composeInfo()
    await api.stacks.composeInfo(true)
    await api.stacks.list()
    api.stacks.runOp('n', { type: 'up' }, () => {}).cancel()
    await api.stacks.read('n')
    await api.stacks.save('n', { yaml: '', env: '', expectedRevision: null })
    await api.stacks.validate(null, '', '')
    await api.stacks.create('n', '', '')
    await api.stacks.link('/ruta')
    await api.stacks.unlink('n')
    await api.registries.list()
    await api.registries.save({ server: 's', username: 'u', secret: 'k' })
    await api.registries.remove('id', true)
    await api.registries.test('id')
    await api.groups.load()
    await api.groups.mutate(spec)
    await api.groups.importLegacy(spec)
    await api.prefs.get('tema' as never)
    await api.prefs.set('tema' as never, 'oscuro')
    await api.window.trayStatus()
    await api.window.busySummary()
    await api.window.notifyUser(spec)
    await api.window.quitApp(true)
    await api.window.setDecorations(true)
    await api.window.minimize()
    await api.window.toggleMaximize()
    await api.window.close()
    await api.window.startDrag()
    await api.window.startResize('north' as never)
    api.window.onQuitRequested(() => {})

    // Críticos (confirmación, destrucción, streams, terminal y errores) deben haberse ejercitado realmente.
    const used = new Set(calls.map((c) => c.cmd))
    for (const cmd of ['plan_action', 'execute_action', 'cancel_action', 'connection_delete', 'connection_select', 'connection_save',
      'quit_app', 'stack_save', 'create_container', 'run_stack_op', 'cancel_stack_op', 'subscribe_logs', 'subscribe_stats',
      'subscribe_exec', 'exec_write', 'subscribe_build', 'subscribe_pull', 'subscribe_engine_events', 'subscribe_app_events',
      'open_port_in_browser', 'registry_save', 'registry_delete', 'groups_mutate', 'prefs_set', 'notify_user']) {
      expect(used.has(cmd), `no ejercitado: ${cmd}`).toBe(true)
    }
    for (const c of calls) assertCallMatchesRust(c)
  })

  it('los errores serializados por Rust (ApiError por código) llegan a la UI sin cambios', async () => {
    const api = createTauriApi()
    for (const [code, err] of Object.entries(API_ERRORS_BY_CODE)) {
      failWith = err
      await expect(api.containers.inspect('x'), code).rejects.toEqual(err)
      expect(toApiError(err).code).toBe(code)
    }
  })

  it('los errores por causa de conexión y el marcador quiesced conservan su forma', async () => {
    const api = createTauriApi()
    for (const [cause, err] of Object.entries(API_ERRORS_BY_CAUSE)) {
      expect(err.cause, cause).toBe(cause)
    }
    failWith = API_ERROR_QUIESCED
    await expect(api.connections.select('x')).rejects.toMatchObject({ code: 'conflict', quiesced: true })
  })
})
