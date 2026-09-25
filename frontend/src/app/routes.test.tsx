import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NAV, NAV_OF, TITLES, buildHref, isRouteId, parseRoute } from './routes'
import { useHashRoute } from './useHashRoute'

afterEach(() => {
  window.location.hash = ''
})

describe('routes', () => {
  it('parseRoute conserva vista y parámetros del hash; hash vacío o desconocido -> containers', () => {
    const r = parseRoute('#detail?c=tienda-api-1&tab=logs')
    expect(r.id).toBe('detail')
    expect(r.params.get('c')).toBe('tienda-api-1')
    expect(r.params.get('tab')).toBe('logs')
    expect(parseRoute('').id).toBe('containers')
    expect(parseRoute('#nope').id).toBe('containers')
  })
  it('location.search es respaldo y el hash gana', () => {
    const r = parseRoute('#create?image=redis', '?image=nginx&remote=1')
    expect(r.params.get('image')).toBe('redis')
    expect(r.params.get('remote')).toBe('1')
    expect(parseRoute('', '?view=images').id).toBe('images')
  })
  it('buildHref codifica y omite vacíos (ida y vuelta con nombres raros)', () => {
    const c = 'x"><img src=x onerror=1>&a=b'
    const h = buildHref('detail', { c, tab: undefined })
    expect(h.startsWith('#detail?c=')).toBe(true)
    expect(parseRoute(h).params.get('c')).toBe(c)
    expect(buildHref('images')).toBe('#images')
  })
  it('tablas: 11 rutas, mismos títulos y NAV_OF que la plantilla', () => {
    expect(Object.keys(TITLES)).toHaveLength(11)
    expect(TITLES['stack-edit']).toBe('Editar stack')
    expect(NAV_OF).toMatchObject({ detail: 'containers', create: 'containers', pull: 'images', 'stack-edit': 'stacks', 'conn-new': 'settings' })
    expect(NAV.map((n) => n.group)).toEqual(['Docker', 'Docker', 'Docker', 'Docker', 'Docker', 'Aplicación'])
    expect(isRouteId('volumes')).toBe(true)
    expect(isRouteId('x')).toBe(false)
  })
  it('useHashRoute reacciona a hashchange y go() cambia el hash', () => {
    const { result } = renderHook(() => useHashRoute())
    expect(result.current.id).toBe('containers')
    act(() => {
      result.current.go('detail', { c: 'a b' })
    })
    // jsdom emite hashchange de forma asíncrona
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(result.current.id).toBe('detail')
        expect(result.current.params.get('c')).toBe('a b')
        resolve()
      }, 20),
    )
  })
})
