// Validación de subredes CIDR (IPv4 e IPv6) sin dependencias. Contrato:
//   parseCidr(s) -> { family, base, prefix, bits } | null · isValidIp(s) · gatewayInside(cidr, ip) · cidrOverlaps(a, b)
export interface Cidr { family: 4 | 6; base: bigint; prefix: number; bits: 32 | 128 }

function parseIpv4(s: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  let v = 0n
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i])
    if (n > 255 || (m[i].length > 1 && m[i].startsWith('0'))) return null
    v = (v << 8n) | BigInt(n)
  }
  return v
}

function parseIpv6(s: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.includes(':::')) return null
  const dbl = s.split('::')
  if (dbl.length > 2) return null
  const side = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    const groups = part.split(':')
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]
      if (g.includes('.')) {
        if (i !== groups.length - 1) return null
        const v4 = parseIpv4(g)
        if (v4 === null) return null
        out.push(Number(v4 >> 16n), Number(v4 & 0xffffn))
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
        out.push(parseInt(g, 16))
      }
    }
    return out
  }
  const head = side(dbl[0])
  const tail = dbl.length === 2 ? side(dbl[1]) : []
  if (!head || !tail) return null
  let words: number[]
  if (dbl.length === 2) {
    const fill = 8 - head.length - tail.length
    if (fill < 1) return null
    words = [...head, ...Array<number>(fill).fill(0), ...tail]
  } else {
    words = head
    if (words.length !== 8) return null
  }
  let v = 0n
  for (const w of words) v = (v << 16n) | BigInt(w)
  return v
}

function parseIp(s: string): { family: 4 | 6; value: bigint } | null {
  const v4 = parseIpv4(s)
  if (v4 !== null) return { family: 4, value: v4 }
  if (s.includes(':')) {
    const v6 = parseIpv6(s)
    if (v6 !== null) return { family: 6, value: v6 }
  }
  return null
}

export const isValidIp = (s: string): boolean => parseIp(s.trim()) !== null

export function parseCidr(input: string): Cidr | null {
  const s = input.trim()
  const i = s.indexOf('/')
  if (i < 0) return null
  const ip = parseIp(s.slice(0, i))
  const ps = s.slice(i + 1)
  if (!ip || !/^\d{1,3}$/.test(ps)) return null
  const prefix = Number(ps)
  const bits = ip.family === 4 ? 32 : 128
  if (prefix > bits) return null
  return { family: ip.family, base: ip.value, prefix, bits }
}

const mask = (c: Cidr): bigint => {
  const host = BigInt(c.bits - c.prefix)
  return ((1n << BigInt(c.bits)) - 1n) ^ ((1n << host) - 1n)
}
const network = (c: Cidr): bigint => c.base & mask(c)

/** La IP pertenece a la subred (misma familia). */
export function gatewayInside(cidr: string, ipText: string): boolean {
  const c = parseCidr(cidr)
  const ip = parseIp(ipText.trim())
  if (!c || !ip || ip.family !== c.family) return false
  return (ip.value & mask(c)) === network(c)
}

/** Dos subredes de la misma familia se solapan si una contiene la dirección de red de la otra. */
export function cidrOverlaps(a: string, b: string): boolean {
  const x = parseCidr(a)
  const y = parseCidr(b)
  if (!x || !y || x.family !== y.family) return false
  const p = Math.min(x.prefix, y.prefix)
  const m = mask({ ...x, prefix: p })
  return (x.base & m) === (y.base & m)
}
