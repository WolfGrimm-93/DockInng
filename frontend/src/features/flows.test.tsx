// Stacks, editor, crear contenedor, descargar imagen, nueva conexión y configuración (todo lo SIMULADO lleva la marca).
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { setComposeMissing } from '@/app/devFlags'
import CreateContainerPage from './containers/CreateContainerPage'
import PullPage from './images/PullPage'
import ConnNewPage from './settings/ConnNewPage'
import SettingsPage from './settings/SettingsPage'
import StackEditPage from './stacks/StackEditPage'
import StacksPage from './stacks/StacksPage'
import { makeApi, renderView, resetGlobals } from './testUtils'

afterEach(resetGlobals)

describe('StacksPage (simulada)', () => {
  it('tarjetas por stack, salud y marca «No conectado aún»', async () => {
    renderView(<StacksPage />)
    await screen.findByRole('region', { name: 'Stack tienda' })
    expect(screen.getByText('No conectado aún')).toBeInTheDocument()
    expect(screen.getByText('4 de 5 activos')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '2 de 3 servicios en ejecución' })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Editar' })[0]).toHaveAttribute('href', '#stack-edit?stack=tienda')
  })
  it('«Bajar…» exige escribir el nombre del stack y elimina sus contenedores por la política', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<StacksPage />)
    const card = await screen.findByRole('region', { name: 'Stack tienda' })
    await u.click(within(card).getByRole('button', { name: 'Bajar…' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByRole('heading', { name: 'Bajar stack tienda' })).toBeInTheDocument()
    const ok = within(dlg).getByRole('button', { name: 'Bajar stack' })
    expect(ok).toBeDisabled()
    await u.type(within(dlg).getByRole('textbox'), 'tienda')
    await u.click(ok)
    await waitFor(() => expect(api.sim.world.containers.some((c) => c.compose_project === 'tienda')).toBe(false))
    expect(await screen.findByText('Stack tienda bajado')).toBeInTheDocument()
  })
  it('Compose no instalado: panel con «Volver a comprobar»', async () => {
    const u = userEvent.setup()
    setComposeMissing(true)
    renderView(<StacksPage />)
    expect(await screen.findByText('Docker Compose no está instalado')).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Volver a comprobar' }))
    expect(await screen.findByText('Docker Compose disponible')).toBeInTheDocument()
  })
})

