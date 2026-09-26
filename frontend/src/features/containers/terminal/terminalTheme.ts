// Paleta de xterm a partir de los tokens --console-* del tema (siempre oscuros, también en tema claro; el motor de temas
// los recalcula con acento/tinte). Contrato: readTerminalTheme(root?) -> ITheme (16 colores + fondo/primer plano/cursor/selección).
import type { ITheme } from '@xterm/xterm'
import { lightenRgb, mixRgb, resolveCssVarRgb, toHexRgb, type Rgb255 } from '@/lib/cssColor'

/** Respaldo (paleta oscura por defecto) si el entorno no resuelve variables CSS. */
const FALLBACK: Record<string, Rgb255> = {
  bg: [10, 17, 14], fg: [216, 224, 220], muted: [154, 169, 161], info: [97, 195, 249], warn: [240, 187, 59], error: [255, 128, 121], debug: [164, 152, 229], ok: [104, 211, 111],
}
const TOKENS = ['bg', 'fg', 'muted', 'info', 'warn', 'error', 'debug', 'ok'] as const

export function readConsoleColors(root?: HTMLElement): Record<(typeof TOKENS)[number], Rgb255> {
  const out = {} as Record<(typeof TOKENS)[number], Rgb255>
  for (const t of TOKENS) out[t] = resolveCssVarRgb(`--console-${t}`, FALLBACK[t], root)
  return out
}

export function terminalThemeFrom(c: ReturnType<typeof readConsoleColors>): ITheme {
  const hex = toHexRgb
  const bright = (x: Rgb255) => hex(lightenRgb(x, 0.14))
  return {
    background: hex(c.bg), foreground: hex(c.fg),
    cursor: hex(c.ok), cursorAccent: hex(c.bg),
    selectionBackground: hex(mixRgb(c.bg, c.info, 0.35)), selectionInactiveBackground: hex(mixRgb(c.bg, c.muted, 0.3)),
    black: hex(mixRgb(c.bg, c.muted, 0.35)), red: hex(c.error), green: hex(c.ok), yellow: hex(c.warn), blue: hex(c.info), magenta: hex(c.debug),
    cyan: hex(mixRgb(c.info, c.ok, 0.5)), white: hex(c.fg),
    brightBlack: hex(c.muted), brightRed: bright(c.error), brightGreen: bright(c.ok), brightYellow: bright(c.warn), brightBlue: bright(c.info),
    brightMagenta: bright(c.debug), brightCyan: bright(mixRgb(c.info, c.ok, 0.5)), brightWhite: hex(lightenRgb(c.fg, 0.6)),
  }
}

export const readTerminalTheme = (root?: HTMLElement): ITheme => terminalThemeFrom(readConsoleColors(root))
