// Ciclo de foco de los diálogos base: al cerrar, el foco vuelve al disparador SOLO cuando #root ya no es inerte. Si la devolución
// ocurre mientras #root sigue inerte, el navegador descarta el foco y se pierde en el body (jsdom no aplica `inert`: se observa el orden).
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog'

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Abrir</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Título</DialogTitle>
          <DialogDescription>Descripción</DialogDescription>
          <button type="button">Dentro</button>
        </DialogContent>
      </Dialog>
    </>
  )
}

describe('ciclo de foco de los diálogos', () => {
  it('al cerrar con Escape, #root ya no es inerte cuando el foco vuelve al disparador', async () => {
    const root = document.createElement('div')
    root.id = 'root'
    document.body.append(root)
    const u = userEvent.setup()
    try {
      render(<Harness />, { container: root })
      const trigger = screen.getByRole('button', { name: 'Abrir' })
      const focus = HTMLElement.prototype.focus
      const inertAtTriggerFocus: boolean[] = []
      HTMLElement.prototype.focus = function (this: HTMLElement, opts?: FocusOptions) {
        if (this === trigger) inertAtTriggerFocus.push(root.inert)
        return focus.call(this, opts)
      }
      try {
        await u.click(trigger)
        await screen.findByRole('dialog')
        expect(root.inert).toBe(true)
        inertAtTriggerFocus.length = 0
        await u.keyboard('{Escape}')
        await waitFor(() => expect(screen.queryByText('Título')).toBeNull())
        await waitFor(() => expect(trigger).toHaveFocus())
        expect(inertAtTriggerFocus.length).toBeGreaterThan(0)
        expect(inertAtTriggerFocus.every((inert) => inert === false)).toBe(true)
      } finally {
        HTMLElement.prototype.focus = focus
      }
    } finally {
      root.remove()
    }
  })
})
