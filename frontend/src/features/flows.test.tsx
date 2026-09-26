// Nueva conexión y configuración (lo SIMULADO lleva la marca). Stacks, editor, crear, pull y terminal: ver sus propios tests.
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import ConnNewPage from './settings/ConnNewPage'
import SettingsPage from './settings/SettingsPage'
import { makeApi, renderView, resetGlobals } from './testUtils'

afterEach(resetGlobals)

describe('ConnNewPage (simulada)', () => {
  /** Rellena un SSH válido con el host indicado. */
  async function fillSsh(u: ReturnType<typeof userEvent.setup>, host: string) {
    await u.type(await screen.findByLabelText('Nombre'), 'prod-x')
    await u.type(screen.getByLabelText(/^Host/), host)
    await u.type(screen.getByLabelText('Usuario'), 'deploy')
  }
  it('flujo SSH: verificar → diálogo de huella (TOFU) → confiar → prueba correcta → guardar vuelve a Configuración', async () => {
    const u = userEvent.setup()
    renderView(<ConnNewPage />, { hash: '#conn-new' })
    expect(await screen.findByText('Sin probar todavía.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Guardar conexión' })).toBeDisabled() // no se puede guardar sin probar
    await fillSsh(u, '203.0.113.50')
    await u.click(screen.getByRole('button', { name: 'Verificar y probar' }))
    const dlg = await screen.findByRole('alertdialog', undefined, { timeout: 3000 })
    expect(within(dlg).getByText('Confirmar la huella del host')).toBeInTheDocument()
    expect(within(dlg).getByTestId('fingerprint').textContent).toMatch(/^SHA256:/)
    // El foco inicial es «Cancelar»: nunca se confía por accidente.
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Cancelar' })).toHaveFocus())
    await u.click(within(dlg).getByRole('button', { name: 'Confiar y continuar' }))
    expect(await screen.findByText('Conexión correcta', undefined, { timeout: 4000 })).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Guardar conexión' }))
    await waitFor(() => expect(window.location.hash).toBe('#settings'))
  })
  it('clave de host CAMBIADA: bloqueo rojo, sin botón de aceptar', async () => {
    const u = userEvent.setup()
    renderView(<ConnNewPage />, { hash: '#conn-new' })
    await fillSsh(u, 'changed-host')
    await u.click(screen.getByRole('button', { name: 'Verificar y probar' }))
    const dlg = await screen.findByRole('alertdialog', undefined, { timeout: 3000 })
    expect(within(dlg).getByText('La clave del host cambió')).toBeInTheDocument()
    expect(within(dlg).getByText('Conexión bloqueada.')).toBeInTheDocument()
    expect(within(dlg).queryByRole('button', { name: /Confiar/ })).toBeNull()
    expect(within(dlg).getByRole('button', { name: 'Cerrar' })).toBeInTheDocument()
    await u.click(within(dlg).getByRole('button', { name: 'Cerrar' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByRole('button', { name: 'Guardar conexión' })).toBeDisabled()
  })
  it('fallo de autenticación: mensaje por causa y Guardar sigue bloqueado', async () => {
    const u = userEvent.setup()
    renderView(<ConnNewPage />, { hash: '#conn-new' })
    await fillSsh(u, 'auth-fail-host')
    await u.click(screen.getByRole('button', { name: 'Verificar y probar' }))
    await u.click(await within(await screen.findByRole('alertdialog', undefined, { timeout: 3000 })).findByRole('button', { name: 'Confiar y continuar' }))
    expect(await screen.findByText('No se pudo conectar', undefined, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByText(/rechazó la autenticación/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Guardar conexión' })).toBeDisabled()
  })
  it('validación en el borde: nombre/host/usuario vacíos no llaman al motor', async () => {
    const u = userEvent.setup()
    renderView(<ConnNewPage />, { hash: '#conn-new' })
    await u.click(await screen.findByRole('button', { name: 'Verificar y probar' }))
    expect(await screen.findByText('Escribe un nombre (1–40 caracteres).')).toBeInTheDocument()
    expect(screen.getByLabelText('Nombre')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
  it('no hay ningún campo que acepte contenido de llaves ni opción «inseguro»; la llave es solo una ruta', async () => {
    const u = userEvent.setup()
    renderView(<ConnNewPage />, { hash: '#conn-new' })
    await u.click(await screen.findByRole('button', { name: 'Archivo de llave' }))
    const path = screen.getByLabelText('Ruta de la llave privada')
    expect(path.tagName).toBe('INPUT') // ni <textarea> ni type=file
    expect(document.querySelector('textarea, input[type=file]')).toBeNull()
    expect(screen.queryByText(/insecure|inseguro/i)?.textContent ?? '').not.toMatch(/activar|permitir/i)
  })
  it('cambiar a TLS muestra las 3 rutas y puerto 2376; con datos válidos prueba directo (sin huella) y guarda', async () => {
    const u = userEvent.setup()
    renderView(<ConnNewPage />, { hash: '#conn-new' })
    await u.click(await screen.findByRole('button', { name: 'TLS (tcp://)' }))
    expect((screen.getByLabelText('Puerto') as HTMLInputElement).value).toBe('2376')
    await u.type(screen.getByLabelText('Nombre'), 'ci')
    await u.type(screen.getByLabelText('Host'), '10.0.0.5')
    await u.type(screen.getByLabelText(/Certificado CA/), '/certs/ca.pem')
    await u.type(screen.getByLabelText(/Certificado de cliente/), '/certs/cert.pem')
    await u.type(screen.getByLabelText(/Llave de cliente/), '/certs/key.pem')
    await u.click(screen.getByRole('button', { name: 'Probar conexión' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(await screen.findByText('Conexión correcta', undefined, { timeout: 4000 })).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Guardar conexión' }))
    await waitFor(() => expect(window.location.hash).toBe('#settings'))
  })
  it('TLS con CA incorrecta: mensaje de certificado', async () => {
    const u = userEvent.setup()
    renderView(<ConnNewPage />, { hash: '#conn-new' })
    await u.click(await screen.findByRole('button', { name: 'TLS (tcp://)' }))
    await u.type(screen.getByLabelText('Nombre'), 'ci')
    await u.type(screen.getByLabelText('Host'), 'badca-host')
    await u.type(screen.getByLabelText(/Certificado CA/), '/c/ca.pem')
    await u.type(screen.getByLabelText(/Certificado de cliente/), '/c/cert.pem')
    await u.type(screen.getByLabelText(/Llave de cliente/), '/c/key.pem')
    await u.click(screen.getByRole('button', { name: 'Probar conexión' }))
    expect(await screen.findByText(/certificado no es válido/, undefined, { timeout: 4000 })).toBeInTheDocument()
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
    expect(screen.getAllByText('Simulada').length).toBeGreaterThan(0)
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
    it('hay 6 pestañas y solo se pinta el contenido de la activa', async () => {
      renderView(<SettingsPage />, { hash: '#settings' })
      const tabs = await screen.findAllByRole('tab')
      expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Conexiones', 'Registros', 'Apariencia', 'Grupos', 'Seguridad', 'Datos'])
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
      expect(screen.getByRole('tab', { name: 'Registros' })).toHaveAttribute('aria-selected', 'true')
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
