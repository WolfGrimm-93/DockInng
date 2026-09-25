// Terminal simulada (interfaz TerminalSession): comandos de la demo de la plantilla. Solo texto plano.
import { TERMINAL_CLEAR } from '../../terminal'
import type { TerminalSession } from '../../types'

export function createSimTerminal(containerId12: string): TerminalSession {
  const listeners = new Set<(chunk: string) => void>()
  let closed = false
  const emit = (s: string) => {
    if (!closed) for (const l of listeners) l(s)
  }
  const CMD: Record<string, string> = {
    help: 'Comandos de la demo: ls, pwd, whoami, ps, env, node, uname, date, clear, exit',
    ls: 'dist  node_modules  uploads  package.json  pnpm-lock.yaml',
    pwd: '/app',
    whoami: 'root',
    uname: `Linux ${containerId12} 6.10.11-arch1-1 x86_64 GNU/Linux`,
    ps: 'PID   USER     TIME  COMMAND\n    1 root      0:04 node dist/main.js\n   23 root      0:00 sh\n   31 root      0:00 ps',
    env: `NODE_ENV=production\nPORT=3000\nHOSTNAME=${containerId12}\nHOME=/root`,
    node: 'v20.17.0',
  }
  return {
    write(data: string) {
      const line = data.replace(/\r?\n$/, '')
      const name = line.trim().split(/\s+/)[0] ?? ''
      if (name === 'clear') return emit(TERMINAL_CLEAR)
      if (name === 'exit') return emit('Sesión cerrada. Abre la pestaña de nuevo para reconectar.\n')
      if (name === '') return emit('')
      if (name === 'date') return emit(new Date().toString().replace(/ GMT.*/, '') + '\n')
      // Sin prototipos: Object.hasOwn evita que «constructor» o «__proto__» ejecuten nada.
      emit(Object.hasOwn(CMD, name) ? CMD[name] + '\n' : `sh: ${name}: no se encontró la orden\n`)
    },
    onData(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    close() {
      closed = true
      listeners.clear()
    },
  }
}
