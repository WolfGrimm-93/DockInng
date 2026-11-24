import { describe, expect, it } from 'vitest'
import { cleanLogText, detectLogLevel, parseLogLine, splitLevelPrefix } from './logLevel'

describe('detectLogLevel', () => {
  it('reconoce niveles por prefijo', () => {
    expect(detectLogLevel('ERROR ECONNRESET')).toBe('ERROR')
    expect(detectLogLevel('[warn] disco casi lleno')).toBe('WARN')
    expect(detectLogLevel('DEBUG cache hit')).toBe('DEBUG')
  })
  it('stderr sin nivel cuenta como WARN, stdout como INFO', () => {
    expect(detectLogLevel('algo ocurrió', 'stderr')).toBe('WARN')
    expect(detectLogLevel('GET / 200', 'stdout')).toBe('INFO')
  })
  it('splitLevelPrefix y parseLogLine', () => {
    expect(splitLevelPrefix('[WARN] disco')).toEqual({ level: 'WARN', body: 'disco' })
    expect(splitLevelPrefix('sin nivel')).toEqual({ level: null, body: 'sin nivel' })
    const l = parseLogLine({ stream: 'stdout', timestamp: '2026-09-24T14:02:11.037Z', message: '[ERROR] fallo' })
    expect(l.level).toBe('ERROR')
    expect(l.body).toBe('fallo')
    expect(l.ts).toMatch(/^\d\d:\d\d:\d\d\.037$/)
  })
})

describe('saneado de logs (M8)', () => {
  it('quita secuencias ANSI (CSI, OSC y escapes sueltos) sin dejar basura', () => {
    expect(cleanLogText('\u001B[31mrojo\u001B[0m y \u001B[1;32mverde\u001B[K')).toBe('rojo y verde')
    expect(cleanLogText('\u001B]0;título\u0007hola')).toBe('hola')
    expect(cleanLogText('\u001B]8;;http://x\u001B\\enlace\u001B]8;;\u001B\\')).toBe('enlace')
  })
  it('quita controles bidi y de control; conserva tabulaciones', () => {
    expect(cleanLogText('a‮b⁦c\u0000d\te')).toBe('abcd\te')
  })
  it('parseLogLine detecta el nivel y devuelve el cuerpo ya limpio', () => {
    const l = parseLogLine({ stream: 'stdout', timestamp: null, message: '\u001B[31m[ERROR]\u001B[0m ‮fallo' })
    expect(l.level).toBe('ERROR')
    expect(l.body).toBe('fallo')
  })
})
