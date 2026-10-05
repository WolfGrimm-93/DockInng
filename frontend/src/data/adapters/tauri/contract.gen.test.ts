// Regresión del generador del contrato (scripts/contract-gen.mjs): ningún enum ni tipo del fixture de Rust puede omitirse en silencio.
// Se ejecuta el CLI real (`--check`, el mismo que usa `pnpm contract:check`) con un fixture temporal.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const SCRIPT = resolve(import.meta.dirname, '../../../../scripts/contract-gen.mjs')
const REAL_FIXTURES = resolve(import.meta.dirname, '../../../../../backend/app/contract/fixtures.json')
const dir = mkdtempSync(join(tmpdir(), 'contract-gen-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function checkWith(fixture: Record<string, unknown>) {
  const path = join(dir, `fixtures-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(path, JSON.stringify({ version: 1, commands: {}, feeds: {}, enums: {}, types: {}, ...fixture }))
  return spawnSync(process.execPath, [SCRIPT, '--check'], { env: { ...process.env, CONTRACT_FIXTURES: path }, encoding: 'utf8' })
}

describe('generador del contrato IPC (sin omisiones silenciosas)', () => {
  it('un enum del fixture sin tipo TS equivalente hace fallar la comprobación y lo nombra', () => {
    const r = checkWith({ enums: { EnumInventado: ['a', 'b'] } })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('EnumInventado')
  })

  it('un tipo con datos del fixture sin tipo TS equivalente hace fallar la comprobación y lo nombra', () => {
    const r = checkWith({ types: { TipoInventado: [{ type: 'x' }] } })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('TipoInventado')
  })

  it('el fixture real de Rust mapea TODOS sus enums y tipos a types.ts (contract:check en verde)', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--check'], { env: { ...process.env, CONTRACT_FIXTURES: REAL_FIXTURES }, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
})
