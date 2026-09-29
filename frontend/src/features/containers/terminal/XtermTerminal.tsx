// TERMINAL xterm.js (chunk perezoso: se carga al abrir la pestaña Terminal). Sin webgl ni web-links (decisión Ola 1).
// - Abre la sesión DESPUÉS de medir columnas/filas (fuente cargada + FitAddon) y la CIERRA en el cleanup (idempotente, seguro bajo StrictMode:
//   si `open()` resuelve tras el cleanup se cierra al instante, sin sesiones huérfanas).
// - Colores desde los tokens --console-* (se re-aplican al cambiar el tema). Salida: bytes crudos (xterm decodifica UTF-8 con estado).
// - Atajos Linux: Ctrl+Shift+C copia, Ctrl+Shift+V pega (evento paste nativo), Ctrl+Shift+M alterna «Tab mueve el foco». Ctrl+C va al proceso.
import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { toApiError } from '@/data/errors'
import type { ApiError, ExecExit, ExecInfo, ExecOptions, ExecSession } from '@/data/types'
import { toast } from '@/lib/toastStore'
import { copyText } from '@/lib/clipboard'
import { useThemeStore } from '@/theme/useTheme'
import { readTerminalTheme } from './terminalTheme'

export type SessionState =
  | { kind: 'connecting' }
  | { kind: 'open'; info: ExecInfo }
  | { kind: 'ended'; exit: ExecExit }
  | { kind: 'error'; error: ApiError }

export interface TerminalControl {
  copySelection(): Promise<boolean>
  paste(): Promise<boolean>
  clear(): void
  focus(): void
  toggleTabFocus(): void
}

export interface XtermTerminalProps {
  containerName: string
  open(o: ExecOptions): Promise<ExecSession>
  onState(s: SessionState): void
  /** Ctrl+Shift+M: el padre alterna el modo y lo informa de vuelta por `tabFocus`. */
  onToggleTabFocus(): void
  /** El foco entró en la terminal (el padre anuncia una sola vez el atajo Ctrl+Shift+M). */
  onFocusTerminal?(): void
  tabFocus: boolean
  screenReader: boolean
  reducedMotion: boolean
  controlRef?: Ref<TerminalControl>
}

// Textos localizados de xterm (accesibilidad).
Terminal.strings.promptLabel = 'Entrada de la terminal'
Terminal.strings.tooMuchOutput = 'Demasiada salida para anunciar'

async function fontReady(): Promise<void> {
  try {
    const fonts = (document as Document & { fonts?: { load(f: string): Promise<unknown> } }).fonts
    if (!fonts) return
    await Promise.race([fonts.load('12px "JetBrains Mono"'), new Promise((r) => setTimeout(r, 1500))])
  } catch { /* sin FontFaceSet: se mide con la fuente de respaldo */ }
}

