import { describe, expect, it } from 'vitest'
import { formatBytesSI, formatBytes, formatMB, relativeTimeEs, shortId, statusTextEs, truncateMiddle } from './format'

describe('format', () => {
  it('formatMB usa GB desde 1024 MB', () => {
    expect(formatMB(412)).toBe('412 MB')
    expect(formatMB(1843)).toBe('1.8 GB')
    expect(formatBytes(5530 * 1024 * 1024)).toBe('5.4 GB')
  })
  it('relativeTimeEs: textos exactos de la plantilla', () => {
    const now = 1_700_000_000_000
    const ago = (sec: number) => relativeTimeEs(now / 1000 - sec, now)
    expect(ago(5)).toBe('hace un momento')
    expect(ago(300)).toBe('hace 5 min')
    expect(ago(2 * 3600)).toBe('hace 2 h')
    expect(ago(86400)).toBe('hace 1 día')
    expect(ago(3 * 86400)).toBe('hace 3 días')
    expect(ago(12 * 86400)).toBe('hace 12 días')
    expect(ago(14 * 86400)).toBe('hace 2 semanas')
    expect(ago(35 * 86400)).toBe('hace 5 semanas')
    expect(ago(56 * 86400)).toBe('hace 8 semanas')
    expect(ago(120 * 86400)).toBe('hace 4 meses')
    expect(ago(800 * 86400)).toBe('hace 2 años')
  })
  it('statusTextEs con los textos de la plantilla', () => {
    expect(statusTextEs('Up 3 days')).toBe('hace 3 días')
    expect(statusTextEs('Up 6 days (Paused)')).toBe('en pausa')
    expect(statusTextEs('Up About an hour')).toBe('hace 1 h')
    expect(statusTextEs('Up Less than a second')).toBe('hace un momento')
    expect(statusTextEs('Exited (0) 2 hours ago')).toBe('salió (0) hace 2 h')
    expect(statusTextEs('Exited (137) 1 day ago')).toBe('salió (137) hace 1 día')
    expect(statusTextEs('Exited (0) Less than a second ago')).toBe('salió (0) ahora')
    expect(statusTextEs('Restarting (3) 5 seconds ago')).toBe('reiniciando (3)')
    expect(statusTextEs('Created')).toBe('sin iniciar')
    expect(statusTextEs('Dead')).toBe('error al detener')
    expect(statusTextEs('algo raro')).toBe('algo raro')
  })
  it('formatBytesSI: unidades decimales de la plantilla', () => {
    expect(formatBytesSI(184_000_000)).toBe('184 MB')
    expect(formatBytesSI(1_200_000)).toBe('1.2 MB')
    expect(formatBytesSI(640_000)).toBe('640 KB')
    expect(formatBytesSI(1_900_000_000)).toBe('1.9 GB')
    expect(formatBytesSI(96_000_000)).toBe('96 MB')
    expect(formatBytesSI(0)).toBe('0 B')
  })
  it('truncateMiddle y shortId', () => {
    expect(truncateMiddle('abcdefghij', 6)).toBe('abc…ij')
    expect(shortId('sha256:0123456789abcdef')).toBe('0123456789ab')
  })
})
