import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMemoryStorage } from '@/lib/safeStorage'
import { GROUP_HUES } from '../common/groupColor'
import { GROUPS_KEY, MAX_GROUP_NAME, assignKey, clampHue, loadGroups, nextFreeHue, resetGroupsStore, useGroupsStore, validateGroupName } from './groupsStore'

const s = () => useGroupsStore.getState()
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

beforeEach(() => { window.localStorage.clear(); clearMemoryStorage(); resetGroupsStore() })
afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); clearMemoryStorage(); resetGroupsStore() })

describe('validateGroupName', () => {
  it('rechaza vacío, demasiado largo, caracteres de control/bidi y duplicados sin distinguir mayúsculas', () => {
    const g = [{ id: 'a', name: 'Pruebas', hue: 10 }]
    expect(validateGroupName('  ', g)).toMatch(/nombre/)
    expect(validateGroupName('x'.repeat(MAX_GROUP_NAME + 1), g)).toMatch(/Máximo/)
    expect(validateGroupName('a\u0007b', g)).toMatch(/no permitidos/)
    expect(validateGroupName('‮gpj', g)).toMatch(/no permitidos/)
    expect(validateGroupName('pruebas', g)).toMatch(/Ya existe/)
    expect(validateGroupName('PRUEBAS', g, 'a')).toBeNull() // el propio grupo al renombrarse a sí mismo
    expect(validateGroupName('Otro', g)).toBeNull()
  })
})

describe('clampHue / nextFreeHue', () => {
  it('normaliza cualquier número a 0–359 y NaN a 0', () => {
    expect(clampHue(370)).toBe(10)
    expect(clampHue(-10)).toBe(350)
    expect(clampHue(359.6)).toBe(0)
    expect(clampHue(Number.NaN)).toBe(0)
    expect(clampHue(Number.POSITIVE_INFINITY)).toBe(0)
  })
  it('elige el primer matiz libre y, si todos están en uso, reutiliza en orden', () => {
    expect(nextFreeHue([])).toBe(GROUP_HUES[0])
    expect(nextFreeHue([GROUP_HUES[0]])).toBe(GROUP_HUES[1])
    expect(nextFreeHue([...GROUP_HUES])).toBe(GROUP_HUES[0])
  })
})

describe('groupsStore', () => {
  it('crea grupos con UUID v7, nombre recortado y color libre por defecto', () => {
    const a = s().createGroup('  Trabajo  ')
    const b = s().createGroup('Personal')
    expect(a).toMatch(UUID7)
    expect(s().groups.map((g) => g.name)).toEqual(['Trabajo', 'Personal'])
    expect(s().groups[0].hue).toBe(GROUP_HUES[0])
    expect(s().groups[1].hue).toBe(GROUP_HUES[1])
    expect(b).not.toBe(a)
  })
  it('un nombre inválido o repetido no crea nada y devuelve null', () => {
    s().createGroup('Uno')
    expect(s().createGroup('uno')).toBeNull()
    expect(s().createGroup('')).toBeNull()
    expect(s().groups).toHaveLength(1)
  })
  it('renombra (sin duplicar) y cambia el color con clamp', () => {
    const id = s().createGroup('Uno')!
    s().createGroup('Dos')
    expect(s().renameGroup(id, 'Dos')).toBe(false)
    expect(s().renameGroup(id, 'Tres')).toBe(true)
    expect(s().renameGroup('no-existe', 'X')).toBe(false)
    s().setGroupHue(id, 725)
    expect(s().groups.find((g) => g.id === id)).toMatchObject({ name: 'Tres', hue: 5 })
  })
  it('asigna por conexión y por nombre; null quita; un grupo inexistente se ignora', () => {
    const id = s().createGroup('G')!
    s().moveContainers('local', ['web', 'db'], id)
    s().moveContainers('remoto', ['web'], id)
    expect(s().assign[assignKey('local', 'web')]).toBe(id)
    expect(s().assign[assignKey('remoto', 'db')]).toBeUndefined() // la asignación es por conexión
    s().moveContainers('local', ['web'], null)
    expect(s().assign[assignKey('local', 'web')]).toBeUndefined()
    s().moveContainers('local', ['nuevo'], 'fantasma')
    expect(s().assign[assignKey('local', 'nuevo')]).toBeUndefined()
  })
  it('borrar un grupo suelta a sus contenedores (no toca los de otros grupos)', () => {
    const a = s().createGroup('A')!
    const b = s().createGroup('B')!
    s().moveContainers('local', ['x'], a)
    s().moveContainers('local', ['y'], b)
    s().deleteGroup(a)
    expect(s().groups.map((g) => g.id)).toEqual([b])
    expect(s().assign[assignKey('local', 'x')]).toBeUndefined()
    expect(s().assign[assignKey('local', 'y')]).toBe(b)
  })
  it('color elegido de un stack y vuelta al automático', () => {
    s().setStackHue('tienda', 300)
    expect(s().stackHue.tienda).toBe(300)
    s().setStackHue('tienda', null)
    expect(s().stackHue.tienda).toBeUndefined()
  })
})

