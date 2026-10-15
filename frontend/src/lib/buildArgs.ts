// Nombres de ARG de build que el backend rechaza (variables con efecto sobre el proceso `docker build`).
// Espejo de `reserved_arg_name` en backend/crates/engine-core/src/build.rs: mantener ambas listas idénticas
// (una fuente única vía contrato queda pendiente en PENDIENTES.md).

const RESERVED_PREFIXES = ['DOCKER_', 'BUILDKIT_', 'BUILDX_', 'COMPOSE_', 'LD_', 'XDG_', 'SSH_', 'LC_'] as const

// Variables que cambian el resultado o la red del build (certificados, temporales, runtime, proxies).
const RESERVED_EXACT = new Set<string>([
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'TMPDIR', 'GODEBUG', 'GOFLAGS', 'NODE_OPTIONS', 'PATH', 'HOME', 'USER', 'LOGNAME',
  'LANG', 'LANGUAGE', 'TZ', 'TERM', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'IFS', 'PWD',
])

/** Mayúsculas solo ASCII, como `to_ascii_uppercase` en Rust. `toUpperCase()` de JS convertiría p. ej. «ſ» en «S». */
const asciiUpper = (s: string): string => s.replace(/[a-z]/g, (c) => c.toUpperCase())

/** `true` si el nombre no puede usarse como build arg (misma regla que el backend). */
export const isReservedArgName = (name: string): boolean => {
  const upper = asciiUpper(name)
  return RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix)) || RESERVED_EXACT.has(upper)
}