describe('StackEditPage (simulada)', () => {
  it('validación en vivo: tabuladores y servicio sin image bloquean «Levantar»', async () => {
    renderView(<StackEditPage />, { hash: '#stack-edit?stack=tienda' })
    const ta = (await screen.findByLabelText('Contenido de compose.yaml')) as HTMLTextAreaElement
    await waitFor(() => expect(ta.value).toContain('services:'))
    expect(screen.getByText(/Sintaxis correcta: 4 servicios/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Levantar' })).toBeEnabled()
    fireEvent.change(ta, { target: { value: 'services:\n  web:\n\tports:' } })
    expect(await screen.findByText(/hay tabuladores/)).toBeInTheDocument()
    expect(screen.getByText(/necesita image o build/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Levantar' })).toBeDisabled()
  })
  it('?yaml=broken abre el ejemplo con errores; cambiar a .env muestra el otro archivo', async () => {
    const u = userEvent.setup()
    renderView(<StackEditPage />, { hash: '#stack-edit?stack=tienda&yaml=broken' })
    expect(await screen.findByText(/hay tabuladores/)).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: '.env' }))
    expect((screen.getByLabelText('Contenido de .env') as HTMLTextAreaElement).value).toContain('POSTGRES_PASSWORD')
  })
  it('Levantar muestra el progreso por servicio y termina', async () => {
    const u = userEvent.setup()
    renderView(<StackEditPage />, { hash: '#stack-edit?stack=tienda' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Levantar' })).toBeEnabled())
    await u.click(screen.getByRole('button', { name: 'Levantar' }))
    expect(await screen.findByRole('region', { name: 'Progreso de levantar el stack' })).toBeInTheDocument()
    expect(screen.getAllByRole('progressbar').length).toBe(4)
    expect(await screen.findByText('Stack levantado', { selector: '#upState' }, { timeout: 4000 })).toBeInTheDocument()
  })
  it('Guardar avisa; marca de simulado en la cabecera', async () => {
    const u = userEvent.setup()
    renderView(<StackEditPage />, { hash: '#stack-edit?stack=tienda' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar' })).toBeEnabled())
    await u.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(await screen.findByText('compose.yaml guardado')).toBeInTheDocument()
    expect(screen.getByText('No conectado aún')).toBeInTheDocument()
  })
})

describe('CreateContainerPage (envío simulado)', () => {
  it('valida imagen obligatoria, foco al primer inválido y aviso', async () => {
    const u = userEvent.setup()
    renderView(<CreateContainerPage />, { hash: '#create' })
    const submit = await screen.findByRole('button', { name: 'Crear e iniciar' })
    await u.click(submit)
    expect(await screen.findByText('Indica la imagen que se va a ejecutar.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Imagen')).toHaveFocus())
    expect(screen.getByLabelText('Imagen')).toHaveAttribute('aria-invalid', 'true')
    expect(await screen.findByText('Revisa el formulario')).toBeInTheDocument()
  })
  it('detecta nombre inválido/duplicado y conflicto de puerto con contenedores reales', async () => {
    const u = userEvent.setup()
    renderView(<CreateContainerPage />, { hash: '#create?image=postgres:16.4' })
    expect(await screen.findByText(/El puerto 8080 del equipo ya lo usa tienda-web-1/)).toBeInTheDocument()
    await u.type(screen.getByLabelText(/^Nombre/), 'tienda-api-1')
    await u.click(screen.getByRole('button', { name: 'Solo crear' }))
    expect(await screen.findByText('Ya existe un contenedor llamado tienda-api-1.')).toBeInTheDocument()
    await u.clear(screen.getByLabelText(/^Nombre/))
    await u.type(screen.getByLabelText(/^Nombre/), '-raro')
    await u.click(screen.getByRole('button', { name: 'Solo crear' }))
    expect(await screen.findByText(/debe empezar por letra o número/)).toBeInTheDocument()
  })
  it('añadir y quitar filas; envío correcto crea (en el mundo simulado) y vuelve a la lista', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<CreateContainerPage />, { hash: '#create?image=postgres:16.4' })
    await screen.findByText(/ya lo usa/)
    await u.click(screen.getByRole('button', { name: 'Añadir puerto' }))
    expect(screen.getByLabelText('Puerto del equipo 2')).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Quitar puerto 2' }))
    expect(screen.queryByLabelText('Puerto del equipo 2')).toBeNull()
    await u.clear(screen.getByLabelText('Puerto del equipo 1'))
    await u.type(screen.getByLabelText('Puerto del equipo 1'), '5999')
    await u.type(screen.getByLabelText(/^Nombre/), 'nuevo-pg')
    await u.click(screen.getByRole('button', { name: 'Crear e iniciar' }))
    await waitFor(() => expect(window.location.hash).toBe('#containers'))
    expect(api.sim.world.containers.some((c) => c.names[0] === 'nuevo-pg')).toBe(true)
  })
  it('política de reinicio: Segmented con una sola opción activa', async () => {
    const u = userEvent.setup()
    renderView(<CreateContainerPage />, { hash: '#create' })
    const g = await screen.findByRole('group', { name: 'Política de reinicio' })
    expect(within(g).getByRole('button', { name: 'unless-stopped' })).toHaveAttribute('aria-pressed', 'true')
    await u.click(within(g).getByRole('button', { name: 'always' }))
    expect(within(g).getByRole('button', { name: 'always' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(g).getByRole('button', { name: 'unless-stopped' })).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('PullPage (simulada)', () => {
  it('progreso por capa hasta completar y enlace «Ejecutar»', async () => {
    const u = userEvent.setup()
    renderView(<PullPage />, { hash: '#pull' })
    await u.click(await screen.findByRole('button', { name: 'Descargar' }))
    expect(await screen.findByRole('region', { name: 'Progreso por capa' })).toBeInTheDocument()
    expect(screen.getAllByRole('progressbar').length).toBe(5)
    expect(await screen.findByText('postgres:16.4 descargada', undefined, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ejecutar' })).toHaveAttribute('href', '#create?image=postgres%3A16.4')
  })
  it('cancelar conserva las capas descargadas y lo explica', async () => {
    const u = userEvent.setup()
    renderView(<PullPage />, { hash: '#pull' })
    await u.click(await screen.findByRole('button', { name: 'Descargar' }))
    await u.click(await screen.findByRole('button', { name: 'Cancelar descarga' }))
    expect(await screen.findByText('Descarga cancelada')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Descargar de nuevo' })).toBeInTheDocument()
  })
  it('error del registro (429) con «Reintentar»', async () => {
    const u = userEvent.setup()
    renderView(<PullPage />, { hash: '#pull?image=ratelimit/429:x' })
    await u.click(await screen.findByRole('button', { name: 'Descargar' }))
    expect(await screen.findByText(/No se pudo descargar ratelimit\/429:x/, undefined, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument()
  })
  it('?pull=running reproduce el estado congelado de la plantilla', async () => {
    renderView(<PullPage />, { hash: '#pull?pull=running' })
    expect(await screen.findByText('98.5 de 178.0 MB')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancelar descarga' })).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 60))
    expect(screen.getByText('98.5 de 178.0 MB')).toBeInTheDocument()
    expect(screen.getByText('No conectado aún')).toBeInTheDocument()
  })
  it('vista previa ?pull=done y marca «No conectado aún»', async () => {
    renderView(<PullPage />, { hash: '#pull?pull=done' })
    expect(await screen.findByText('postgres:16.4 descargada')).toBeInTheDocument()
    expect(screen.getByText('No conectado aún')).toBeInTheDocument()
  })
})

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
