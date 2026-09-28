import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

const orig = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(() => {
  if (orig) Object.defineProperty(navigator, 'clipboard', orig)
  else Reflect.deleteProperty(navigator, 'clipboard')
  Reflect.deleteProperty(document, 'execCommand')
})
const setClipboard = (v: unknown) => Object.defineProperty(navigator, 'clipboard', { value: v, configurable: true })

describe('copyText', () => {
  it('usa navigator.clipboard cuando existe', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    expect(await copyText('localhost:8080')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('localhost:8080')
  })
  it('si la API moderna rechaza, cae al respaldo execCommand (textarea fuera de pantalla que se elimina)', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    let copied = ''
    document.execCommand = vi.fn(() => { copied = (document.querySelector('textarea') as HTMLTextAreaElement).value; return true })
    expect(await copyText('8080')).toBe(true)
    expect(copied).toBe('8080')
    expect(document.querySelector('textarea')).toBeNull()
  })
  it('sin API moderna usa el respaldo; si tampoco funciona devuelve false sin lanzar', async () => {
    setClipboard(undefined)
    document.execCommand = vi.fn(() => false)
    expect(await copyText('x')).toBe(false)
    document.execCommand = vi.fn(() => { throw new Error('boom') })
    expect(await copyText('x')).toBe(false)
    Reflect.deleteProperty(document, 'execCommand')
    expect(await copyText('x')).toBe(false)
  })
})
