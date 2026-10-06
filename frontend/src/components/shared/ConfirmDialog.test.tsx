import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createSimApi } from '@/data/adapters/sim'
import { EngineProvider } from '@/data/EngineProvider'
import type { ActionRequest } from '@/data/types'
import { getToasts, toast } from '@/lib/toastStore'
import { ConfirmProvider } from './ConfirmDialog'
import { blockedRequestFor } from './blockedText'
import { typedMatches, useBlockedDialog, useConfirm, type ConfirmRequest } from './confirmApi'
import { useGuardedAction, type GuardedResult } from './useGuardedAction'

beforeEach(() => toast.clear())

function ConfirmHarness({ req }: { req: ConfirmRequest }) {
  const confirm = useConfirm()
  const [r, setR] = useState('pendiente')
  return (
    <>
      <button onClick={async () => setR(String(await confirm(req)))}>abrir</button>
      <output data-testid="res">{r}</output>
    </>
  )
}
const mountConfirm = (req: ConfirmRequest) =>
  render(<ConfirmProvider><ConfirmHarness req={req} /></ConfirmProvider>)

const base: ConfirmRequest = { level: 'confirm', title: 'Eliminar red', description: <p>Se eliminará la red</p>, okLabel: 'Eliminar red' }

describe('typedMatches', () => {
  it('trim, exacto y sensible a mayúsculas', () => {
    expect(typedMatches('  ELIMINAR ', 'ELIMINAR')).toBe(true)
    expect(typedMatches('eliminar', 'ELIMINAR')).toBe(false)
    expect(typedMatches('', 'x')).toBe(false)
  })
})

describe('ConfirmDialog — nivel Confirmar', () => {
  it('foco inicial en «Cancelar»; Cancelar resuelve false', async () => {
    const u = userEvent.setup()
    mountConfirm(base)
    await u.click(screen.getByText('abrir'))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByRole('heading', { name: 'Eliminar red' })).toBeInTheDocument()
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Cancelar' })).toHaveFocus())
    expect(within(dlg).getByText(/Nivel Confirmar\./)).toBeInTheDocument()
    await u.click(within(dlg).getByRole('button', { name: 'Cancelar' }))
    await waitFor(() => expect(screen.getByTestId('res')).toHaveTextContent('false'))
  })
  it('Esc resuelve false y el botón de acción resuelve true', async () => {
    const u = userEvent.setup()
    mountConfirm(base)
    await u.click(screen.getByText('abrir'))
    await screen.findByRole('alertdialog')
    await u.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByTestId('res')).toHaveTextContent('false'))
    await u.click(screen.getByText('abrir'))
    await u.click(await screen.findByRole('button', { name: 'Eliminar red' }))
    await waitFor(() => expect(screen.getByTestId('res')).toHaveTextContent('true'))
  })
})

describe('ConfirmDialog — nivel Confirmar con nombre', () => {
  it('el botón queda deshabilitado hasta que el texto coincide (sensible a mayúsculas, con trim)', async () => {
    const u = userEvent.setup()
    mountConfirm({ ...base, level: 'confirm_typed', typed: 'ELIMINAR', title: 'Eliminar volúmenes sin usar', okLabel: 'Eliminar 2 volúmenes' })
    await u.click(screen.getByText('abrir'))
    const dlg = await screen.findByRole('alertdialog')
    const ok = within(dlg).getByRole('button', { name: 'Eliminar 2 volúmenes' })
    expect(ok).toBeDisabled()
    const input = within(dlg).getByLabelText(/Para confirmar, escribe/)
    await u.type(input, 'eliminar')
    expect(ok).toBeDisabled()
    await u.clear(input)
    await u.type(input, ' ELIMINAR ')
    expect(ok).toBeEnabled()
    await u.clear(input)
    await u.type(input, 'ELIMINA')
    expect(ok).toBeDisabled()
    await u.type(input, 'R{Enter}')
    await waitFor(() => expect(screen.getByTestId('res')).toHaveTextContent('true'))
  })
  it('Cancelar no exige escribir nada', async () => {
    const u = userEvent.setup()
    mountConfirm({ ...base, level: 'confirm_typed', typed: 'datos' })
    await u.click(screen.getByText('abrir'))
    await u.click(await screen.findByRole('button', { name: 'Cancelar' }))
    await waitFor(() => expect(screen.getByTestId('res')).toHaveTextContent('false'))
  })
})

