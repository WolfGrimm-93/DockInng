// Adaptador simulado, Ola 2: grupos/preferencias persistentes, conexiones (huella TOFU), registries, build y limpieza guiada.
import { describe, expect, it } from 'vitest'
import { createSimApi } from '.'
import { isUuidV7 } from '@/lib/groupRules'
import { uuidv7 } from '@/lib/uuid7'
import type { BuildFeed, BuildSpec, CreateContainerSpec, SshConnSpec } from '../../types'

const mk = () => createSimApi({ latency: 0, tick: 1 })
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const ssh = (host: string, name = 'x'): SshConnSpec => ({ kind: 'ssh', name, host, port: 22, user: 'deploy', mode: 'explicit', identity: { type: 'agent' } })

describe('sim: grupos persistentes', () => {
  it('crear/renombrar/color/asignar/borrar con validación en el borde y cascada al borrar el grupo', async () => {
    const api = mk()
    let s = await api.groups.mutate({ type: 'create_group', name: ' Trabajo ', hue: 370 })
    const id = s.groups[0].id
    expect(isUuidV7(id)).toBe(true) // el id lo genera el backend
    expect(s.groups).toEqual([{ id, name: 'Trabajo', hue: 10 }])
    await expect(api.groups.mutate({ type: 'create_group', name: 'trabajo', hue: 1 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.groups.mutate({ type: 'create_group', name: 'a\u202eb', hue: 1 })).rejects.toMatchObject({ code: 'invalid_input' })
    s = await api.groups.mutate({ type: 'create_group', name: 'Sin color', hue: null })
    expect(s.groups[1].hue).toBeGreaterThanOrEqual(0) // color libre elegido por el backend
    s = await api.groups.mutate({ type: 'assign', connection_id: 'local', names: ['a', 'b'], group_id: id })
    expect(s.assignments).toHaveLength(2)
    s = await api.groups.mutate({ type: 'assign', connection_id: 'local', names: ['a'], group_id: null })
    expect(s.assignments.map((a) => a.container_name)).toEqual(['b'])
    await expect(api.groups.mutate({ type: 'assign', connection_id: 'fantasma', names: ['a'], group_id: id })).rejects.toMatchObject({ code: 'not_found' })
    s = await api.groups.mutate({ type: 'set_stack_hue', project: 'tienda', hue: 140 })
    expect(s.stack_hues).toEqual({ tienda: 140 })
    s = await api.groups.mutate({ type: 'delete_group', id })
    expect(s.groups.map((g) => g.name)).toEqual(['Sin color'])
    expect(s.assignments).toEqual([]) // ON DELETE CASCADE
  })
  it('un error de una operación no deja el almacén a medias', async () => {
    const api = mk()
    const id = (await api.groups.mutate({ type: 'create_group', name: 'Uno', hue: 5 })).groups[0].id
    await expect(api.groups.mutate({ type: 'rename_group', id, name: '' })).rejects.toBeTruthy()
    expect((await api.groups.load()).groups[0].name).toBe('Uno')
  })
  it('groups_import_legacy: idempotente, regenera ids no v7, descarta asignaciones de conexiones inexistentes y marca legacy_imported', async () => {
    const api = mk()
    expect((await api.groups.load()).legacy_imported).toBe(false)
    const good = uuidv7()
    const r = await api.groups.importLegacy({
      v: 1,
      groups: [{ id: good, name: 'Bueno', hue: 30 }, { id: 'g-viejo', name: 'Viejo', hue: 200 }],
      assign: { 'local\u0000web': good, 'local\u0000db': 'g-viejo', 'fantasma\u0000x': good },
      stackHue: { tienda: 99 },
    })
    expect(r).toMatchObject({ already_imported: false, imported_groups: 2, imported_assignments: 2, dropped_assignments: 1 })
    expect(r.snapshot.legacy_imported).toBe(true)
    const s = await api.groups.load()
    expect(s.legacy_imported).toBe(true)
    expect(s.groups.every((g) => isUuidV7(g.id))).toBe(true)
    expect(s.groups.find((g) => g.name === 'Bueno')?.id).toBe(good)
    const viejo = s.groups.find((g) => g.name === 'Viejo')!
    expect(viejo.id).not.toBe('g-viejo')
    expect(s.assignments).toHaveLength(2)
    expect(s.assignments.find((a) => a.container_name === 'db')?.group_id).toBe(viejo.id)
    expect(s.stack_hues).toEqual({ tienda: 99 })
    // Segunda llamada: no duplica ni escribe.
    expect(await api.groups.importLegacy({ v: 1, groups: [{ id: uuidv7(), name: 'Otro', hue: 1 }], assign: {}, stackHue: {} })).toMatchObject({ already_imported: true, imported_groups: 0 })
    expect((await api.groups.load()).groups).toHaveLength(2)
  })
  it('un payload hostil no lanza: se descarta lo inválido', async () => {
    const api = mk()
    const r = await api.groups.importLegacy({ v: 1, groups: [{ id: uuidv7(), name: '\u0007', hue: 1 } as never, null as never], assign: { x: 5 as never }, stackHue: { a: 'z' as never } })
    expect(r.already_imported).toBe(false)
    expect(await api.groups.load()).toMatchObject({ groups: [], assignments: [], stack_hues: {} })
  })
  it('las asignaciones de una conexión borrada se van con ella (FK cascade)', async () => {
    const api = mk()
    const gid = (await api.groups.mutate({ type: 'create_group', name: 'G', hue: 1 })).groups[0].id
    const p = await api.connections.save(ssh('h1', 'r1'))
    await api.groups.mutate({ type: 'assign', connection_id: p.id, names: ['c'], group_id: gid })
    await api.connections.remove(p.id, true)
    expect((await api.groups.load()).assignments).toEqual([])
  })
})

describe('sim: preferencias', () => {
  it('lista blanca de claves; null si nunca se guardó', async () => {
    const api = mk()
    expect(await api.prefs.get('polling')).toBeNull()
    await api.prefs.set('polling', true)
    expect(await api.prefs.get('polling')).toBe(true)
    await expect(api.prefs.set('tema' as never, 1)).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('sim: conexiones (huella de host)', () => {
  it('probe → unknown; trust con la huella vista → trusted; con otra huella → conflicto', async () => {
    const api = mk()
    const p = await api.connections.probeHostKey(ssh('srv.example'))
    expect(p).toMatchObject({ state: 'unknown', key_type: 'ssh-ed25519' })
    expect(p.fingerprint_sha256).toMatch(/^SHA256:/)
    await expect(api.connections.trustHostKey(ssh('srv.example'), 'SHA256:otra')).rejects.toMatchObject({ code: 'conflict' })
    expect(await api.connections.trustHostKey(ssh('srv.example'), p.fingerprint_sha256)).toMatchObject({ state: 'trusted' })
    expect((await api.connections.probeHostKey(ssh('srv.example'))).state).toBe('trusted')
  })
  it('clave cambiada: no se puede confiar; la prueba responde host_key_changed', async () => {
    const api = mk()
    const p = await api.connections.probeHostKey(ssh('changed-1'))
    expect(p.state).toBe('changed')
    expect(p.known_fingerprint_sha256).toBeTruthy()
    await expect(api.connections.trustHostKey(ssh('changed-1'), p.fingerprint_sha256)).rejects.toMatchObject({ code: 'connection', cause: 'host_key_changed' })
    expect(await api.connections.test(ssh('changed-1'))).toMatchObject({ ok: false, cause: 'host_key_changed' })
  })
  it('olvidar la clave cambiada la deja desconocida: solo entonces se puede confiar en la nueva', async () => {
    const api = mk()
    const p = await api.connections.probeHostKey(ssh('changed-2'))
    expect(p.state).toBe('changed')
    await api.connections.forgetHostKey(ssh('changed-2'))
    const despues = await api.connections.probeHostKey(ssh('changed-2'))
    expect(despues.state).toBe('unknown')
    expect(await api.connections.trustHostKey(ssh('changed-2'), despues.fingerprint_sha256)).toMatchObject({ state: 'trusted' })
  })
  it('sin huella confiada la prueba SSH no conecta (host_key_unknown); tras confiar, ok; causas clasificadas', async () => {
    const api = mk()
    expect(await api.connections.test(ssh('h2'))).toMatchObject({ ok: false, cause: 'host_key_unknown' })
    for (const [host, cause] of [['auth-fail', 'auth_failed'], ['unreach', 'unreachable'], ['nodocker', 'remote_docker_missing']] as const) {
      const pr = await api.connections.probeHostKey(ssh(host))
      await api.connections.trustHostKey(ssh(host), pr.fingerprint_sha256)
      expect(await api.connections.test(ssh(host))).toMatchObject({ ok: false, cause })
    }
    const pr = await api.connections.probeHostKey(ssh('h2'))
    await api.connections.trustHostKey(ssh('h2'), pr.fingerprint_sha256)
    expect(await api.connections.test(ssh('h2'))).toMatchObject({ ok: true, server: { version: '26.1.4' } })
    expect(await api.connections.test({ kind: 'tls', name: 't', host: 'badca', port: 2376, ca_path: '/a', cert_path: '/b', key_path: '/c' })).toMatchObject({ ok: false, cause: 'tls_invalid' })
  })
  it('validación en el borde: host con guion inicial, puerto, usuario y rutas relativas', async () => {
    const api = mk()
    await expect(api.connections.save(ssh('-oProxyCommand=x'))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.connections.save({ ...ssh('h'), port: 70000 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.connections.save({ ...ssh('h'), user: 'Root; rm' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.connections.save({ ...ssh('h'), identity: { type: 'file', path: 'relativa' } })).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('guardar: perfil remoto marcado simulado; nombre repetido = conflicto; borrar exige confirmación y protege local/activa', async () => {
    const api = mk()
    const p = await api.connections.save(ssh('h3', 'nueva'))
    expect(p).toMatchObject({ remote: true, kind: 'ssh', simulated: true })
    expect(isUuidV7(p.id)).toBe(true)
    // Un nombre ya usado por otra conexión es Conflict; «Local» está reservado.
    await expect(api.connections.save({ ...ssh('h4', 'NUEVA') })).rejects.toMatchObject({ code: 'conflict' })
    expect((await api.connections.list()).filter((x) => x.name.toLowerCase() === 'nueva')).toHaveLength(1)
    await expect(api.connections.save(ssh('h4', 'local'))).rejects.toMatchObject({ code: 'invalid_input' })
    expect((await api.connections.list()).map((x) => x.name.toLowerCase())).toContain('nueva')
    await expect(api.connections.remove(p.id, false)).rejects.toMatchObject({ code: 'policy_denied' })
    await expect(api.connections.remove('local', true)).rejects.toMatchObject({ code: 'policy_denied' })
    await api.connections.select(p.id)
    await expect(api.connections.remove(p.id, true)).rejects.toMatchObject({ code: 'conflict' })
    await api.connections.select('local')
    await api.connections.remove(p.id, true)
    expect((await api.connections.list()).map((x) => x.name.toLowerCase())).not.toContain('nueva')
  })
  it('select cambia la conexión activa; una inexistente falla y no la cambia', async () => {
    const api = mk()
    await expect(api.connections.select('nadie')).rejects.toMatchObject({ code: 'not_found' })
    expect(api.connection.activeId()).toBe('local')
    const st = await api.connections.select('prod')
    expect(st.state).toBe('connected')
    expect(api.connection.activeId()).toBe('prod')
  })
})

describe('sim: registries', () => {
  it('el secreto entra una vez y NO sale en ningún listado; valida servidor/usuario/secreto', async () => {
    const api = mk()
    const r = await api.registries.save({ server: 'GHCR.io', username: 'casa', secret: 'S3CRETO-XYZ' })
    expect(r).toMatchObject({ server: 'ghcr.io', username: 'casa' })
    expect(isUuidV7(r.id)).toBe(true)
    expect(JSON.stringify(await api.registries.list())).not.toContain('S3CRETO')
    expect(JSON.stringify(r)).not.toContain('S3CRETO')
    await expect(api.registries.save({ server: 'no valido!', username: 'a', secret: 'b' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.registries.save({ server: 'x.io', username: '', secret: 'b' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.registries.save({ server: 'x.io', username: 'a', secret: '' })).rejects.toMatchObject({ code: 'invalid_input' })
    // Mismo servidor = actualiza, no duplica.
    await api.registries.save({ server: 'ghcr.io', username: 'otro', secret: 'n' })
    expect(await api.registries.list()).toHaveLength(1)
  })
  it('probar (ok/credenciales malas) y eliminar con confirmación', async () => {
    const api = mk()
    const ok = await api.registries.save({ server: 'ghcr.io', username: 'casa', secret: 's' })
    const bad = await api.registries.save({ server: 'quay.io', username: 'bad-user', secret: 's' })
    expect(await api.registries.test(ok.id)).toEqual({ ok: true })
    expect(await api.registries.test(bad.id)).toMatchObject({ ok: false, error: { code: 'auth_required' } })
    await expect(api.registries.remove(ok.id, false)).rejects.toMatchObject({ code: 'policy_denied' })
    await api.registries.remove(ok.id, true)
    expect(await api.registries.list()).toHaveLength(1)
  })
})

describe('sim: build', () => {
  const spec = (o: Partial<BuildSpec> = {}): BuildSpec => ({ context_dir: '/home/u/app', dockerfile: null, tag: 'app:1', build_args: [], target: null, no_cache: false, pull: false, ...o })
  const run = (api: ReturnType<typeof mk>, s: BuildSpec, ticket: string | null = null) => new Promise<BuildFeed[]>((res) => { const got: BuildFeed[] = []; api.images.build(s, ticket, (f) => { got.push(f); if (f.type === 'ended') res(got) }) })

  it('plan: contexto normal = allow; sensible = confirmación con ticket; ARG con aspecto de secreto avisa; valida entradas', async () => {
    const api = mk()
    expect(await api.images.planBuild(spec())).toMatchObject({ decision: { type: 'allow' }, ticket: null, warnings: [] })
    const s = await api.images.planBuild(spec({ context_dir: '/home/u', build_args: [['API_TOKEN', 'x']] }))
    expect(s.decision.type).toBe('confirm')
    expect(s.ticket).toBeTruthy()
    expect(s.warnings.map((w) => w.type)).toEqual(['sensitive_context', 'secret_like_arg'])
    expect(JSON.stringify(s)).not.toContain('"x"') // el valor del ARG no se eco-a
    await expect(api.images.planBuild(spec({ context_dir: 'relativa' }))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.images.planBuild(spec({ dockerfile: '../fuera/Dockerfile' }))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.images.planBuild(spec({ tag: 'MAYUS:1' }))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.images.planBuild(spec({ build_args: [['A B', 'v']] }))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.images.planBuild(spec({ build_args: [['A', 'l1\nl2']] }))).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('construye con pasos y líneas, crea la imagen etiquetada y emite ended:ok', async () => {
    const api = mk()
    const before = (await api.images.list()).length
    const feeds = await run(api, spec({ tag: 'mi-app:2' }))
    expect(feeds.some((f) => f.type === 'step')).toBe(true)
    expect(feeds.filter((f) => f.type === 'line').length).toBeGreaterThan(3)
    expect(feeds.at(-1)).toMatchObject({ type: 'ended', outcome: 'ok', error: null })
    const imgs = await api.images.list()
    expect(imgs).toHaveLength(before + 1)
    expect(imgs.find((i) => i.reference === 'mi-app:2')).toBeTruthy()
  })
  it('un contexto sensible sin ticket no construye; con el ticket del plan, sí (un solo uso)', async () => {
    const api = mk()
    const s = spec({ context_dir: '/home/u' })
    expect((await run(api, s)).at(-1)).toMatchObject({ outcome: 'failed' })
    const plan = await api.images.planBuild(s)
    expect((await run(api, s, plan.ticket)).at(-1)).toMatchObject({ outcome: 'ok' })
    expect((await run(api, s, plan.ticket)).at(-1)).toMatchObject({ outcome: 'failed' })
  })
  it('un contexto que falla termina con error; cancelar (unsubscribe) no emite ended', async () => {
    const api = mk()
    expect((await run(api, spec({ context_dir: '/home/u/app-fail' }))).at(-1)).toMatchObject({ outcome: 'failed', error: { code: 'engine' } })
    const got: BuildFeed[] = []
    const off = api.images.build(spec(), null, (f) => got.push(f))
    await wait(5)
    off()
    const n = got.length
    await wait(40)
    expect(got.length).toBe(n)
    expect(got.some((f) => f.type === 'ended')).toBe(false)
  })
})

describe('sim: limpieza guiada', () => {
  it('informe: volúmenes nunca por defecto y con riesgo alto; imágenes con cota superior; caché solo informativa', async () => {
    const api = mk()
    const r = await api.system.cleanupReport({ minAgeDays: 0 })
    const cat = (id: string) => r.categories.find((c) => c.id === id)!
    expect(cat('unused_volumes').items.length).toBeGreaterThan(0)
    for (const i of cat('unused_volumes').items) { expect(i.selected_by_default).toBe(false); expect(i.risk).toBe('high') }
    expect(cat('unused_volumes').items.some((i) => i.estimate === 'unknown' && i.size_bytes === null)).toBe(true)
    for (const i of [...cat('dangling_images').items, ...cat('unused_images').items]) expect(i.estimate).toBe('upper_bound')
    expect(cat('build_cache')).toMatchObject({ executable: false, items: [] })
    expect(r.unknown_count).toBeGreaterThan(0)
    // No incluye recursos en uso ni redes del sistema.
    const names = r.categories.flatMap((c) => c.items.map((i) => i.name))
    expect(names).not.toContain('bridge')
    expect(names).not.toContain('tienda-api-1')
    expect(names).not.toContain('postgres:16.4')
  })
  it('min_age_days filtra imágenes sin usar recientes', async () => {
    const api = mk()
    const all = (await api.system.cleanupReport({ minAgeDays: 0 })).categories.find((c) => c.id === 'unused_images')!.items.length
    const old = (await api.system.cleanupReport({ minAgeDays: 90 })).categories.find((c) => c.id === 'unused_images')!.items.length
    expect(old).toBeLessThan(all)
  })
  it('plan cleanup: sin volúmenes = Confirmar; con volúmenes = ELIMINAR escrito; vacío o tope 500 = invalid_input; prune_system sigue denegado', async () => {
    const api = mk()
    const r = await api.system.cleanupReport({ minAgeDays: 0 })
    const stopped = r.categories.find((c) => c.id === 'stopped_containers')!.items.map((i) => i.id)
    const vol = r.categories.find((c) => c.id === 'unused_volumes')!.items[0].id
    const p1 = await api.actions.plan({ type: 'cleanup', selection: { containers: stopped, images: [], volumes: [], networks: [] } })
    expect(p1.decision).toEqual({ type: 'confirm' })
    expect(p1.affected).toHaveLength(stopped.length)
    const p2 = await api.actions.plan({ type: 'cleanup', selection: { containers: [], images: [], volumes: [vol], networks: [] } })
    expect(p2.decision).toEqual({ type: 'confirm_typed', expected: 'ELIMINAR' })
    await expect(api.actions.plan({ type: 'cleanup', selection: { containers: [], images: [], volumes: [], networks: [] } })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.actions.plan({ type: 'cleanup', selection: { containers: Array.from({ length: 501 }, (_, i) => `x${i}`), images: [], volumes: [], networks: [] } })).rejects.toMatchObject({ code: 'invalid_input' })
    expect((await api.actions.plan({ type: 'prune_system' })).decision).toEqual({ type: 'deny', reason: 'forbidden' })
  })
  it('ejecutar: borra solo lo seleccionado, exige el texto ELIMINAR con volúmenes y no toca lo ajeno', async () => {
    const api = mk()
    const r = await api.system.cleanupReport({ minAgeDays: 0 })
    const vol = r.categories.find((c) => c.id === 'unused_volumes')!.items[0].id
    const before = { c: (await api.containers.list()).length, v: (await api.volumes.list()).length, i: (await api.images.list()).length }
    const plan = await api.actions.plan({ type: 'cleanup', selection: { containers: [], images: [], volumes: [vol], networks: [] } })
    await expect(api.actions.execute(plan.ticket!, 'no')).rejects.toMatchObject({ code: 'typed_mismatch' })
    const out = await api.actions.execute(plan.ticket!, 'ELIMINAR')
    expect(out.succeeded).toEqual([{ kind: 'volume', id: vol, name: vol }])
    expect((await api.volumes.list()).length).toBe(before.v - 1)
    expect((await api.containers.list()).length).toBe(before.c)
    expect((await api.images.list()).length).toBe(before.i)
    await expect(api.actions.execute(plan.ticket!, 'ELIMINAR')).rejects.toMatchObject({ code: 'ticket_invalid' }) // un solo uso
  })
  it('un elemento que pasó a estar en uso entre el plan y la ejecución se omite y se informa', async () => {
    const api = mk()
    const r = await api.system.cleanupReport({ minAgeDays: 0 })
    const stopped = r.categories.find((c) => c.id === 'stopped_containers')!.items
    const minio = stopped.find((i) => i.name === 'minio-dev')!
    const plan = await api.actions.plan({ type: 'cleanup', selection: { containers: [minio.id], images: [], volumes: [], networks: [] } })
    await api.containers.start(minio.id) // cambia el estado tras el plan
    const out = await api.actions.execute(plan.ticket!)
    expect(out.succeeded).toEqual([])
    expect(out.failed[0]).toMatchObject({ item: { name: 'minio-dev' }, error: { code: 'state_changed' } })
    expect((await api.containers.list()).some((c) => c.names[0] === 'minio-dev')).toBe(true)
  })
})

describe('sim: Podman y RemoteBind', () => {
  it('podman_detect devuelve candidatos', async () => {
    expect((await mk().system.podmanDetect())[0]).toMatchObject({ rootless: true })
  })
  it('con conexión remota activa, un bind absoluto en «Crear» avisa RemoteBind; en local no', async () => {
    const api = mk()
    const spec: CreateContainerSpec = { image: 'nginx:1.27-alpine', name: 'n1', ports: [], volumes: [{ source: '/srv/datos', target: '/d', read_only: false }], env: [], network: 'bridge', restart: 'no', restart_max_retries: null, command: null, labels: {} }
    expect((await api.containers.planCreate(spec)).warnings.some((w) => w.type === 'remote_bind')).toBe(false)
    await api.connections.select('prod')
    expect((await api.containers.planCreate(spec)).warnings.some((w) => w.type === 'remote_bind')).toBe(true)
  })
  it('con conexión remota activa, validar un compose con ruta relativa devuelve el riesgo remote_bind', async () => {
    const api = mk()
    const yaml = 'services:\n  web:\n    image: nginx\n    volumes:\n      - ./data:/usr/share/nginx/html\n'
    expect((await api.stacks.validate(null, yaml, '')).risks.some((r) => r.type === 'remote_bind')).toBe(false)
    await api.connections.select('prod')
    const v = await api.stacks.validate(null, yaml, '')
    expect(v.risks.find((r) => r.type === 'remote_bind')?.path).toMatch(/^\/.*data$/)
  })
})

describe('sim: connection_save con id (editar)', () => {
  it('con id edita y permite renombrar; id inexistente = not_found; nombre de otra = conflict; la activa no se edita', async () => {
    const api = mk()
    const a = await api.connections.save(ssh('h1', 'uno'))
    const b = await api.connections.save(ssh('h2', 'dos'))
    const edited = await api.connections.save({ ...ssh('h9', 'uno-renombrada') }, a.id)
    expect(edited.id).toBe(a.id)
    expect((await api.connections.list()).filter((p) => p.remote).map((p) => p.name)).toContain('uno-renombrada')
    await expect(api.connections.save(ssh('h9', 'DOS'), a.id)).rejects.toMatchObject({ code: 'conflict' })
    await expect(api.connections.save(ssh('h9', 'x'), 'no-existe')).rejects.toMatchObject({ code: 'not_found' })
    await api.connections.select(b.id)
    await expect(api.connections.save(ssh('h9', 'dos'), b.id)).rejects.toMatchObject({ code: 'conflict' })
  })
})
