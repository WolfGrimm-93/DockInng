import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { makeApi, renderView, resetGlobals } from '../testUtils'
import ContainerDetailPage from './ContainerDetailPage'

afterEach(resetGlobals)
const HASH = '#detail?c=tienda-api-1'

describe('ContainerDetailPage', () => {
  it('cabecera, línea meta y pestañas con roles ARIA', async () => {
    renderView(<ContainerDetailPage />, { hash: HASH })
    await screen.findByRole('tablist', { name: 'Secciones del contenedor' })
    expect(screen.getByRole('heading', { level: 1, name: 'tienda-api-1' })).toBeInTheDocument()
    expect(screen.getByText('stack tienda')).toBeInTheDocument()
    expect(screen.getByRole('tablist', { name: 'Secciones del contenedor' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(4)
    expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('172.20.0.3')).toBeInTheDocument())
  })

  it('logs: el nivel se calcula en el frontend y el filtro por nivel/texto funciona', async () => {
    const u = userEvent.setup()
    renderView(<ContainerDetailPage />, { hash: HASH })
    await screen.findByText(/Servidor escuchando en 0.0.0.0:3000/)
    const log = screen.getByRole('log', { name: 'Logs de tienda-api-1' })
    expect(log.querySelectorAll('.log-line').length).toBeGreaterThan(10)
    await u.click(screen.getByRole('button', { name: 'ERROR' }))
    const lines = Array.from(log.querySelectorAll('.log-line'))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => l.querySelector('.log-lvl')?.textContent === 'ERROR')).toBe(true)
    await u.click(screen.getByRole('button', { name: 'Todos' }))
    await u.type(screen.getByRole('searchbox', { name: 'Filtrar líneas de log' }), 'redis')
    const after = Array.from(log.querySelectorAll('.log-line'))
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((l) => /redis/i.test(l.textContent ?? ''))).toBe(true)
    await u.clear(screen.getByRole('searchbox', { name: 'Filtrar líneas de log' }))
    await u.type(screen.getByRole('searchbox', { name: 'Filtrar líneas de log' }), 'zzz-no-existe')
    expect(await screen.findByText('Ninguna línea coincide con el filtro.')).toBeInTheDocument()
  })

  it('teclado en pestañas: End/Home/flechas mueven la selección', async () => {
    const u = userEvent.setup()
    renderView(<ContainerDetailPage />, { hash: HASH })
    const logs = await screen.findByRole('tab', { name: 'Logs' })
    await u.click(logs)
    await u.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Inspeccionar' })).toHaveAttribute('aria-selected', 'true')
    await u.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true')
    await u.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true')
  })

  it('flechas recorren las 4 pestañas sin que el terminal robe el foco', async () => {
    const u = userEvent.setup()
    renderView(<ContainerDetailPage />, { hash: HASH })
    await u.click(await screen.findByRole('tab', { name: 'Logs' }))
    const order = ['Terminal', 'Estadísticas', 'Inspeccionar']
    for (const n of order) {
      await u.keyboard('{ArrowRight}')
      const t = screen.getByRole('tab', { name: n })
      expect(t).toHaveAttribute('aria-selected', 'true')
      expect(t).toHaveFocus()
    }
    await u.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'Logs' })).toHaveFocus()
    await u.keyboard('{ArrowRight}')
    // La terminal no roba el foco al activar la pestaña con las flechas: el foco sigue en la pestaña.
    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveFocus()
  })

  it('inspeccionar: rótulo honesto (modelo tipado) y JSON como texto', async () => {
    const u = userEvent.setup()
    renderView(<ContainerDetailPage />, { hash: '#detail?c=tienda-api-1&tab=inspect' })
    expect(await screen.findByText(/modelo tipado del motor/)).toBeInTheDocument()
    expect(screen.getByText(/Puede diferir de la salida de/)).toBeInTheDocument()
    const region = await screen.findByRole('region', { name: 'JSON de inspección de tienda-api-1' })
    expect(region.textContent).toContain('"Name": "/tienda-api-1"')
    expect(region.querySelector('.k')).not.toBeNull()
    await u.click(screen.getByRole('tab', { name: 'Logs' }))
    expect(screen.queryByRole('region', { name: /JSON de inspección/ })).toBeNull()
  })

  it('terminal: en un contenedor detenido explica el motivo y no abre sesión', async () => {
    const api = makeApi()
    renderView(<ContainerDetailPage />, { api, hash: '#detail?c=minio-dev&tab=terminal' })
    expect(await screen.findByText('La terminal necesita el contenedor en ejecución')).toBeInTheDocument()
    expect(screen.getByText('Está detenido: inícialo para abrir una terminal.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Iniciar contenedor' })).toBeInTheDocument()
    expect(api.sim.exec.opened).toBe(0)
    expect(screen.queryByText('No conectado aún')).toBeNull()
  })

  it('estadísticas: sparklines de CPU y memoria con datos del motor', async () => {
    renderView(<ContainerDetailPage />, { hash: '#detail?c=tienda-api-1&tab=stats' })
    expect(await screen.findByRole('img', { name: 'Uso de CPU en los últimos 60 segundos' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Uso de memoria en los últimos 60 segundos' })).toBeInTheDocument()
    await waitFor(() => expect(document.getElementById('cpuVal')?.textContent).toMatch(/%$/))
    expect(document.getElementById('memVal')?.textContent).toMatch(/MiB$/)
  })

  it('contenedor inexistente: estado explicativo con enlace de vuelta', async () => {
    renderView(<ContainerDetailPage />, { hash: '#detail?c=no-existe' })
    expect(await screen.findByText('No se encontró el contenedor')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ver contenedores' })).toHaveAttribute('href', '#containers')
  })

  it('eliminar desde el detalle pasa por la política y vuelve a la lista', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<ContainerDetailPage />, { hash: '#detail?c=tienda-redis-1' })
    await u.click(await screen.findByRole('button', { name: 'Eliminar…' }))
    const dlg = await screen.findByRole('alertdialog')
    await u.click(within(dlg).getByRole('button', { name: 'Eliminar contenedor' }))
    await waitFor(() => expect(window.location.hash).toBe('#containers'))
    expect(api.sim.world.containers.some((c) => c.names[0] === 'tienda-redis-1')).toBe(false)
  })

  it('detener actualiza el estado y deshabilita Reiniciar', async () => {
    const u = userEvent.setup()
    renderView(<ContainerDetailPage />, { hash: HASH })
    await u.click(await screen.findByRole('button', { name: 'Detener' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Iniciar' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Reiniciar' })).toBeDisabled()
  })
})