describe('ConfirmDialog — nivel Bloqueado', () => {
  it('solo «Entendido»: sin botón destructivo', async () => {
    const u = userEvent.setup()
    function B() {
      const blocked = useBlockedDialog()
      return <button onClick={() => void blocked(blockedRequestFor('prune_system'))}>abrir</button>
    }
    render(<ConfirmProvider><B /></ConfirmProvider>)
    await u.click(screen.getByText('abrir'))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText('Limpiar todo el sistema está bloqueado')).toBeInTheDocument()
    expect(within(dlg).getByText(/Nivel Bloqueado\./)).toBeInTheDocument()
    expect(within(dlg).getAllByRole('button').map((b) => b.textContent)).toEqual(['Entendido'])
    await u.click(within(dlg).getByRole('button', { name: 'Entendido' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })
})

// ---- useGuardedAction: los 4 niveles según la decisión del backend (aquí, el adaptador simulado) ----
function GuardHarness({ request }: { request: ActionRequest }) {
  const run = useGuardedAction()
  const [r, setR] = useState<GuardedResult | null>(null)
  return (
    <>
      <button onClick={async () => setR(await run(request))}>ejecutar</button>
      <output data-testid="status">{r?.status ?? 'pendiente'}</output>
    </>
  )
}
async function mountGuard(request: ActionRequest) {
  const api = createSimApi({ latency: 0 })
  render(
    <EngineProvider api={api}>
      <ConfirmProvider><GuardHarness request={request} /></ConfirmProvider>
    </EngineProvider>,
  )
  // espera a que el store esté conectado
  await waitFor(() => expect(api.sim.world.containers.length).toBeGreaterThan(0))
  await new Promise((r) => setTimeout(r, 20))
  return api
}

describe('useGuardedAction (plan → diálogo → execute)', () => {
  it('F-1: execute_action se llama con confirmed=true solo tras confirmar en el diálogo', async () => {
    const u = userEvent.setup()
    const api = await mountGuard({ type: 'remove_containers', ids: ['minio-dev'] })
    const spy = vi.spyOn(api.actions, 'execute')
    await u.click(screen.getByText('ejecutar'))
    await u.click(await screen.findByRole('button', { name: 'Eliminar contenedor' }))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('done'))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][2]).toBe(true)
  })
  it('F-4: sin conexión se avisa con un toast (no se cancela en silencio)', async () => {
    const u = userEvent.setup()
    const api = await mountGuard({ type: 'remove_containers', ids: ['minio-dev'] })
    api.sim.emit({ type: 'connection', status: { state: 'failed', endpoint: 'x', cause: 'daemon_down', message: 'boom', steps: [] } })
    await u.click(screen.getByText('ejecutar'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('cancelled'))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(getToasts().some((t) => t.kind === 'warn' && /sin conexión/.test(t.msg))).toBe(true)
  })
  it('Libre (allow): sin diálogo', async () => {
    const u = userEvent.setup()
    await mountGuard({ type: 'remove_containers', ids: [] })
    await u.click(screen.getByText('ejecutar'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('allowed'))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
  it('Confirmar: eliminar contenedor en ejecución avisa de --force y ejecuta al confirmar', async () => {
    const u = userEvent.setup()
    const api = await mountGuard({ type: 'remove_containers', ids: ['tienda-postgres-1'] })
    await u.click(screen.getByText('ejecutar'))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText(/--force/)).toBeInTheDocument()
    expect(within(dlg).getByText('tienda_postgres-datos')).toBeInTheDocument()
    await u.click(within(dlg).getByRole('button', { name: 'Eliminar contenedor' }))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('done'))
    expect(api.sim.world.containers.some((c) => c.names[0] === 'tienda-postgres-1')).toBe(false)
  })
  it('Confirmar: cancelar libera el ticket y no elimina', async () => {
    const u = userEvent.setup()
    const api = await mountGuard({ type: 'remove_containers', ids: ['minio-dev'] })
    await u.click(screen.getByText('ejecutar'))
    await u.click(await screen.findByRole('button', { name: 'Cancelar' }))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('cancelled'))
    expect(api.sim.world.containers.some((c) => c.names[0] === 'minio-dev')).toBe(true)
  })
  it('Confirmar con nombre: eliminar volumen pide su nombre', async () => {
    const u = userEvent.setup()
    const api = await mountGuard({ type: 'remove_volume', name: 'respaldos-pg' })
    await u.click(screen.getByText('ejecutar'))
    const dlg = await screen.findByRole('alertdialog')
    const ok = within(dlg).getByRole('button', { name: 'Eliminar volumen' })
    expect(ok).toBeDisabled()
    await u.type(within(dlg).getByLabelText(/Para confirmar, escribe/), 'respaldos-pg')
    await u.click(ok)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('done'))
    expect(api.sim.world.volumes.some((v) => v.name === 'respaldos-pg')).toBe(false)
  })
  it('Bloqueado: «Limpiar todo el sistema» abre el diálogo bloqueado y no ejecuta nada', async () => {
    const u = userEvent.setup()
    await mountGuard({ type: 'prune_system' })
    await u.click(screen.getByText('ejecutar'))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText(/Nivel Bloqueado\./)).toBeInTheDocument()
    await u.click(within(dlg).getByRole('button', { name: 'Entendido' }))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('blocked'))
  })
})

