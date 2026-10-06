// Asignaciones huérfanas: solo se marcan las de la conexión dada y que ya no aparecen en el listado completo.
import { describe, expect, it } from 'vitest'
import { assignKey, orphanNames } from './groupsStore'

describe('orphanNames', () => {
  const assign = {
    [assignKey('local', 'web')]: 'g1',
    [assignKey('local', 'viejo')]: 'g1',
    [assignKey('remoto', 'viejo')]: 'g2',
  }
  it('devuelve solo los nombres de esa conexión que ya no están en el listado', () => {
    expect(orphanNames(assign, 'local', ['web', 'nuevo'])).toEqual(['viejo'])
  })
  it('sin huérfanos devuelve lista vacía; no toca otras conexiones', () => {
    expect(orphanNames(assign, 'local', ['web', 'viejo'])).toEqual([])
    expect(orphanNames(assign, 'remoto', [])).toEqual(['viejo'])
  })
})
