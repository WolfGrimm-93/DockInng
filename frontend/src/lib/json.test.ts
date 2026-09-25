import { describe, expect, it } from 'vitest'
import { tokenizeJson } from './json'

describe('tokenizeJson', () => {
  it('la concatenación de tokens reproduce el JSON exacto (sin perder ni inventar texto)', () => {
    const v = { a: 'x"><img src=x onerror=alert(1)>', n: [1, 2.5, -3], ok: true, z: null }
    expect(tokenizeJson(v).map((t) => t.text).join('')).toBe(JSON.stringify(v, null, 2))
  })
  it('clasifica claves, cadenas, números y booleanos', () => {
    const t = tokenizeJson({ k: 'v', n: 1, b: false })
    expect(t.filter((x) => x.kind === 'k').map((x) => x.text)).toEqual(['"k"', '"n"', '"b"'])
    expect(t.find((x) => x.kind === 's')?.text).toBe('"v"')
    expect(t.find((x) => x.kind === 'n')?.text).toBe('1')
    expect(t.find((x) => x.kind === 'b')?.text).toBe('false')
  })
})
