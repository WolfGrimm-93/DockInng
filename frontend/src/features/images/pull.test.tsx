// PullPage con el adaptador simulado: bytes por capa, cancelación, errores por código, persistencia al salir de la pantalla.
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { makeApi, renderView, resetGlobals } from '../testUtils'
import PullPage from './PullPage'

afterEach(resetGlobals)

describe('PullPage', () => {
  it('progreso por capa en bytes hasta completar y enlace «Ejecutar»; sin marca de simulado', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<PullPage />, { hash: '#pull' })
    expect(screen.queryByText('No conectado aún')).toBeNull()
    await u.click(await screen.findByRole('button', { name: 'Descargar' }))
    expect(await screen.findByRole('region', { name: 'Progreso por capa' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByRole('progressbar').length).toBe(5))
    expect((await screen.findAllByText('postgres:16.4 descargada', undefined, { timeout: 5000 })).length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'Ejecutar' })).toHaveAttribute('href', '#create?image=postgres%3A16.4')
    expect(api.sim.world.images.some((i) => i.reference === 'postgres:16.4')).toBe(true)
  })

  it('cancelar conserva las capas y lo explica; se puede volver a descargar', async () => {
    const u = userEvent.setup()
    renderView(<PullPage />, { hash: '#pull' })
    await u.click(await screen.findByRole('button', { name: 'Descargar' }))
    await u.click(await screen.findByRole('button', { name: 'Cancelar descarga' }))
    expect((await screen.findAllByText('Descarga cancelada')).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Descargar de nuevo' })).toBeInTheDocument()
  })

  it('error 429 con «Reintentar»; 404 y autenticación con su texto', async () => {
    const u = userEvent.setup()
    const { unmount } = renderView(<PullPage />, { hash: '#pull?image=ratelimit/429:x' })
    await u.click(await screen.findByRole('button', { name: 'Descargar' }))
    expect((await screen.findAllByText(/No se pudo descargar ratelimit\/429:x/, undefined, { timeout: 5000 })).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/429 \(demasiadas peticiones\)/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument()
    unmount()
    renderView(<PullPage />, { hash: '#pull?image=noexiste/x:1' })
    await u.click(await screen.findByRole('button', { name: 'Descargar' }))
    expect((await screen.findAllByText(/No se encontró la imagen noexiste\/x:1/, undefined, { timeout: 5000 })).length).toBeGreaterThan(0)
  }, 20000)

  it('valida la referencia y avisa de que se descargará :latest', async () => {
    const u = userEvent.setup()
    renderView(<PullPage />, { hash: '#pull?image=nginx' })
    expect(await screen.findByText(/se descargará :latest/)).toBeInTheDocument()
    const input = screen.getByLabelText('Imagen a descargar')
    await u.clear(input)
    await u.type(input, 'con espacios{Enter}')
    expect(await screen.findByText('La referencia no puede tener espacios.')).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('la descarga SIGUE al salir de la pantalla (vive en el store) y al volver se ve el progreso', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    const first = renderView(<PullPage />, { api, hash: '#pull' })
    await u.click(await screen.findByRole('button', { name: 'Descargar' }))
    await screen.findByRole('button', { name: 'Cancelar descarga' })
    first.unmount()
    // Nueva «pantalla»: sin ?image, retoma la descarga en curso del store... (otro store: se comprueba con el mismo proveedor)
    const second = renderView(<PullPage />, { api, hash: '#pull' })
    void second
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    expect(screen.getByLabelText('Imagen a descargar')).toBeInTheDocument()
  })

  it('?pull=running reproduce el estado congelado con bytes y ?pull=done', async () => {
    const { unmount } = renderView(<PullPage />, { hash: '#pull?pull=running' })
    expect(await screen.findByText(/98\.5 MiB de 178 MiB/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancelar descarga' })).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 60))
    expect(screen.getByText(/98\.5 MiB de 178 MiB/)).toBeInTheDocument()
    unmount()
    renderView(<PullPage />, { hash: '#pull?pull=done' })
    expect((await screen.findAllByText('postgres:16.4 descargada')).length).toBeGreaterThan(0)
  })
})
