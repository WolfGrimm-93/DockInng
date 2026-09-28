import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { Providers } from '@/app/providers'
import { useUiStore } from '@/app/uiStore'
import { createSimApi } from '@/data/adapters/sim'
import { useBlockedDialog } from './confirmApi'

function OpenBlocked() {
  const b = useBlockedDialog()
  return <button onClick={() => void b()}>bloquear</button>
}
const mount = () => {
  const api = createSimApi({ latency: 0 })
  render(<Providers api={api}><OpenBlocked /></Providers>)
  return api
}

beforeEach(() => {
  window.location.hash = ''
  useUiStore.setState({ paletteOpen: false })
})

describe('CommandPalette', () => {
  it('Ctrl+K abre con ARIA de combobox/listbox y navega con flechas + Enter', async () => {
    const u = userEvent.setup()
    mount()
    await u.keyboard('{Control>}k{/Control}')
    const input = await screen.findByRole('combobox', { name: 'Buscar comando' })
    expect(input).toHaveAttribute('aria-autocomplete', 'list')
    expect(input).toHaveAttribute('aria-controls', 'palList')
    expect(input).toHaveFocus()
    const list = screen.getByRole('listbox', { name: 'Resultados' })
    const opts = within(list).getAllByRole('option')
    expect(opts[0]).toHaveAttribute('aria-selected', 'true')
    expect(input).toHaveAttribute('aria-activedescendant', 'pal-0')
    await u.keyboard('{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant', 'pal-1')
    await u.keyboard('{Enter}')
    await waitFor(() => expect(window.location.hash).toBe('#images'))
    await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument())
  })
  it('filtra, busca contenedores por nombre y muestra «Sin resultados»', async () => {
    const u = userEvent.setup()
    mount()
    await new Promise((r) => setTimeout(r, 30))
    await u.keyboard('{Control>}k{/Control}')
    const input = await screen.findByRole('combobox')
    await u.type(input, 'redis')
    expect(await screen.findByRole('option', { name: /Ir al contenedor tienda-redis-1/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Detener tienda-redis-1/ })).toBeInTheDocument()
    await u.clear(input)
    await u.type(input, 'zzzz-nada')
    expect(await screen.findByText('Sin resultados')).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })
  it('Ctrl+K se ignora si ya hay un diálogo abierto', async () => {
    const u = userEvent.setup()
    mount()
    await u.click(screen.getByText('bloquear'))
    await screen.findByRole('alertdialog')
    await u.keyboard('{Control>}k{/Control}')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(useUiStore.getState().paletteOpen).toBe(false)
  })
  it('«Limpiar todo el sistema» abre el diálogo Bloqueado', async () => {
    const u = userEvent.setup()
    mount()
    act(() => useUiStore.getState().openPalette(true))
    await u.type(await screen.findByRole('combobox'), 'limpiar')
    await u.click(await screen.findByRole('option', { name: /Limpiar todo el sistema/ }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Nivel Bloqueado')
  })
})
