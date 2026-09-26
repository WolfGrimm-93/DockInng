// Contrato IPC de la Ola 1 (stacks, exec, pull, crear, volumen/red) con `invoke` y `Channel` simulados.
// Comprueba nombre de comando, argumentos camelCase EXACTOS y el parseo de las fixtures con la forma serde del backend.
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
import { chunkText } from './exec'
import { createEngineStore } from '../../store/engineStore'
import * as F from './contract.fixtures'

const flush = () => new Promise((r) => setTimeout(r, 5))
const channelOf = (cmd: string) => (calls.find((c) => c.cmd === cmd)!.args!.onEvent as { onmessage: (m: unknown) => void })

beforeEach(() => {
  calls.length = 0
  handler = () => undefined
})

describe('IPC Ola 1: stacks', () => {
  it('comandos y argumentos exactos', async () => {
    const api = createTauriApi()
    handler = (cmd) => ({ compose_info: F.composeInfo, list_stacks: [F.stackSummary], stack_read: F.stackFiles, stack_save: F.stackFiles, stack_validate: F.validationBad, stack_create: F.stackDeclared, stack_link: F.stackSummary } as Record<string, unknown>)[cmd]
    expect((await api.stacks.composeInfo()).version).toBe('5.5.1')
    await api.stacks.composeInfo(true)
    expect((await api.stacks.list())[0].services[1].state).toBe('exited')
    expect((await api.stacks.read('s')).revision).toContain(':')
    await api.stacks.save('s', { yaml: 'y', env: 'e', expectedRevision: 'r1' })
    await api.stacks.save('s', { yaml: 'y', env: 'e', expectedRevision: null })
    const v = await api.stacks.validate('s', 'y', 'e')
    expect(v.issues[0]).toMatchObject({ line: 2, column: 3, kind: 'syntax' })
    expect(v.risks.map((r) => r.type)).toEqual(['privileged', 'sensitive_bind', 'docker_sock'])
    await api.stacks.validate(null, 'y', 'e')
    await api.stacks.create('n', 'y', 'e')
    await api.stacks.link('/srv/x/compose.yaml')
    await api.stacks.unlink('n')
    expect(calls).toEqual([
      { cmd: 'compose_info', args: undefined },
      { cmd: 'compose_info', args: { recheck: true } },
      { cmd: 'list_stacks', args: undefined },
      { cmd: 'stack_read', args: { name: 's' } },
      { cmd: 'stack_save', args: { name: 's', yaml: 'y', env: 'e', expectedRevision: 'r1' } },
      { cmd: 'stack_save', args: { name: 's', yaml: 'y', env: 'e', expectedRevision: null } },
      { cmd: 'stack_validate', args: { name: 's', yaml: 'y', env: 'e' } },
      { cmd: 'stack_validate', args: { name: null, yaml: 'y', env: 'e' } },
      { cmd: 'stack_create', args: { name: 'n', yaml: 'y', env: 'e' } },
      { cmd: 'stack_link', args: { path: '/srv/x/compose.yaml' } },
      { cmd: 'stack_unlink', args: { name: 'n' } },
    ])
  })

  it('run_stack_op: la operación viaja como {type,…}, los feeds llegan por Channel y cancel usa cancel_stack_op / unsubscribe', async () => {
    const api = createTauriApi()
    handler = (cmd) => (cmd === 'run_stack_op' ? 'op-1' : undefined)
    const got: unknown[] = []
    const h = api.stacks.runOp('proj', { type: 'up' }, (f) => got.push(f))
    expect(calls[0]).toMatchObject({ cmd: 'run_stack_op', args: { name: 'proj', op: { type: 'up' } } })
    const ch = channelOf('run_stack_op')
    for (const f of [F.opStarted, F.opProgress, F.opLog, F.opEndedFail]) ch.onmessage(f)
    expect(got.map((g) => (g as { type: string }).type)).toEqual(['started', 'progress', 'log', 'ended'])
    h.cancel()
    await flush()
    expect(calls.some((c) => c.cmd === 'cancel_stack_op' && (c.args as { subscriptionId: string }).subscriptionId === 'op-1')).toBe(true)
    h.dispose()
    await flush()
    expect(calls.some((c) => c.cmd === 'unsubscribe')).toBe(true)
  })

  it('run_stack_op rechazado (Compose ausente): se convierte en un `ended` fallido con el ApiError', async () => {
    const api = createTauriApi()
    handler = () => ({ reject: { code: 'compose_missing', message: 'docker compose no está instalado', cause: null } })
    const got: { type: string; error?: { code: string } }[] = []
    api.stacks.runOp('p', { type: 'up' }, (f) => got.push(f as never))
    await flush()
    expect(got[0]).toMatchObject({ type: 'ended', outcome: 'failed', error: { code: 'compose_missing' } })
  })

  it('errores del backend se normalizan a ApiError (state_changed al guardar, policy_denied al editar un descubierto)', async () => {
    const api = createTauriApi()
    handler = () => ({ reject: { code: 'state_changed', message: 'cambió', cause: null } })
    await expect(api.stacks.save('s', { yaml: '', env: '', expectedRevision: 'x' })).rejects.toMatchObject({ code: 'state_changed' })
    handler = () => ({ reject: 'texto plano' })
    await expect(api.stacks.read('s')).rejects.toMatchObject({ code: 'internal', message: 'texto plano' })
  })

  it('el store alimenta stacks, compose y el contador desde list_stacks / compose_info', async () => {
    handler = (cmd) => ({
      connection_status: F.statusConnected, list_containers: [F.container], list_images: [], list_volumes: [], list_networks: [],
      list_stacks: [F.stackSummary, F.stackDeclared], compose_info: F.composeInfo,
    } as Record<string, unknown>)[cmd]
    const store = createEngineStore(createTauriApi(), { statsIntervalMs: 0, storage: null })
    await store.getState().bootstrap()
    await flush()
    const s = store.getState()
    expect(s.stacks.ids).toEqual(['dockinng-test-recon', 'declarado'])
    expect(s.compose?.available).toBe(true)
    // El stack «declarado» sin contenedores también cuenta (antes se contaban solo los proyectos con contenedores).
    const { navCounts } = await import('../../store/selectors')
    expect(navCounts(s).stacks).toBe(2)
    store.getState().dispose()
  })
})

