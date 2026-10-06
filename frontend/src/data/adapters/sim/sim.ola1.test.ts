// Adaptador simulado, áreas de la Ola 1: stacks, exec, pull, crear, volumen/red (mismas reglas que el backend real).
import { describe, expect, it } from 'vitest'
import { createSimApi } from '.'
import type { CreateContainerSpec, ExecExit, StackOpFeed } from '../../types'

const mk = () => createSimApi({ latency: 0, tick: 1 })
const spec = (o: Partial<CreateContainerSpec> = {}): CreateContainerSpec => ({
  image: 'nginx:1.27-alpine', name: 'nuevo', ports: [], volumes: [], env: [], network: 'bridge', restart: 'no', restart_max_retries: null, command: null, labels: {}, ...o,
})
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('sim: stacks', () => {
  it('lista derivada de contenedores + archivos; discovered no editable; read/save con revisión', async () => {
    const api = mk()
    const list = await api.stacks.list()
    expect(list.map((s) => [s.name, s.origin, s.editable])).toEqual([['monitoreo', 'discovered', false], ['tienda', 'linked', true]])
    expect(list[1].services.find((s) => s.name === 'worker')).toMatchObject({ state: 'restarting', replicas: '0/1' })
    // Descubierto: se LEE (solo lectura, como el backend) pero no se guarda, valida ni levanta.
    expect(await api.stacks.read('monitoreo')).toMatchObject({ editable: false, origin: 'discovered' })
    await expect(api.stacks.save('monitoreo', { yaml: 'x', env: '', expectedRevision: null })).rejects.toMatchObject({ code: 'policy_denied' })
    await expect(api.stacks.validate('monitoreo', 'x', '')).rejects.toMatchObject({ code: 'policy_denied' })
    const denied: { type: string; error?: { code: string } | null }[] = []
    api.stacks.runOp('monitoreo', { type: 'up' }, (f) => denied.push(f as never))
    await wait(30)
    expect(denied.at(-1)).toMatchObject({ type: 'ended', outcome: 'failed', error: { code: 'policy_denied' } })
    await expect(api.stacks.read('nadie')).rejects.toMatchObject({ code: 'not_found' })
    const f = await api.stacks.read('tienda')
    const saved = await api.stacks.save('tienda', { yaml: f.yaml + '\n# x', env: f.env, expectedRevision: f.revision })
    expect(saved.revision).not.toBe(f.revision)
    await expect(api.stacks.save('tienda', { yaml: 'a', env: '', expectedRevision: f.revision })).rejects.toMatchObject({ code: 'state_changed' })
    api.sim.stacks.failNextSave = true
    await expect(api.stacks.save('tienda', { yaml: 'a', env: '', expectedRevision: saved.revision })).rejects.toMatchObject({ code: 'state_changed' })
  })

  it('validate: errores con línea, riesgos y Compose ausente', async () => {
    const api = mk()
    const bad = await api.stacks.validate('tienda', api.sim.stacks.brokenYaml, '')
    expect(bad.ok).toBe(false)
    expect(bad.issues[0]).toMatchObject({ line: 5, kind: 'syntax' })
    const risky = await api.stacks.validate(null, 'services:\n  a:\n    image: x\n    privileged: true\n    volumes: ["/var/run/docker.sock:/s"]\n', '')
    expect(risky.risks.map((r) => r.type)).toEqual(['privileged', 'docker_sock'])
    api.sim.stacks.setComposeMissing(true)
    await expect(api.stacks.validate(null, '', '')).rejects.toMatchObject({ code: 'compose_missing' })
    expect((await api.stacks.composeInfo()).available).toBe(false)
  })

  it('create/link/unlink: nombres, duplicados, rutas y desvincular sin borrar', async () => {
    const api = mk()
    await expect(api.stacks.create('Mal Nombre', '', '')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.stacks.create('tienda', '', '')).rejects.toMatchObject({ code: 'conflict' })
    expect((await api.stacks.create('nuevo', 'services: {}', '')).origin).toBe('managed')
    await expect(api.stacks.link('relativa.yaml')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.stacks.link('/x/y/compose.txt')).rejects.toMatchObject({ code: 'invalid_input' })
    expect((await api.stacks.link('/srv/blog/compose.yaml')).name).toBe('blog')
    await api.stacks.unlink('blog')
    await expect(api.stacks.unlink('nuevo')).rejects.toMatchObject({ code: 'conflict' })
  })

  it('runOp: started -> progress -> ended y muta el mundo; cancel() -> canceled; dispose no emite', async () => {
    const api = mk()
    const feeds: StackOpFeed[] = []
    api.stacks.runOp('tienda', { type: 'up' }, (f) => feeds.push(f))
    await wait(80)
    expect(feeds[0]).toMatchObject({ type: 'started', op: 'up', compose_version: '5.5.1' })
    expect(feeds.filter((f) => f.type === 'progress').length).toBeGreaterThan(1)
    expect(feeds.at(-1)).toMatchObject({ type: 'ended', outcome: 'success' })
    const canceled: StackOpFeed[] = []
    const h = api.stacks.runOp('tienda', { type: 'restart' }, (f) => canceled.push(f))
    h.cancel()
    await wait(30)
    expect(canceled.at(-1)).toMatchObject({ type: 'ended', outcome: 'canceled' })
    const silent: StackOpFeed[] = []
    api.stacks.runOp('tienda', { type: 'up' }, (f) => silent.push(f)).dispose()
    await wait(30)
    expect(silent).toEqual([])
  })

  it('stack_down / stack_delete por la política: nombre escrito, contenedores afectados y borrado de archivos', async () => {
    const api = mk()
    const down = await api.actions.plan({ type: 'stack_down', project: 'tienda' })
    expect(down.decision).toEqual({ type: 'confirm_typed', expected: 'tienda' })
    expect(down.affected[0]).toMatchObject({ kind: 'stack', name: 'tienda' })
    expect(down.affected.filter((a) => a.kind === 'container')).toHaveLength(5)
    await api.actions.cancel(down.ticket!)
    await api.stacks.create('borrable', 'services: {}', '')
    const del = await api.actions.plan({ type: 'stack_delete', name: 'borrable' })
    await expect(api.actions.execute(del.ticket!, 'otro', true)).rejects.toMatchObject({ code: 'typed_mismatch' })
    await expect(api.actions.execute(del.ticket!, 'borrable', false)).rejects.toMatchObject({ code: 'policy_denied' })
    await api.actions.execute(del.ticket!, 'borrable', true)
    expect(api.sim.world.ownStacks.some((s) => s.name === 'borrable')).toBe(false)
    await expect(api.actions.plan({ type: 'stack_delete', name: 'tienda' })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('sim: exec', () => {
  it('rechaza contenedores no running; escribe ANSI, edita línea y responde a Ctrl+C, stty y exit', async () => {
    const api = mk()
    await expect(api.exec.open('minio-dev', { cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'conflict' })
    const s = await api.exec.open('tienda-api-1', { cols: 80, rows: 24 })
    let out = ''
    const dec = new TextDecoder()
    s.onOutput((c) => { out += dec.decode(c) })
    const exits: ExecExit[] = []
    s.onExit((e) => exits.push(e))
    await wait(5)
    expect(out).toContain('root@')
    s.write('ech')
    s.write('x\x7fo hola\r')
    await wait(2)
    expect(out).toContain('hola')
    s.resize(132, 43)
    s.write('stty size\r')
    expect(out).toContain('43 132')
    s.write('cosa-rara\r')
    expect(out).toContain('no se encontró la orden')
    s.write('constructor\r')
    s.write('abc\x03')
    expect(out).toContain('^C')
    s.write('ls --color\r')
    expect(out).toContain('\x1b[1;34mdist')
    s.write('exit\r')
    expect(exits[0]).toMatchObject({ reason: 'process_exited', exit_code: 0 })
    s.close()
    s.close()
    expect(api.sim.exec).toMatchObject({ opened: 1, closed: 1, live: 0 })
  })

  it('flood produce salida masiva en trozos sin bloquear y detener el contenedor cierra la sesión', async () => {
    const api = mk()
    const s = await api.exec.open('tienda-api-1', { cols: 80, rows: 24 })
    let bytes = 0
    s.onOutput((c) => { bytes += c.length })
    s.write('flood 5000\r')
    await wait(150)
    expect(bytes).toBeGreaterThan(300_000)
    const exits: ExecExit[] = []
    s.onExit((e) => exits.push(e))
    await api.containers.stop(api.sim.world.containers.find((c) => c.names[0] === 'tienda-api-1')!.id)
    expect(exits[0].reason).toBe('container_stopped')
  })
})

describe('sim: pull', () => {
  it('capas en bytes con fases y digest; la cancelación no emite ended; errores por nombre', async () => {
    const api = mk()
    const feeds: { type: string; layers?: { phase: string; done: number; total: number }[]; outcome?: string; error?: { code: string } | null }[] = []
    api.images.pull('miapp/nueva:1', (f) => feeds.push(f))
    await wait(150)
    expect(feeds[0].type).toBe('started')
    const prog = feeds.filter((f) => f.type === 'progress')
    expect(prog[0].layers!.length).toBe(5)
    expect(prog.some((f) => f.layers!.some((l) => l.phase === 'downloading' && l.done > 0 && l.done < l.total))).toBe(true)
    expect(feeds.at(-1)).toMatchObject({ type: 'ended', outcome: 'done' })
    const cancelled: string[] = []
    api.images.pull('a/b:1', (f) => cancelled.push(f.type))()
    await wait(30)
    expect(cancelled).toEqual([])
    const codes: Record<string, string> = { 'x/ratelimit-429:1': 'engine', 'x/noexiste:1': 'image_missing', 'x/private-auth:1': 'auth_required', 'x/offline-unreach:1': 'registry_unreachable' }
    for (const [ref, code] of Object.entries(codes)) {
      const got: { type: string; error?: { code: string } | null }[] = []
      api.images.pull(ref, (f) => got.push(f))
      await wait(120)
      expect(got.at(-1)?.error?.code, ref).toBe(code)
    }
  })
})

describe('sim: crear contenedor, volumen y red', () => {
  it('plan: errores por campo, avisos y ticket para lo sensible; create exige ese ticket y no descarga imágenes', async () => {
    const api = mk()
    const bad = await api.containers.planCreate(spec({ name: 'tienda-api-1', volumes: [{ source: './rel', target: 'x', read_only: false }] }))
    expect(bad.ok).toBe(false)
    expect(bad.field_errors.map((f) => f.field)).toEqual(['name', 'volumes[0].target', 'volumes[0].source'])
    const risky = spec({ volumes: [{ source: '/var/run/docker.sock', target: '/s', read_only: false }] })
    const plan = await api.containers.planCreate(risky)
    expect(plan).toMatchObject({ ok: true, decision: { type: 'confirm' } })
    expect(plan.ticket).toBeTruthy()
    expect(plan.warnings.map((w) => w.type)).toContain('docker_socket')
    await expect(api.containers.create(risky, false, null)).rejects.toMatchObject({ code: 'ticket_invalid' })
    await expect(api.containers.create({ ...risky, name: 'otro' }, false, plan.ticket)).rejects.toMatchObject({ code: 'ticket_invalid' })
    const r = await api.containers.create(risky, false, plan.ticket)
    expect(r).toMatchObject({ name: 'nuevo', started: false })
    await expect(api.containers.create(risky, false, plan.ticket)).rejects.toMatchObject({ code: 'conflict' }) // nombre ya usado (y ticket ya gastado)
    await expect(api.containers.create(spec({ image: 'no/existe:9', name: 'z' }), true, null)).rejects.toMatchObject({ code: 'image_missing' })
  })

  it('puerto ocupado: aviso en el plan y start_error al arrancar (el contenedor queda creado)', async () => {
    const api = mk()
    const s = spec({ name: 'p8080', ports: [{ host_ip: '127.0.0.1', host_port: 8080, container_port: 80, protocol: 'tcp' }] })
    expect((await api.containers.planCreate(s)).warnings).toContainEqual({ type: 'port_in_use', port: 8080, by: 'tienda-web-1' })
    const r = await api.containers.create(s, true, null)
    expect(r.started).toBe(false)
    expect(r.start_error?.message).toMatch(/port is already allocated/)
    expect(api.sim.world.containers.find((c) => c.names[0] === 'p8080')?.state).toBe('created')
  })

  it('volumen y red: duplicados, nombres reservados, CIDR, solapamiento y puerta de enlace', async () => {
    const api = mk()
    await expect(api.volumes.create({ name: 'x', labels: {} })).rejects.toMatchObject({ code: 'invalid_input' })
    const existing = api.sim.world.volumes[0].name
    await expect(api.volumes.create({ name: existing, labels: {} })).rejects.toMatchObject({ code: 'conflict' })
    const v = await api.volumes.create({ name: 'vol-nuevo', labels: { a: 'b' } })
    expect(v).toMatchObject({ driver: 'local', labels: { a: 'b' }, used_by: [] })
    expect((await api.volumes.list()).some((x) => x.name === 'vol-nuevo')).toBe(true)
    await expect(api.networks.create({ name: 'bridge', internal: false, subnet: null, gateway: null, labels: {} })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.networks.create({ name: 'red-x', internal: false, subnet: '999.1.1.0/24', gateway: null, labels: {} })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.networks.create({ name: 'red-x', internal: false, subnet: '172.20.9.0/24', gateway: null, labels: {} })).rejects.toMatchObject({ code: 'conflict' })
    await expect(api.networks.create({ name: 'red-x', internal: false, subnet: '10.9.0.0/24', gateway: '10.8.0.1', labels: {} })).rejects.toMatchObject({ code: 'invalid_input' })
    const n = await api.networks.create({ name: 'red-x', internal: true, subnet: '10.9.0.0/24', gateway: '10.9.0.1', labels: {} })
    expect(n).toMatchObject({ internal: true, subnets: ['10.9.0.0/24'], driver: 'bridge' })
  })
})
