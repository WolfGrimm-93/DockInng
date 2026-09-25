import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SafeName } from '@/components/shared/SafeName'
import { safeText } from './safeText'

describe('safeText', () => {
  it('neutraliza la inversión bidi de «‮gpj.exe»', () => {
    const evil = 'foto‮gpj.exe'
    expect(safeText(evil)).toBe('fotogpj.exe')
    expect(safeText('a⁦b⁩c‎d‏e؜f')).toBe('abcdef')
  })
  it('quita controles C0/C1 y conserva el resto (tildes, emoji, CJK, tab/salto)', () => {
    expect(safeText('a\u0000b\u0007c\u007Fd\u0085e')).toBe('abcde')
    expect(safeText('ñandú 😀 日本\tx\ny')).toBe('ñandú 😀 日本\tx\ny')
    expect(safeText('a\tb\nc', { singleLine: true })).toBe('a b c')
  })
  it('acepta null/undefined/números', () => {
    expect(safeText(null)).toBe('')
    expect(safeText(undefined)).toBe('')
    expect(safeText(42)).toBe('42')
  })
})

describe('<SafeName>', () => {
  it('pinta con <bdi>, sanea y conserva el valor completo en title', () => {
    const { container } = render(<SafeName>{'foto‮gpj.exe'}</SafeName>)
    const el = screen.getByText('fotogpj.exe')
    expect(el.tagName).toBe('BDI')
    expect(el).toHaveAttribute('title', 'fotogpj.exe')
    expect(container.innerHTML).not.toContain('‮')
  })
  it('elipsis por prop y wrap anywhere por defecto', () => {
    render(<><SafeName ellipsis>largo</SafeName><SafeName>otro</SafeName></>)
    expect(screen.getByText('largo').style.textOverflow).toBe('ellipsis')
    expect(screen.getByText('otro').style.overflowWrap).toBe('anywhere')
  })
})
