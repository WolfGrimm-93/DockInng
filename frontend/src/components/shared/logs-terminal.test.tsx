import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { createSimApi } from '@/data/adapters/sim'
import { EngineProvider } from '@/data/EngineProvider'
import type { LogFeed, LogLine } from '@/data/types'
import { LogViewer } from './LogViewer'
import { Sparkline } from './Sparkline'
import { LayerProgress } from './LayerProgress'
import { appendRing, useLogStream } from './useLogStream'

const line = (message: string, stream: LogLine['stream'] = 'stdout'): LogLine => ({ stream, timestamp: '2026-09-24T14:02:11.037Z', message, truncated: false })

describe('appendRing', () => {
  it('mantiene solo las últimas N líneas (buffer circular)', () => {
    const big = Array.from({ length: 4990 }, (_, i) => i)
    const out = appendRing(big, Array.from({ length: 20 }, (_, i) => 10000 + i), 5000)
    expect(out).toHaveLength(5000)
    expect(out.at(-1)).toBe(10019)
    expect(out[0]).toBe(10)
  })
})

describe('LogViewer', () => {
  it('pinta nivel por clase, filtra por nivel y texto, y expone role=log con aria-live=off', () => {
    const lines = [line('[INFO] arrancó'), line('[WARN] lento'), line('[ERROR] cayó la conexión'), line('[DEBUG] cache hit')]
    const { rerender } = render(<LogViewer lines={lines} follow={false} label="Logs de x" />)
    const log = screen.getByRole('log', { name: 'Logs de x' })
    expect(log).toHaveAttribute('aria-live', 'off')
    expect(screen.getByText('cayó la conexión').closest('.log-line')).toHaveClass('is-error')
    expect(screen.getByText('ERROR')).toHaveClass('lvl-error')
    rerender(<LogViewer lines={lines} follow={false} level="WARN" label="Logs de x" />)
    expect(screen.queryByText('arrancó')).not.toBeInTheDocument()
    expect(screen.getByText('lento')).toBeInTheDocument()
    rerender(<LogViewer lines={lines} follow={false} query="CACHE" label="Logs de x" />)
    expect(screen.getByText('cache hit')).toBeInTheDocument()
    expect(screen.queryByText('lento')).not.toBeInTheDocument()
  })
})

describe('useLogStream + adaptador simulado', () => {
  it('recibe las líneas del tail y termina con eof si no se sigue', async () => {
    const api = createSimApi({ latency: 0 })
    const id = api.sim.world.containers[1].id
    const wrapper = ({ children }: { children: ReactNode }) => <EngineProvider api={api}>{children}</EngineProvider>
    const { result } = renderHook(() => useLogStream(id, { tail: 5, follow: false }), { wrapper })
    await waitFor(() => expect(result.current.lines).toHaveLength(5))
    await waitFor(() => expect(result.current.ended).toBe('eof'))
  })
})

describe('Sparkline y LayerProgress', () => {
  it('Sparkline es un img con etiqueta; LayerProgress expone progressbar por capa', () => {
    render(
      <>
        <Sparkline values={[1, 50, 100]} color="var(--chart-1)" label="Uso de CPU" />
        <LayerProgress pulling layers={[
          { id: 'a3b8c1d92e07', phase: 'complete', total: 3002106, done: 3002106 },
          { id: '5f1e9a7b3c42', phase: 'waiting', total: 0, done: 0 },
          { id: 'c8e91746bdfc', phase: 'downloading', total: 0, done: 1048576 },
          { id: '648890eaed45', phase: 'extracting', total: 5001771, done: 5001771 },
        ]} />
      </>,
    )
    expect(screen.getByRole('img', { name: 'Uso de CPU' })).toBeInTheDocument()
    const bars = screen.getAllByRole('progressbar')
    expect(bars[0]).toHaveAttribute('aria-valuenow', '100')
    expect(bars[0]).toHaveClass('is-done')
    expect(screen.getByText('En espera')).toBeInTheDocument()
    expect(screen.getByText('2.9 MiB / 2.9 MiB')).toBeInTheDocument()
    // Total desconocido: barra indeterminada (sin aria-valuenow) y «Calculando…»; extrayendo también es indeterminada.
    expect(bars[2]).not.toHaveAttribute('aria-valuenow')
    expect(screen.getByText('Calculando…')).toBeInTheDocument()
    expect(screen.getByText('Extrayendo')).toBeInTheDocument()
    act(() => {})
  })
})

import { pushPending, LOG_PENDING_MAX } from './useLogStream'
import { vi } from 'vitest'

describe('useLogStream: ventana oculta y tope de pendientes', () => {
  it('pushPending descarta lo más antiguo y cuenta lo omitido', () => {
    const p: number[] = []
    expect(pushPending(p, [1, 2, 3], 5)).toBe(0)
    expect(pushPending(p, [4, 5, 6, 7], 5)).toBe(2)
    expect(p).toEqual([3, 4, 5, 6, 7])
    expect(LOG_PENDING_MAX).toBeGreaterThan(1000)
  })
  it('con rAF muerto (pestaña oculta) el timer de respaldo vuelca y `dropped` refleja lo descartado', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    const api = createSimApi({ latency: 0 })
    let push: (f: LogFeed) => void = () => {}
    api.containers.streamLogs = (_id, _o, on) => { push = on; return () => {} }
    const wrapper = ({ children }: { children: ReactNode }) => <EngineProvider api={api}>{children}</EngineProvider>
    const { result } = renderHook(() => useLogStream('abc', { max: 100 }), { wrapper })
    const burst = Array.from({ length: LOG_PENDING_MAX + 500 }, (_, i) => line(`[INFO] l${i}`))
    act(() => push({ type: 'lines', lines: burst, dropped: 7 }))
    await waitFor(() => expect(result.current.lines.length).toBe(100), { timeout: 2000 })
    expect(result.current.dropped).toBe(7 + 500)
    expect(result.current.lines.at(-1)?.message).toBe(`[INFO] l${LOG_PENDING_MAX + 499}`)
    raf.mockRestore()
  })
})
