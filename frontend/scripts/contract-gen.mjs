#!/usr/bin/env node
// Generador del contrato IPC (lado TypeScript). Lee `backend/app/contract/fixtures.json` (lo produce Rust serializando instancias REALES de cada
// tipo del contrato: `cargo test -p dockinng-app contract_fixtures`, con UPDATE_CONTRACT=1 para regenerarlo) y escribe
// `src/data/adapters/tauri/contract.generated.ts`: literales ANOTADOS con los tipos de `src/data/types.ts`. Así `tsc -b` detecta la deriva
// en AMBOS sentidos: un campo que Rust envía y el tipo TS no declara es «excess property»; uno que el tipo exige y Rust no envía es «falta».
// Enums de variantes unitarias -> `Record<Union, true>` (una variante nueva en un lado rompe la compilación en el otro).
//
// Uso:  node scripts/contract-gen.mjs            escribe el archivo
//       node scripts/contract-gen.mjs --check    no escribe: sale con 1 si el archivo generado no está al día (CI)
//       CONTRACT_FIXTURES=<ruta> ...             fixtures alternativos (solo pruebas del propio generador)
//
// Forma de fixtures.json (ver backend/app/contract/README.md):
//   { version, commands: { <cmd>: { args, result_type, result } }, api_errors: { by_code, by_cause, quiesced },
//     feeds: { <Feed>: [variantes] }, enums: { <Enum>: [valores] }, types: { <Enum con datos>: [variantes] } }
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const FIXTURES = process.env.CONTRACT_FIXTURES ?? resolve(ROOT, '../backend/app/contract/fixtures.json')
const OUT = resolve(ROOT, 'src/data/adapters/tauri/contract.generated.ts')
const TYPES_TS = resolve(ROOT, 'src/data/types.ts')

/** Tipo Rust del resultado -> tipo TS que lo describe (cuando el nombre o la forma difieren a propósito). */
const RESULT_TYPE_MAP = {
  void: 'null', // `()` viaja como null
  json: 'unknown',
  // `connection_list`/`connection_save` devuelven el perfil SERDE (sin icono/versión/destino): el adaptador lo completa (`normalizeProfile`).
  ConnectionProfile: '{ import: RawProfile }',
  LegacyImportReport: 'GroupsImportResult', // `groups_import_legacy` devuelve el informe de importación (nombre TS distinto)
}
/** Tipos de fixtures (types/enums) cuyo nombre TS es otro (alias ya existentes en types.ts). */
const TYPE_NAME_MAP = {
  ItemKind: 'AffectedKind',
  PlanDenyReason: 'DenyReason',
  IssueKind: 'ValidationKind',
  SizeEstimate: 'CleanupEstimate',
  RestartPolicy: 'Restart',
  StackOp: 'StackOpRequest',
}

const KNOWN_GLOBALS = new Set(['Record', 'Array', 'Promise', 'Partial', 'Omit', 'Pick', 'RawProfile'])
const lit = (v, pad = '') => JSON.stringify(v, null, 2).replace(/\n/g, `\n${pad}`)
const ident = (s) => s.replace(/[^A-Za-z0-9_]/g, '_')

function exportedTypes() {
  const src = readFileSync(TYPES_TS, 'utf8')
  return new Set([...src.matchAll(/^export\s+(?:interface|type)\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1]))
}

/** `Container[]` / `Foo | null` / `void` (nombres Rust) -> expresión TS. */
function tsResultType(rust) {
  const one = (t) => {
    t = t.trim()
    if (t.endsWith('[]')) return `${one(t.slice(0, -2))}[]`
    const m = RESULT_TYPE_MAP[t]
    return m ?? t
  }
  return rust.split('|').map(one).join(' | ')
}

