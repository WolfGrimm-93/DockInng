import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { policyDenied, toast } from '@/lib/toastStore'
import { Toaster } from './Toaster'

beforeEach(() => toast.clear())

describe('Toaster', () => {
  it('error = role alert; ok/warn = status; con subtexto y botón de cerrar', () => {
    render(<Toaster />)
    act(() => {
      toast.ok('Guardado')
      toast.err('Falló', { sub: 'detalle' })
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Falló')
    expect(screen.getByText('detalle')).toBeInTheDocument()
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('Guardado')
  })
  it('cierra a mano', async () => {
    const u = userEvent.setup()
    render(<Toaster />)
    act(() => void toast.warn('Aviso'))
    await u.click(screen.getByRole('button', { name: 'Cerrar aviso' }))
    expect(screen.queryByText('Aviso')).not.toBeInTheDocument()
  })
  it('auto-cierre: ok a 4500 ms, error a 8000 ms; hover pausa; el de política es persistente', () => {
    vi.useFakeTimers()
    try {
      render(<Toaster />)
      act(() => {
        toast.ok('a')
        toast.err('b')
        policyDenied('Eliminar', 'motivo')
      })
      act(() => { vi.advanceTimersByTime(4600) })
      expect(screen.queryByText('a')).not.toBeInTheDocument()
      expect(screen.getByText('b')).toBeInTheDocument()
      const b = screen.getByText('b').closest('.toast') as HTMLElement
      act(() => { b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); b.dispatchEvent(new Event('mouseenter')) })
      act(() => { vi.advanceTimersByTime(20000) })
      expect(screen.getByText('El motor de seguridad rechazó «Eliminar»')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Toaster: tope', () => {
  it('«+N más» con acciones accesibles y contador ×N', async () => {
    const u = userEvent.setup()
    render(<Toaster />)
    act(() => {
      for (let i = 0; i < 9; i++) toast.err(`fallo ${i}`)
      toast.err('igual'); toast.err('igual')
    })
    expect(screen.getByText('igual ×2')).toBeInTheDocument()
    expect(screen.getByText(/^\+\d+ más$/)).toBeInTheDocument()
    expect(screen.getAllByRole('alert').length).toBeLessThanOrEqual(5)
    await u.click(screen.getByRole('button', { name: 'Ver todas' }))
    expect(screen.getAllByRole('alert').length).toBe(10)
    expect(document.querySelector('.toasts')).toBeInTheDocument()
  })
})
