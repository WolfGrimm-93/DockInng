import { describe, expect, it } from 'vitest'
import { validateCompose } from './yamlCheck'

describe('validateCompose', () => {
  it('acepta un compose correcto', () => {
    const r = validateCompose('services:\n  web:\n    image: nginx\n', '')
    expect(r.hasBad).toBe(false)
    expect(r.list[0].l).toBe('ok')
  })
  it('detecta tabuladores, servicio sin image y variables sin definir', () => {
    const r = validateCompose('services:\n  web:\n\tports:\n      - "80:80"\n  api:\n    environment:\n      P: ${API_PORT}\n', '')
    expect(r.hasBad).toBe(true)
    expect(r.bad[3]).toBe(1)
    expect(r.list.some((o) => o.msg.includes('necesita image'))).toBe(true)
    expect(r.list.some((o) => o.l === 'warn' && o.msg.includes('API_PORT'))).toBe(true)
  })
})
