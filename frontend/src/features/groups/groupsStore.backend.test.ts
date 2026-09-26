// groupsStore como caché write-through del backend + migración de `dockinng.groups.v1` (una vez, idempotente, sin borrar la clave).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSimApi, type SimEngineApi } from '@/data/adapters/sim'
import { uuidv7 } from '@/lib/uuid7'
import { clearMemoryStorage } from '@/lib/safeStorage'
import { getToasts, toast } from '@/lib/toastStore'
import { GROUPS_KEY, GROUPS_MIGRATED_KEY, assignKey, bindGroupsBackend, resetGroupsStore, useGroupsStore } from './groupsStore'

const s = () => useGroupsStore.getState()
const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms))
const mk = (): SimEngineApi => createSimApi({ latency: 0, tick: 1 })
const seedLegacy = (o: unknown) => window.localStorage.setItem(GROUPS_KEY, JSON.stringify(o))

beforeEach(() => { window.localStorage.clear(); clearMemoryStorage(); resetGroupsStore(); toast.clear() })
afterEach(() => { resetGroupsStore(); window.localStorage.clear(); clearMemoryStorage(); toast.clear() })

describe('migración desde localStorage', () => {
  it('importa una sola vez, renombra la clave a .migrated (no la borra) y deja la caché con lo del backend', async () => {
    const gid = uuidv7()
    const legacy = { v: 1, groups: [{ id: gid, name: 'Trabajo', hue: 120 }], assign: { [assignKey('local', 'web')]: gid }, stackHue: { tienda: 77 } }
    resetGroupsStore()
    seedLegacy(legacy) // simula el arranque con la clave heredada
    useGroupsStore.setState({ groups: legacy.groups, assign: legacy.assign, stackHue: legacy.stackHue })
    const api = mk()
    const unbind = bindGroupsBackend(api)
    await vi.waitFor(() => expect(window.localStorage.getItem(GROUPS_MIGRATED_KEY)).not.toBeNull())
    await wait()
    const snap = await api.groups.load()
    expect(snap.legacy_imported).toBe(true)
    expect(snap.groups).toEqual([{ id: gid, name: 'Trabajo', hue: 120 }])
    expect(snap.assignments).toEqual([{ connection_id: 'local', container_name: 'web', group_id: gid }])
    expect(window.localStorage.getItem(GROUPS_KEY)).toBeNull()
    expect(JSON.parse(window.localStorage.getItem(GROUPS_MIGRATED_KEY)!)).toEqual(legacy) // renombrada, contenido intacto
    expect(s().groups).toEqual([{ id: gid, name: 'Trabajo', hue: 120 }])
    expect(s().assign[assignKey('local', 'web')]).toBe(gid)
    expect(s().stackHue).toEqual({ tienda: 77 })
    unbind()
  })
  it('es idempotente: con el backend ya migrado no se vuelve a importar aunque reaparezca la clave heredada', async () => {
    const api = mk()
    await api.groups.importLegacy({ v: 1, groups: [{ id: uuidv7(), name: 'Uno', hue: 1 }], assign: {}, stackHue: {} })
    resetGroupsStore()
    seedLegacy({ v: 1, groups: [{ id: uuidv7(), name: 'Fantasma', hue: 2 }], assign: {}, stackHue: {} })
    const unbind = bindGroupsBackend(api)
    await wait()
    expect((await api.groups.load()).groups.map((g) => g.name)).toEqual(['Uno'])
    expect(s().groups.map((g) => g.name)).toEqual(['Uno'])
    unbind()
  })
  it('si el backend falla al importar NO se marca migrado ni se toca localStorage (modo heredado)', async () => {
    const gid = uuidv7()
    resetGroupsStore()
    seedLegacy({ v: 1, groups: [{ id: gid, name: 'Local', hue: 5 }], assign: {}, stackHue: {} })
    useGroupsStore.setState({ groups: [{ id: gid, name: 'Local', hue: 5 }] })
    const api = mk()
    api.groups.importLegacy = async () => { throw { code: 'internal', message: 'sin disco' } }
    const unbind = bindGroupsBackend(api)
    await wait()
    expect(window.localStorage.getItem(GROUPS_KEY)).not.toBeNull()
    expect(window.localStorage.getItem(GROUPS_MIGRATED_KEY)).toBeNull()
    expect((await api.groups.load()).legacy_imported).toBe(false)
    // Sigue funcionando en modo heredado: las mutaciones se guardan en localStorage.
    s().createGroup('Nuevo')
    expect(JSON.parse(window.localStorage.getItem(GROUPS_KEY)!).groups).toHaveLength(2)
    unbind()
  })
  it('si groups_load falla (backend sin almacén) se queda en modo heredado sin ruido', async () => {
    const api = mk()
    api.groups.load = async () => { throw { code: 'not_implemented', message: 'x' } }
    const unbind = bindGroupsBackend(api)
    await wait()
    s().createGroup('A')
    expect(window.localStorage.getItem(GROUPS_KEY)).toContain('"A"')
    expect(getToasts()).toHaveLength(0)
    unbind()
  })
  it('un localStorage heredado corrupto no rompe: nada que importar y el backend queda como fuente', async () => {
    resetGroupsStore()
    window.localStorage.setItem(GROUPS_KEY, '{no es json')
    const api = mk()
    const unbind = bindGroupsBackend(api)
    await wait()
    expect(s().groups).toEqual([])
    unbind()
  })
})

