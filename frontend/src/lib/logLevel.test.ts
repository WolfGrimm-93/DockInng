import { describe, expect, it } from 'vitest'
import { detectLogLevel, parseLogLine, splitLevelPrefix } from './logLevel'

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