describe('persistencia', () => {
  it('cada cambio se guarda y loadGroups lo recupera', () => {
    const id = s().createGroup('Guardado')!
    s().moveContainers('local', ['web'], id)
    s().setStackHue('tienda', 200)
    const back = loadGroups()
    expect(back.groups).toEqual([{ id, name: 'Guardado', hue: GROUP_HUES[0] }])
    expect(back.assign[assignKey('local', 'web')]).toBe(id)
    expect(back.stackHue).toEqual({ tienda: 200 })
  })
  it('JSON corrupto, tipos raros o referencias colgantes NO rompen: se descarta solo lo inválido', () => {
    window.localStorage.setItem(GROUPS_KEY, '{no es json')
    expect(loadGroups()).toEqual({ groups: [], assign: {}, stackHue: {} })
    window.localStorage.setItem(GROUPS_KEY, JSON.stringify({
      groups: [{ id: 'ok', name: 'Bien', hue: 400 }, { id: 'ok', name: 'Repetido', hue: 1 }, { id: 5, name: 'x', hue: 1 }, { id: 'n', name: '', hue: 1 }, { id: 'b', name: '‮X', hue: 1 }, null, 'basura'],
      assign: { k1: 'ok', k2: 'fantasma', k3: 7 },
      stackHue: { a: 10, b: 'x', c: Number.NaN, d: -30 },
    }))
    const d = loadGroups()
    expect(d.groups).toEqual([{ id: 'ok', name: 'Bien', hue: 40 }])
    expect(d.assign).toEqual({ k1: 'ok' })
    expect(d.stackHue).toEqual({ a: 10, d: 330 })
    window.localStorage.setItem(GROUPS_KEY, '"un string"')
    expect(loadGroups()).toEqual({ groups: [], assign: {}, stackHue: {} })
  })
  it('con el almacenamiento bloqueado (SecurityError) sigue funcionando en memoria', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
    expect(() => s().createGroup('En memoria')).not.toThrow()
    expect(s().groups.map((g) => g.name)).toEqual(['En memoria'])
    expect(() => loadGroups()).not.toThrow()
  })
})

describe('F-7: longitud de nombres en caracteres Unicode', () => {
  it('un emoji cuenta como un carácter (igual que chars().count() del backend)', () => {
    // 40 emojis: 80 unidades UTF-16 pero 40 caracteres → válido
    const cuarenta = '😀'.repeat(MAX_GROUP_NAME)
    expect(validateGroupName(cuarenta, [])).toBeNull()
    expect(validateGroupName(cuarenta + '😀', [])).toBe(`Máximo ${MAX_GROUP_NAME} caracteres.`)
  })
})