describe('write-through', () => {
  it('cada acción es optimista (síncrona) y llega al backend; al terminar la caché toma el snapshot', async () => {
    const api = mk()
    const unbind = bindGroupsBackend(api)
    await wait()
    const optimistic = s().createGroup('Trabajo')!
    expect(s().groups.map((g) => g.name)).toEqual(['Trabajo']) // optimista, sin esperar
    // Las operaciones en cola mencionan el id OPTIMISTA: el backend genera el suyo y la caché los reescribe.
    s().moveContainers('local', ['a', 'b'], optimistic)
    s().setStackHue('tienda', 200)
    s().renameGroup(optimistic, 'Oficina')
    s().setGroupHue(optimistic, 300)
    await wait(40)
    const real = await api.groups.load()
    const id = real.groups[0].id
    expect(id).not.toBe(optimistic) // id real (UUID v7) generado por el backend
    expect(real.groups).toEqual([{ id, name: 'Oficina', hue: 300 }])
    expect(real.assignments.map((a) => a.container_name).sort()).toEqual(['a', 'b'])
    expect(real.stack_hues).toEqual({ tienda: 200 })
    expect(s().groups).toEqual(real.groups)
    expect(s().groups[0].id).toBe(id) // la caché ya usa el id real
    s().deleteGroup(id)
    await wait(30)
    expect((await api.groups.load()).assignments).toEqual([])
    expect(s().assign).toEqual({})
    // En modo backend NO se escribe localStorage (la fuente es el almacén).
    expect(window.localStorage.getItem(GROUPS_KEY)).toBeNull()
    unbind()
  })
  it('el orden de las operaciones se conserva aunque el backend responda tarde', async () => {
    const api = mk()
    const orig = api.groups.mutate
    api.groups.mutate = async (op) => { await wait(op.type === 'create_group' ? 20 : 1); return orig(op) }
    const unbind = bindGroupsBackend(api)
    await wait()
    const id = s().createGroup('G')!
    s().renameGroup(id, 'H')
    await wait(80)
    expect((await api.groups.load()).groups[0].name).toBe('H')
    unbind()
  })
  it('si el backend rechaza una operación: toast de error y la caché vuelve a lo real (rollback)', async () => {
    const api = mk()
    const unbind = bindGroupsBackend(api)
    await wait()
    s().createGroup('Uno')
    await wait(30)
    const id = s().groups[0].id
    api.groups.mutate = async () => { throw { code: 'internal', message: 'disco lleno' } }
    s().renameGroup(id, 'Dos')
    expect(s().groups[0].name).toBe('Dos') // optimista
    await wait(30)
    expect(s().groups[0].name).toBe('Uno') // recargado del backend
    expect(getToasts().some((t) => t.kind === 'err' && /grupos/i.test(t.msg))).toBe(true)
    unbind()
  })
  it('las validaciones locales siguen mandando (nombre duplicado no se envía)', async () => {
    const api = mk()
    let calls = 0
    const orig = api.groups.mutate
    api.groups.mutate = async (op) => { calls++; return orig(op) }
    const unbind = bindGroupsBackend(api)
    await wait()
    s().createGroup('A')
    expect(s().createGroup('a')).toBeNull()
    await wait(20)
    expect(calls).toBe(1)
    unbind()
  })
})

