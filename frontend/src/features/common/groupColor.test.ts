import { describe, expect, it } from 'vitest'
import { assignGroupHues, GROUP_HUES } from './groupColor'

describe('assignGroupHues', () => {
  it('da un matiz distinto a cada stack mientras haya 8 o menos', () => {
    const m = assignGroupHues(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    expect(new Set(m.values()).size).toBe(8)
    for (const h of m.values()) expect(GROUP_HUES).toContain(h)
  })

  it('es estable: no depende del orden de entrada ni de duplicados', () => {
    const a = assignGroupHues(['proyecto-uno', 'proyecto-dos', 'proyecto-tres'])
    const b = assignGroupHues(['proyecto-tres', 'proyecto-uno', 'proyecto-uno', 'proyecto-dos'])
    expect([...a].sort()).toEqual([...b].sort())
  })

  it('con más de 8 stacks reutiliza matices sin fallar', () => {
    const names = Array.from({ length: 20 }, (_, i) => `stack-${i}`)
    const m = assignGroupHues(names)
    expect(m.size).toBe(20)
    for (const h of m.values()) expect(GROUP_HUES).toContain(h)
  })
})