describe('IPC Ola 1: exec', () => {
  it('subscribe_exec / exec_write / exec_resize / exec_close con argumentos camelCase; el cierre es idempotente', async () => {
    const api = createTauriApi()
    handler = (cmd) => (cmd === 'subscribe_exec' ? 'ex-1' : undefined)
    const s = await api.exec.open('cid', { cols: 100, rows: 30 })
    expect(calls[0]).toMatchObject({ cmd: 'subscribe_exec', args: { id: 'cid', cols: 100, rows: 30 } })
    s.write('ls\r')
    s.resize(120, 40)
    await flush()
    s.close()
    s.close()
    await flush()
    expect(calls.slice(1).map((c) => [c.cmd, c.args])).toEqual([
      ['exec_write', { subscriptionId: 'ex-1', data: 'ls\r' }],
      ['exec_resize', { subscriptionId: 'ex-1', cols: 120, rows: 40 }],
      ['exec_close', { subscriptionId: 'ex-1' }],
    ])
    s.write('tras cerrar')
    await flush()
    expect(calls.filter((c) => c.cmd === 'exec_write')).toHaveLength(1)
  })

  it('la salida base64 llega como bytes crudos: un carácter UTF-8 partido entre chunks se reconstruye con TextDecoder en streaming', async () => {
    const api = createTauriApi()
    handler = (cmd) => (cmd === 'subscribe_exec' ? 'ex-2' : undefined)
    const s = await api.exec.open('cid', { cols: 80, rows: 24 })
    const ch = channelOf('subscribe_exec')
    // Llega ANTES de que nadie se suscriba: se reproduce al suscribir.
    ch.onmessage(F.execOpened)
    ch.onmessage(F.execChunkA)
    const chunks: Uint8Array[] = []
    const info: unknown[] = []
    const exits: unknown[] = []
    s.onOpen((i) => info.push(i))
    s.onOutput((c) => chunks.push(c))
    s.onExit((e) => exits.push(e))
    ch.onmessage(F.execChunkB)
    ch.onmessage(F.execChunkC)
    ch.onmessage(F.execEnded)
    expect(chunks.every((c) => c instanceof Uint8Array)).toBe(true)
    const dec = new TextDecoder()
    expect(chunks.map((c) => dec.decode(c, { stream: true })).join('')).toBe('héllo €')
    expect(info[0]).toMatchObject({ shell: '/bin/sh', risk: { docker_socket: true } })
    expect(exits[0]).toEqual({ reason: 'process_exited', exit_code: 7, error: null })
  })

  const bytes = (t: string) => new TextEncoder().encode(t).length
  it('pegados grandes: se trocean por BYTES UTF-8 (≤16384) sin partir caracteres y se envían en orden, una invoke a la vez', async () => {
    const cases: [string, string][] = [
      ['200 KiB ASCII', 'a'.repeat(200 * 1024)],
      ['100 KiB de CJK (3 bytes/car.)', '漢字仮名'.repeat(25 * 1024)],
      ['>1 MiB con emoji y acentos', 'é😀x'.repeat(200_000)],
    ]
    for (const [name, big] of cases) {
      calls.length = 0
      const api = createTauriApi()
      let inFlight = 0
      let peak = 0
      handler = (cmd) => {
        if (cmd === 'subscribe_exec') return 'ex-3'
        if (cmd === 'exec_write') { inFlight++; peak = Math.max(peak, inFlight); return new Promise((r) => setTimeout(() => { inFlight--; r(undefined) }, 0)) as never }
        return undefined
      }
      const s = await api.exec.open('cid', { cols: 80, rows: 24 })
      const t0 = Date.now()
      s.write(big)
      s.write('fin')
      await new Promise<void>((res) => { const iv = setInterval(() => { if (calls.filter((c) => c.cmd === 'exec_write').map((c) => (c.args as { data: string }).data).join('').endsWith('fin')) { clearInterval(iv); res() } }, 5) })
      const writes = calls.filter((c) => c.cmd === 'exec_write').map((c) => (c.args as { data: string }).data)
      expect(peak, name).toBe(1)
      expect(writes.join(''), name).toBe(big + 'fin')
      for (const w of writes) {
        expect(bytes(w), name).toBeLessThanOrEqual(16384)
        expect(/[\ud800-\udbff]$/.test(w) && !/[\udc00-\udfff]/.test(w.slice(-1)), name).toBe(false)
      }
      expect(Date.now() - t0, name).toBeLessThan(5000)
      s.close()
    }
    expect(chunkText('a'.repeat(5), 2)).toEqual(['aa', 'aa', 'a'])
    expect(chunkText('é'.repeat(3), 3)).toEqual(['é', 'é', 'é'])
    expect(chunkText('😀😀', 5)).toEqual(['😀', '😀'])
    expect(chunkText('')).toEqual([])
  })

  it('un error de exec_write DETIENE la entrada, vacía lo pendiente y avisa; «terminal saturada» se reintenta con espera', async () => {
    const errSpy = vi.spyOn((await import('@/lib/toastStore')).toast, 'err')
    const api = createTauriApi()
    let n = 0
    handler = (cmd) => {
      if (cmd === 'subscribe_exec') return 'ex-4'
      if (cmd === 'exec_write') { n++; if (n === 1) return { reject: { code: 'conflict', message: 'terminal saturada', cause: null } }; if (n === 3) return { reject: { code: 'invalid_input', message: 'demasiado grande', cause: null } } }
      return undefined
    }
    const s = await api.exec.open('cid', { cols: 80, rows: 24 })
    s.write('a'.repeat(40000)) // 3 trozos: el 1.º se reintenta (conflict), el 2.º falla con invalid_input y se corta
    await new Promise((r) => setTimeout(r, 300))
    const writes = calls.filter((c) => c.cmd === 'exec_write')
    expect(writes).toHaveLength(3) // 1.º + reintento + 2.º (error); el 3.º NUNCA se envía
    expect(errSpy).toHaveBeenCalledWith('Se perdió parte de lo escrito en la terminal', expect.anything())
    s.write('otra')
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.filter((c) => c.cmd === 'exec_write').length).toBe(4) // la sesión sigue viva para escrituras nuevas
  })

  it('subscribe_exec rechazado (contenedor detenido): open lanza el ApiError', async () => {
    const api = createTauriApi()
    handler = () => ({ reject: { code: 'conflict', message: 'el contenedor no está en ejecución', cause: null } })
    await expect(api.exec.open('cid', { cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'conflict' })
  })
})