describe('revisión fase 4: grupos', () => {
  it('B-3: cambios hechos MIENTRAS carga el backend no se pierden al archivar la clave heredada', async () => {
    const api = mk()
    const gid = uuidv7()
    await api.groups.importLegacy({ v: 1, groups: [{ id: gid, name: 'Previo', hue: 1 }], assign: {}, stackHue: {} })
    resetGroupsStore()
    seedLegacy({ v: 1, groups: [{ id: gid, name: 'Previo', hue: 1 }], assign: {}, stackHue: {} })
    useGroupsStore.setState({ groups: [{ id: gid, name: 'Previo', hue: 1 }] })
    const orig = api.groups.load
    api.groups.load = async () => { await wait(15); return orig() }
    const unbind = bindGroupsBackend(api)
    s().createGroup('Durante') // antes de que termine la carga
    await wait(80)
    expect((await api.groups.load()).groups.map((g) => g.name).sort()).toEqual(['Durante', 'Previo'])
    expect(s().groups.map((g) => g.name).sort()).toEqual(['Durante', 'Previo'])
    expect(window.localStorage.getItem(GROUPS_KEY)).toBeNull() // archivada, pero el cambio ya está en el backend
    unbind()
  })
  it('B-4: un legado por encima de los límites se recorta con aviso; un fallo de importación avisa (no es silencioso)', async () => {
    const api = mk()
    const groups = Array.from({ length: 520 }, (_, i) => ({ id: uuidv7(), name: `G${i}`, hue: i % 360 }))
    resetGroupsStore()
    seedLegacy({ v: 1, groups, assign: { [assignKey('local', 'x')]: groups[519].id }, stackHue: {} })
    let sent = 0
    const orig = api.groups.importLegacy
    api.groups.importLegacy = async (p) => { sent = p.groups.length; return orig(p) }
    const unbind = bindGroupsBackend(api)
    await wait(60)
    expect(sent).toBe(500)
    expect(getToasts().some((t) => /más de 500 grupos/.test(t.sub ?? ''))).toBe(true)
    unbind()
    toast.clear()
    const api2 = mk()
    api2.groups.importLegacy = async () => { throw { code: 'invalid_input', message: 'demasiados' } }
    resetGroupsStore()
    seedLegacy({ v: 1, groups: [{ id: uuidv7(), name: 'A', hue: 1 }], assign: {}, stackHue: {} })
    useGroupsStore.setState({ groups: [{ id: uuidv7(), name: 'A', hue: 1 }] })
    const u2 = bindGroupsBackend(api2)
    await wait(40)
    expect(getToasts().some((t) => t.kind === 'err' && /migrar los grupos/.test(t.msg))).toBe(true)
    u2()
  })
  it('B-2: desconectar con una mutación en vuelo no deja el contador en negativo; al reconectar se siguen aplicando snapshots', async () => {
    const api = mk()
    const orig = api.groups.mutate
    api.groups.mutate = async (op) => { await wait(25); return orig(op) }
    const u1 = bindGroupsBackend(api)
    await wait(20)
    s().createGroup('Uno')
    u1() // la mutación sigue en vuelo
    const u2 = bindGroupsBackend(api)
    await wait(40)
    s().createGroup('Dos')
    await wait(120)
    expect(s().groups.map((g) => g.name)).toContain('Dos')
    expect(s().groups.every((g) => /^[0-9a-f-]{36}$/.test(g.id))).toBe(true)
    u2()
  })
})
