import { describe, expect, it } from 'vitest'
import { uuidv7 } from './uuid7'

describe('uuidv7', () => {
  it('tiene formato v7 y variante correcta', () => {
    const id = uuidv7()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('codifica la marca de tiempo en los primeros 48 bits y es ordenable', () => {
    const a = uuidv7(1_700_000_000_000)
    const b = uuidv7(1_700_000_000_001)
    expect(parseInt(a.replace('-', '').slice(0, 12), 16)).toBe(1_700_000_000_000)
    expect(a < b).toBe(true)
  })
  it('no repite ids', () => {
    expect(new Set(Array.from({ length: 200 }, () => uuidv7())).size).toBe(200)
  })
})