describe('IPC Ola 1: pull, crear, volumen y red', () => {
  it('subscribe_pull: feed tipado por `type`; cancelar = unsubscribe (también si el id llega tarde)', async () => {
    const api = createTauriApi()
    handler = (cmd) => (cmd === 'subscribe_pull' ? 'pl-1' : undefined)
    const got: { type: string }[] = []
    const off = api.images.pull('localhost:54109/dockinng-test/layers:1', (f) => got.push(f))
    expect(calls[0]).toMatchObject({ cmd: 'subscribe_pull', args: { reference: 'localhost:54109/dockinng-test/layers:1' } })
    const ch = channelOf('subscribe_pull')
    for (const f of [F.pullStarted, F.pullProgress, F.pullEnded]) ch.onmessage(f)
    expect(got.map((g) => g.type)).toEqual(['started', 'progress', 'ended'])
    off()
    await flush()
    expect(calls.some((c) => c.cmd === 'unsubscribe' && (c.args as { subscriptionId: string }).subscriptionId === 'pl-1')).toBe(true)
  })

  it('el store convierte el feed del pull en PullOp (capas en bytes, hecho/error) y cancelar lo marca localmente', async () => {
    handler = (cmd) => ({ connection_status: F.statusConnected, list_containers: [], list_images: [], list_volumes: [], list_networks: [], subscribe_pull: 'pl-2' } as Record<string, unknown>)[cmd]
    const store = createEngineStore(createTauriApi(), { statsIntervalMs: 0, storage: null })
    await store.getState().bootstrap()
    store.getState().startPull('x:1')
    await flush()
    const ch = channelOf('subscribe_pull')
    ch.onmessage(F.pullProgress)
    expect(store.getState().pulls['x:1']).toMatchObject({ state: 'pulling', doneBytes: 3145728, totalBytes: 10005636 })
    expect(store.getState().pulls['x:1'].layers[2].phase).toBe('complete')
    ch.onmessage(F.pullEndedErr)
    expect(store.getState().pulls['x:1']).toMatchObject({ state: 'error', error: { code: 'registry_unreachable' } })
    store.getState().startPull('y:1')
    await flush()
    store.getState().cancelPull('y:1')
    expect(store.getState().pulls['y:1'].state).toBe('canceled')
    store.getState().dispose()
  })

  it('plan_create_container / create_container / create_volume / create_network', async () => {
    const api = createTauriApi()
    handler = (cmd) => ({ plan_create_container: F.createPlanConfirm, create_container: F.createResult, create_volume: F.volume, create_network: F.network } as Record<string, unknown>)[cmd]
    const plan = await api.containers.planCreate(F.createSpec)
    expect(plan.decision).toEqual({ type: 'confirm' })
    expect(plan.warnings.map((w) => w.type)).toEqual(['sensitive_bind', 'docker_socket', 'host_network', 'port_in_use', 'published_all_interfaces'])
    const res = await api.containers.create(F.createSpec, true, plan.ticket)
    expect(res.start_error?.code).toBe('conflict')
    await api.containers.create(F.createSpec, false, null)
    await api.volumes.create({ name: 'datos-nuevos', labels: { a: 'b' } })
    await api.networks.create({ name: 'red-nueva', internal: true, subnet: '10.9.0.0/24', gateway: null, labels: {} })
    expect(calls).toEqual([
      { cmd: 'plan_create_container', args: { spec: F.createSpec } },
      { cmd: 'create_container', args: { spec: F.createSpec, start: true, ticket: '01935f00-0000-7000-8000-000000000003' } },
      { cmd: 'create_container', args: { spec: F.createSpec, start: false, ticket: null } },
      { cmd: 'create_volume', args: { spec: { name: 'datos-nuevos', labels: { a: 'b' } } } },
      { cmd: 'create_network', args: { spec: { name: 'red-nueva', internal: true, subnet: '10.9.0.0/24', gateway: null, labels: {} } } },
    ])
    expect(F.createPlanBad.field_errors[0].field).toBe('volumes[0].source')
  })

  it('image_missing y los códigos nuevos llegan como ApiError tipado', async () => {
    const api = createTauriApi()
    handler = () => ({ reject: { code: 'image_missing', message: 'No such image: x', cause: null } })
    await expect(api.containers.create(F.createSpec, true, null)).rejects.toMatchObject({ code: 'image_missing' })
  })
})
