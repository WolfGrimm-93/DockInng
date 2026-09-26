// Nueva conexión y configuración (lo SIMULADO lleva la marca). Stacks, editor, crear, pull y terminal: ver sus propios tests.
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import ConnNewPage from './settings/ConnNewPage'
import SettingsPage from './settings/SettingsPage'
import { makeApi, renderView, resetGlobals } from './testUtils'

afterEach(resetGlobals)

describe('ConnNewPage (simulada)', () => {
  it('probar conexión: éxito y fallo (el host con «fail» falla y bloquea Guardar)', async () => {
    const u = userEvent.setup()
    renderView(<ConnNewPage />, { hash: '#conn-new' })
    expect(await screen.findByText('Sin probar todavía.')).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Probar conexión' }))
    expect(await screen.findByText('Probando conexión…')).toBeInTheDocument()
    expect(await screen.findByText('Conexión correcta', undefined, { timeout: 4000 })).toBeInTheDocument()
    await u.clear(screen.getByLabelText(/^Host/))
    await u.type(screen.getByLabelText(/^Host/), 'fail-host')
    await u.click(screen.getByRole('button', { name: 'Probar conexión' }))
    expect(await screen.findByText('No se pudo conectar', undefined, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Guardar conexión' })).toBeDisabled()
  })
  it('cambiar a TLS muestra certificados y puerto 2376; guardar vuelve a Configuración', async () => {
    const u = userEvent.setup()
    renderView(<ConnNewPage />, { hash: '#conn-new' })
    await u.click(await screen.findByRole('button', { name: 'TLS (tcp://)' }))
    expect(screen.getByLabelText('Certificado CA')).toBeInTheDocument()
    expect((screen.getByLabelText('Puerto') as HTMLInputElement).value).toBe('2376')
    await u.click(screen.getByRole('button', { name: 'Guardar conexión' }))
    await waitFor(() => expect(window.location.hash).toBe('#settings'))
  })
  it('?test=fail fija el resultado y marca el origen simulado', async () => {
    renderView(<ConnNewPage />, { hash: '#conn-new?test=fail' })
    expect(await screen.findByText('No se pudo conectar')).toBeInTheDocument()
    expect(screen.getByText('No conectado aún')).toBeInTheDocument()
  })
})

describe('SettingsPage', () => {
  it('conexiones (local activa, resto simuladas), niveles de seguridad y sondeo de respaldo apagado, cada uno en su pestaña', async () => {
    const u = userEvent.setup()
    renderView(<SettingsPage />, { hash: '#settings' })
    // Pestaña por defecto: Conexiones.
    expect(await screen.findByText('Activa')).toBeInTheDocument()
    expect(screen.getByText('3 conexiones')).toBeInTheDocument()
    expect(screen.getByText('prod-hetzner')).toBeInTheDocument()
    expect(screen.getAllByText('No conectado aún').length).toBeGreaterThan(0)
    await u.click(screen.getByRole('tab', { name: 'Seguridad' }))
    expect(await screen.findByText('Confirmar con nombre')).toBeInTheDocument()
    expect(screen.getByText('Bloqueado')).toBeInTheDocument()
    await u.click(screen.getByRole('tab', { name: 'Datos' }))
    const sw = await screen.findByRole('switch', { name: 'Respaldo: sondeo cada 5 segundos' })
    expect(sw).not.toBeChecked()
    await u.click(sw)
    expect(sw).toBeChecked()
    await u.click(sw)
  })
  it('incluye la sección de Apariencia de la base (pestaña Apariencia)', async () => {
    renderView(<SettingsPage />, { hash: '#settings?tab=appearance' })
    expect(await screen.findByRole('heading', { name: 'Apariencia' })).toBeInTheDocument()
  })
  it('«Limpiar todo el sistema» pasa por la política y se muestra BLOQUEADO', async () => {
    const u = userEvent.setup()
    renderView(<SettingsPage />, { hash: '#settings?tab=security' })
    await u.click(await screen.findByRole('button', { name: 'Limpiar todo el sistema' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText('Limpiar todo el sistema está bloqueado')).toBeInTheDocument()
    await u.click(within(dlg).getByRole('button', { name: 'Entendido' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })
  it('sin conexión al motor sigue funcionando y avisa', async () => {
    const api = makeApi()
    renderView(<SettingsPage />, { api, hash: '#settings' })
    await screen.findByText('Activa')
    act(() => api.sim.emit({ type: 'connection', status: { state: 'failed', endpoint: 'x', cause: 'other', message: 'x', steps: [] } }))
    expect(await screen.findByText('Sin conexión con el motor')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Añadir conexión' })).toHaveAttribute('href', '#conn-new')
  })

  describe('pestañas', () => {
    it('hay 5 pestañas y solo se pinta el contenido de la activa', async () => {
      renderView(<SettingsPage />, { hash: '#settings' })
      const tabs = await screen.findAllByRole('tab')
      expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Conexiones', 'Apariencia', 'Grupos', 'Seguridad', 'Datos'])
      expect(screen.getByRole('tab', { name: 'Conexiones' })).toHaveAttribute('aria-selected', 'true')
      // Lo de otras pestañas no está en la página.
      expect(screen.queryByRole('heading', { name: 'Niveles de seguridad' })).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Grupos propios' })).toBeNull()
    })
    it('enlace directo: ?tab=groups abre Grupos; un valor inválido cae a Conexiones', async () => {
      const { unmount } = renderView(<SettingsPage />, { hash: '#settings?tab=groups' })
      expect(await screen.findByRole('heading', { name: 'Grupos propios' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Grupos' })).toHaveAttribute('aria-selected', 'true')
      unmount()
      renderView(<SettingsPage />, { hash: '#settings?tab=nope' })
      expect(await screen.findByRole('tab', { name: 'Conexiones' })).toHaveAttribute('aria-selected', 'true')
    })
    it('teclado: las flechas y Home/End recorren las pestañas, y la elegida se guarda en la URL sin crear historial', async () => {
      const u = userEvent.setup()
      renderView(<SettingsPage />, { hash: '#settings' })
      const first = await screen.findByRole('tab', { name: 'Conexiones' })
      // Se mide DESPUÉS de montar (renderView fija el hash inicial): cambiar de pestaña no debe añadir entradas.
      const before = window.history.length
      first.focus()
      await u.keyboard('{ArrowRight}')
      expect(screen.getByRole('tab', { name: 'Apariencia' })).toHaveAttribute('aria-selected', 'true')
      await u.keyboard('{End}')
      expect(screen.getByRole('tab', { name: 'Datos' })).toHaveAttribute('aria-selected', 'true')
      await u.keyboard('{Home}')
      expect(screen.getByRole('tab', { name: 'Conexiones' })).toHaveAttribute('aria-selected', 'true')
      await u.click(screen.getByRole('tab', { name: 'Seguridad' }))
      expect(window.location.hash).toContain('tab=security')
      expect(window.history.length).toBe(before)
    })
    it('«Añadir conexión» solo aparece en la pestaña Conexiones', async () => {
      const u = userEvent.setup()
      renderView(<SettingsPage />, { hash: '#settings' })
      expect(await screen.findByRole('link', { name: 'Añadir conexión' })).toBeInTheDocument()
      await u.click(screen.getByRole('tab', { name: 'Apariencia' }))
      expect(screen.queryByRole('link', { name: 'Añadir conexión' })).toBeNull()
    })
  })
})