describe('modalidad real del diálogo', () => {
  it('aria-modal, #root inert, trampa de Tab/Shift+Tab y retorno de foco al disparador', async () => {
    const u = userEvent.setup()
    const { container } = render(<div id="root"><ConfirmProvider><ConfirmHarness req={{ ...base, level: 'confirm_typed', typed: 'x' }} /></ConfirmProvider></div>)
    void container
    const root = document.getElementById('root')!
    const trigger = screen.getByText('abrir')
    await u.click(trigger)
    const dlg = await screen.findByRole('alertdialog')
    expect(dlg).toHaveAttribute('aria-modal', 'true')
    expect(root.inert).toBe(true)
    const cancel = within(dlg).getByRole('button', { name: 'Cancelar' })
    await waitFor(() => expect(cancel).toHaveFocus())
    // Tab recorre solo el diálogo: Cancelar -> input -> (Eliminar deshabilitado se salta) -> vuelve a Cancelar
    const inside = () => dlg.contains(document.activeElement)
    for (let i = 0; i < 6; i++) {
      await u.tab()
      expect(inside()).toBe(true)
    }
    for (let i = 0; i < 6; i++) {
      await u.tab({ shift: true })
      expect(inside()).toBe(true)
    }
    await u.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(root.inert).toBe(false)
    await waitFor(() => expect(trigger).toHaveFocus())
  })
  it('un expected vacío nunca habilita el botón; se muestra lo que dice `expected`', async () => {
    const u = userEvent.setup()
    mountConfirm({ ...base, level: 'confirm_typed', typed: '', okLabel: 'Eliminar' })
    await u.click(screen.getByText('abrir'))
    expect(await screen.findByRole('button', { name: 'Eliminar' })).toBeDisabled()
    expect(typedMatches('', '')).toBe(false)
  })
  it('un nombre de 10 000 caracteres: se muestra completo en title y hay botón de copiar; sin desbordar', async () => {
    const u = userEvent.setup()
    const long = 'n'.repeat(10_000)
    mountConfirm({ ...base, level: 'confirm_typed', typed: long, okLabel: 'Eliminar' })
    await u.click(screen.getByText('abrir'))
    const b = await screen.findByTitle(long)
    expect(b).toHaveClass('typed-exp')
    expect(screen.getByRole('button', { name: 'Copiar el texto de confirmación' })).toBeInTheDocument()
    await u.type(screen.getByLabelText(/Para confirmar/), 'x')
    expect(screen.getByRole('button', { name: 'Eliminar' })).toBeDisabled()
  })
  it('un expected con bidi se muestra saneado pero se compara exacto', () => {
    expect(typedMatches('a‮b', 'a‮b')).toBe(true)
    expect(typedMatches('ab', 'a‮b')).toBe(false)
  })
})

describe('ConfirmDialog — bloqueo por tipo (F-3)', () => {
  it('una acción distinta de «Limpiar todo» muestra su propio título, sin lista de alternativas vacía', async () => {
    const u = userEvent.setup()
    function B() {
      const blocked = useBlockedDialog()
      return <button onClick={() => void blocked(blockedRequestFor('remove_volume'))}>abrir</button>
    }
    render(<ConfirmProvider><B /></ConfirmProvider>)
    await u.click(screen.getByText('abrir'))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText('Eliminar volumen está bloqueado')).toBeInTheDocument()
    expect(within(dlg).queryByText('Limpiar todo el sistema está bloqueado')).not.toBeInTheDocument()
    expect(within(dlg).queryByRole('list')).not.toBeInTheDocument()
    expect(within(dlg).getByText(/no ejecuta esta acción en ningún caso/)).toBeInTheDocument()
  })
  it('sin argumentos muestra un texto genérico, no el de «Limpiar todo el sistema»', async () => {
    const u = userEvent.setup()
    function B() {
      const blocked = useBlockedDialog()
      return <button onClick={() => void blocked()}>abrir</button>
    }
    render(<ConfirmProvider><B /></ConfirmProvider>)
    await u.click(screen.getByText('abrir'))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText('Acción bloqueada')).toBeInTheDocument()
    expect(within(dlg).queryByRole('list')).not.toBeInTheDocument()
  })
})

describe('ConfirmDialog — copiar (F-5)', () => {
  it('copiar: toast de éxito; si el portapapeles falla, toast de error', async () => {
    const u = userEvent.setup()
    const long = 'x'.repeat(30)
    mountConfirm({ ...base, level: 'confirm_typed', typed: long })
    await u.click(screen.getByText('abrir'))
    const dlg = await screen.findByRole('alertdialog')
    const copy = within(dlg).getByRole('button', { name: 'Copiar el texto de confirmación' })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await u.click(copy)
    await waitFor(() => expect(getToasts().some((t) => t.kind === 'ok' && t.msg === 'Texto copiado')).toBe(true))
    expect(writeText).toHaveBeenCalledWith(long)
    writeText.mockRejectedValueOnce(new Error('denegado'))
    await u.click(copy)
    await waitFor(() => expect(getToasts().some((t) => t.kind === 'err' && t.msg === 'No se pudo copiar el texto')).toBe(true))
  })
})
