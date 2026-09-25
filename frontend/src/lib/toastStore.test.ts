import { beforeEach, describe, expect, it } from 'vitest'
import { getToasts, policyDenied, toast } from './toastStore'

beforeEach(() => toast.clear())

describe('toastStore', () => {
  it('ids UUID v7, dismiss y tope de 5 visibles', () => {
    const id = toast.ok('a')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    toast.dismiss(id)
    expect(getToasts()).toHaveLength(0)
    for (let i = 0; i < 8; i++) toast.warn(`w${i}`)
    expect(getToasts()).toHaveLength(5)
    expect(getToasts()[0].msg).toBe('w3')
  })
  it('el tope expulsa informativos primero: errores y sticky sobreviven', () => {
    toast.err('E1')
    policyDenied('X', 'motivo')
    for (let i = 0; i < 10; i++) toast.ok(`o${i}`)
    const msgs = getToasts().map((t) => t.msg)
    expect(msgs).toContain('E1')
    expect(msgs.some((m) => m.includes('rechazó'))).toBe(true)
    expect(getToasts()).toHaveLength(5)
    expect(msgs.at(-1)).toBe('o9')
    // solo errores: no se pierde ninguno
    toast.clear()
    for (let i = 0; i < 7; i++) toast.err(`e${i}`)
    expect(getToasts()).toHaveLength(6) // 5 + «+2 más»: ninguno se pierde
    toast.expandAll()
    expect(getToasts()).toHaveLength(7)
  })
  it('sanea bidi/controles en msg y sub', () => {
    toast.ok('foto\u202Egpj.exe', { sub: 'a\u0000b' })
    expect(getToasts()[0]).toMatchObject({ msg: 'fotogpj.exe', sub: 'ab' })
  })
  it('policyDenied es un error persistente con el motivo', () => {
    policyDenied('Eliminar volumen', 'no permitido')
    const t = getToasts()[0]
    expect(t).toMatchObject({ kind: 'err', sticky: true, sub: 'no permitido' })
    expect(t.msg).toBe('El motor de seguridad rechazó «Eliminar volumen»')
  })
})

describe('tope total y colapso', () => {
  it('20 errores idénticos = un toast ×20', () => {
    for (let i = 0; i < 20; i++) toast.err('No se pudo iniciar x', { sub: 'puerto ocupado' })
    expect(getToasts()).toHaveLength(1)
    expect(getToasts()[0].count).toBe(20)
  })
  it('20 errores distintos: máx. 6 visibles con «+N más»; Ver todas / Descartar', () => {
    for (let i = 0; i < 20; i++) toast.err(`error ${i}`)
    let v = getToasts()
    expect(v).toHaveLength(6)
    expect(v[0]).toMatchObject({ overflow: 15, msg: '+15 más' })
    expect(v.at(-1)?.msg).toBe('error 19')
    toast.expandAll()
    expect(getToasts()).toHaveLength(20)
    toast.clear()
    for (let i = 0; i < 20; i++) toast.err(`error ${i}`)
    toast.dismissHidden()
    v = getToasts()
    expect(v).toHaveLength(5)
    expect(v.some((t) => t.overflow)).toBe(false)
  })
})