export function generate(fixturesPath = FIXTURES) {
  if (!existsSync(fixturesPath)) throw new Error(`No existe ${fixturesPath}. Genera los fixtures con: cd backend && UPDATE_CONTRACT=1 cargo test -p dockinng-app contract_fixtures`)
  const fx = JSON.parse(readFileSync(fixturesPath, 'utf8'))
  const known = exportedTypes()
  const used = new Set()
  let needRaw = false
  const need = (name) => {
    if (KNOWN_GLOBALS.has(name)) { if (name === 'RawProfile') needRaw = true; return }
    if (!known.has(name)) throw new Error(`El tipo «${name}» del contrato no existe en src/data/types.ts (¿deriva entre Rust y TypeScript?). Si el nombre TS es otro, mapéalo en scripts/contract-gen.mjs.`)
    used.add(name)
  }
  const collectIdents = (expr) => [...expr.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)].forEach((m) => need(m[1]))
  const body = []
  const commands = fx.commands ?? {}
  const cmdNames = Object.keys(commands).sort()

  body.push('/** Resultado de cada comando IPC, anotado con su tipo TS (`result_type` de Rust traducido). */')
  for (const cmd of cmdNames) {
    const c = commands[cmd]
    let ts = tsResultType(c.result_type)
    if (ts.includes('{ import: RawProfile }')) { ts = ts.replace('{ import: RawProfile }', 'RawProfile'); needRaw = true }
    collectIdents(ts.replace(/RawProfile/g, ''))
    body.push(`export const result_${ident(cmd)}: ${ts} = ${lit(c.result)}`)
  }
  body.push('')
  body.push('/** Argumentos EXACTOS que la webview manda a `invoke` (camelCase). `{ "$channel": Feed }` = argumento Channel (`onEvent`). */')
  body.push('export const COMMANDS = {')
  for (const cmd of cmdNames) {
    const c = commands[cmd]
    body.push(`  ${cmd}: { args: ${lit(c.args ?? {}, '  ')}, resultType: ${JSON.stringify(c.result_type)}, result: result_${ident(cmd)} },`)
  }
  body.push('} as const')

  if (fx.api_errors) {
    need('ApiError'); need('ApiErrorCode'); need('ConnectionCause')
    body.push('', '/** Un ApiError por código y por causa (`Record<…>`: una variante nueva o retirada en Rust o en TS rompe `tsc -b`). */')
    body.push(`export const API_ERRORS_BY_CODE: Record<ApiErrorCode, ApiError> = ${lit(fx.api_errors.by_code)}`)
    body.push(`export const API_ERRORS_BY_CAUSE: Record<ConnectionCause, ApiError> = ${lit(fx.api_errors.by_cause)}`)
    body.push(`export const API_ERROR_QUIESCED: ApiError = ${lit(fx.api_errors.quiesced)}`)
  }
  for (const [name, variants] of Object.entries(fx.feeds ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const t = TYPE_NAME_MAP[name] ?? name
    need(t)
    body.push('', `/** Una instancia por variante de ${t}. */`, `export const FEED_${ident(name)}: ${t}[] = ${lit(variants)}`)
  }
  const unmapped = []
  for (const [name, values] of Object.entries(fx.enums ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const t = TYPE_NAME_MAP[name] ?? name
    if (!known.has(t)) { unmapped.push(name); continue }
    need(t)
    body.push('', `/** Variantes de ${t} en Rust (exhaustivo en ambos sentidos). */`, `export const ENUM_${ident(name)}: Record<${t}, true> = { ${values.map((v) => `${JSON.stringify(v)}: true`).join(', ')} }`)
  }
  for (const [name, variants] of Object.entries(fx.types ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const t = TYPE_NAME_MAP[name] ?? name
    if (!known.has(t)) { unmapped.push(name); continue }
    need(t)
    body.push('', `/** Una instancia por variante de ${t}. */`, `export const TYPE_${ident(name)}: ${t}[] = ${lit(variants)}`)
  }
  // Sin tipo TS equivalente NO se omite en silencio: el fixture de Rust tiene un enum/tipo que la UI no declara (deriva).
  if (unmapped.length) throw new Error(`Enums/tipos del fixture de Rust sin tipo en src/data/types.ts: ${unmapped.join(', ')}. Declara el alias en types.ts o mapéalo en TYPE_NAME_MAP (scripts/contract-gen.mjs).`)

  const head = [
    '// GENERADO por scripts/contract-gen.mjs desde backend/app/contract/fixtures.json. NO EDITAR A MANO: `pnpm contract:gen`.',
    '// Literales anotados con los tipos de data/types.ts: si Rust y TypeScript divergen, `tsc -b` falla aquí.',
    `import type { ${[...used].sort().join(', ')} } from '../../types'`,
    ...(needRaw ? ["import type { RawProfile } from './store'"] : []),
    '',
  ]
  return `${head.join('\n')}\n${body.join('\n')}\n`
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const out = generate()
    if (process.argv.includes('--check')) {
      const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
      if (cur !== out) {
        console.error('contract.generated.ts NO está al día con los fixtures de Rust. Ejecuta: pnpm contract:gen')
        process.exit(1)
      }
      console.log('contract.generated.ts al día')
    } else {
      writeFileSync(OUT, out)
      console.log(`Escrito ${OUT}`)
    }
  } catch (e) {
    console.error(String(e.message ?? e))
    process.exit(1)
  }
}
