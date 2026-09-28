// Ancho ajustable de la columna Nombre: validación, persistencia, teclado, ratón y restablecer.
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { safeStorage } from '@/lib/safeStorage'
import { makeApi, renderView, resetGlobals } from '../testUtils'
import ContainersPage from './ContainersPage'
import { NAME_W_KEY, NAME_W_MAX, NAME_W_MIN, clampNameWidth, parseNameWidth } from './useNameColumnWidth'

beforeEach(() => safeStorage().removeItem(NAME_W_KEY))
afterEach(() => { resetGlobals(); safeStorage().removeItem(NAME_W_KEY) })

const sep = () => screen.getByRole('separator', { name: 'Ancho de la columna Nombre' })
const wrap = () => document.querySelector('.table-wrap') as HTMLElement
async function open() {
  renderView(<ContainersPage />, { api: makeApi() })
  await screen.findByRole('link', { name: 'tienda-api-1' })
}

describe('ancho de la columna Nombre', () => {
  it('parseNameWidth: solo números finitos dentro de 200–640; lo demás es automático', () => {
    expect(parseNameWidth('320')).toBe(320)
    expect(parseNameWidth('199')).toBeNull()
    expect(parseNameWidth('641')).toBeNull()
    for (const bad of [null, '', 'abc', 'NaN', 'Infinity', '{"a":1}', '-5']) expect(parseNameWidth(bad)).toBeNull()
    expect(clampNameWidth(10)).toBe(NAME_W_MIN)
    expect(clampNameWidth(9999)).toBe(NAME_W_MAX)
  })

  it('por defecto: sin cambio visual (sin name-fixed ni --name-w) y separador accesible con «Automático»', async () => {
    await open()
    expect(wrap()).not.toHaveClass('name-fixed')
    expect(wrap().style.getPropertyValue('--name-w')).toBe('')
    expect(sep()).toHaveAttribute('aria-orientation', 'vertical')
    expect(sep()).toHaveAttribute('aria-valuemin', '200')
    expect(sep()).toHaveAttribute('aria-valuemax', '640')
    expect(sep()).toHaveAttribute('aria-valuetext', 'Automático')
    expect(sep()).toHaveAttribute('tabindex', '0')
    // La columna de relleno no entra en el árbol de accesibilidad ni en las filas.
    expect(document.querySelectorAll('th.col-fill[aria-hidden="true"]')).toHaveLength(1)
  })

  it('teclado: ←/→ ±16 (Mayús ±64), tope 200–640, Inicio restablece; se guarda y se aplica', async () => {
    await open()
    sep().focus()
    fireEvent.keyDown(sep(), { key: 'ArrowRight' }) // parte del ancho medido (0 en jsdom → mínimo 200) + 16
    const first = Number(sep().getAttribute('aria-valuenow'))
    expect(first).toBeGreaterThanOrEqual(NAME_W_MIN)
    expect(wrap()).toHaveClass('name-fixed')
    expect(wrap().style.getPropertyValue('--name-w')).toBe(`${first}px`)
    expect(safeStorage().getItem(NAME_W_KEY)).toBe(String(first))
    fireEvent.keyDown(sep(), { key: 'ArrowRight', shiftKey: true })
    expect(Number(sep().getAttribute('aria-valuenow'))).toBe(Math.min(NAME_W_MAX, first + 64))
    for (let i = 0; i < 40; i++) fireEvent.keyDown(sep(), { key: 'ArrowRight', shiftKey: true })
    expect(sep()).toHaveAttribute('aria-valuenow', String(NAME_W_MAX))
    for (let i = 0; i < 40; i++) fireEvent.keyDown(sep(), { key: 'ArrowLeft', shiftKey: true })
    expect(sep()).toHaveAttribute('aria-valuenow', String(NAME_W_MIN))
    fireEvent.keyDown(sep(), { key: 'Home' })
    expect(wrap()).not.toHaveClass('name-fixed')
    expect(safeStorage().getItem(NAME_W_KEY)).toBeNull()
    expect(sep()).toHaveAttribute('aria-valuetext', 'Automático')
  })

  it('un valor guardado se aplica al abrir; uno corrupto vuelve a automático; doble clic restablece', async () => {
    safeStorage().setItem(NAME_W_KEY, '333')
    await open()
    expect(wrap()).toHaveClass('name-fixed')
    expect(wrap().style.getPropertyValue('--name-w')).toBe('333px')
    fireEvent.doubleClick(sep())
    expect(wrap()).not.toHaveClass('name-fixed')
    expect(safeStorage().getItem(NAME_W_KEY)).toBeNull()
  })

  it('valor guardado corrupto = automático', async () => {
    safeStorage().setItem(NAME_W_KEY, 'basura')
    await open()
    expect(wrap()).not.toHaveClass('name-fixed')
  })

  it('ratón: arrastrar cambia el ancho solo en el DOM y lo fija al soltar (respeta el rango)', async () => {
    safeStorage().setItem(NAME_W_KEY, '300')
    await open()
    fireEvent(sep(), Object.assign(new MouseEvent('pointerdown', { clientX: 500, button: 0, bubbles: true, cancelable: true }), { isPrimary: true }))
    expect(document.body).toHaveClass('is-col-resizing')
    fireEvent(window, new MouseEvent('pointermove', { clientX: 560, bubbles: true }))
    expect(wrap().style.getPropertyValue('--name-w')).toBe('360px')
    fireEvent(window, new MouseEvent('pointermove', { clientX: 5000, bubbles: true }))
    expect(wrap().style.getPropertyValue('--name-w')).toBe('640px')
    fireEvent(window, new MouseEvent('pointerup', { clientX: 5000, bubbles: true }))
    expect(document.body).not.toHaveClass('is-col-resizing')
    expect(safeStorage().getItem(NAME_W_KEY)).toBe('640')
    expect(sep()).toHaveAttribute('aria-valuenow', '640')
  })
})