export default function XtermTerminal({ containerName, open, onState, onToggleTabFocus, onFocusTerminal, tabFocus, screenReader, reducedMotion, controlRef }: XtermTerminalProps) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const latest = useRef({ open, onState, onToggleTabFocus, tabFocus, onFocusTerminal })
  useEffect(() => { latest.current = { open, onState, onToggleTabFocus, tabFocus, onFocusTerminal } })

  useImperativeHandle(controlRef, () => ({
    async copySelection() {
      const t = termRef.current
      const text = t?.getSelection() ?? ''
      if (!text) return false
      if (await copyText(text)) return true
      toast.err('No se pudo copiar', { sub: 'El portapapeles no está disponible.' }); return false
    },
    async paste() {
      try { termRef.current?.paste(await navigator.clipboard.readText()); return true } catch { toast.err('No se pudo pegar', { sub: 'Usa Ctrl+Shift+V dentro de la terminal.' }); return false }
    },
    clear: () => termRef.current?.clear(),
    focus: () => termRef.current?.focus(),
    toggleTabFocus: () => latest.current.onToggleTabFocus(),
  }), [])

  useEffect(() => {
    const el = host.current
    if (!el) return
    let cancelled = false
    let session: ExecSession | null = null
    const offs: (() => void)[] = []

    const mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace'
    const term = new Terminal({
      fontFamily: mono, fontSize: 12, lineHeight: 1.35, scrollback: 5000, cursorBlink: !reducedMotion, convertEol: false,
      allowProposedApi: false, minimumContrastRatio: 4.5,
      // Los enlaces OSC 8 de la salida del contenedor son contenido NO confiable: se muestran pero NO se abre nada.
      linkHandler: { activate: () => {}, allowNonHttpProtocols: false }, screenReaderMode: screenReader, macOptionIsMeta: false, theme: readTerminalTheme(),
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    if (term.textarea) {
      term.textarea.setAttribute('aria-label', `Terminal de ${containerName}`)
      term.textarea.setAttribute('aria-describedby', 'termHelp') // atajos (incluido Ctrl+Shift+M) disponibles para el lector al entrar
      const onFocus = () => latest.current.onFocusTerminal?.()
      term.textarea.addEventListener('focus', onFocus)
      offs.push(() => term.textarea?.removeEventListener('focus', onFocus))
    }

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const k = e.key.toLowerCase()
      if (e.ctrlKey && e.shiftKey && k === 'c') {
        const t = term.getSelection()
        if (t) void copyText(t).then((ok) => { if (!ok) toast.err('No se pudo copiar', { sub: 'El portapapeles no está disponible.' }) })
        return false
      }
      if (e.ctrlKey && e.shiftKey && k === 'v') return false // el evento paste nativo lo gestiona xterm (bracketed paste)
      if (e.ctrlKey && e.shiftKey && k === 'm') { e.preventDefault(); latest.current.onToggleTabFocus(); return false }
      if (latest.current.tabFocus && e.key === 'Tab') return false // deja que el navegador mueva el foco
      return true
    })

    let raf = 0
    const doFit = () => {
      raf = 0
      if (cancelled) return
      try { fit.fit() } catch { /* contenedor sin tamaño (oculto/jsdom) */ }
    }
    const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(doFit) })
    ro.observe(el)
    offs.push(() => { ro.disconnect(); if (raf) cancelAnimationFrame(raf) })

    void (async () => {
      latest.current.onState({ kind: 'connecting' })
      await fontReady()
      if (cancelled) return
      doFit()
      let s: ExecSession
      try {
        s = await latest.current.open({ cols: Math.max(term.cols, 2), rows: Math.max(term.rows, 1) })
      } catch (e) {
        if (!cancelled) latest.current.onState({ kind: 'error', error: toApiError(e) })
        return
      }
      if (cancelled) { s.close(); return }
      session = s
      offs.push(s.onOpen((info) => latest.current.onState({ kind: 'open', info })))
      offs.push(s.onOutput((chunk) => term.write(chunk)))
      offs.push(s.onExit((exit) => latest.current.onState({ kind: 'ended', exit })))
      const d1 = term.onData((d) => s.write(d))
      const d2 = term.onResize(({ cols, rows }) => s.resize(cols, rows))
      offs.push(() => { d1.dispose(); d2.dispose() })
    })()

    return () => {
      cancelled = true
      for (const o of offs) o()
      session?.close()
      termRef.current = null
      term.dispose()
    }
    // La sesión depende SOLO del contenedor (lo decide el padre con `key`); screenReader/reducedMotion se aplican en efectos aparte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { if (termRef.current) termRef.current.options.screenReaderMode = screenReader }, [screenReader])

  // Cambio de tema (modo/acento/tinte): los tokens --console-* se recalculan; se re-lee tras aplicar el DOM.
  const prefs = useThemeStore((s) => s.prefs)
  const mode = useThemeStore((s) => s.resolvedMode)
  useEffect(() => {
    const id = requestAnimationFrame(() => { if (termRef.current) termRef.current.options.theme = readTerminalTheme() })
    return () => cancelAnimationFrame(id)
  }, [prefs, mode])

  return <div className="term-x" ref={host} role="region" aria-label={`Terminal de ${containerName}`} />
}
