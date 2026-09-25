// TERMINAL en DOM simple (fiel a la plantilla) sobre la interfaz TerminalSession (xterm.js se enchufa en R4 sin tocar la vista).
// Contrato: <TerminalView containerId containerName autoFocus?=false (no roba el foco al activar la pestaña con flechas; se enfoca al clic en el panel) />
//   role="region" + salida role="log" aria-live="polite"; input de una línea; historial ↑↓; Ctrl+L limpia; clic en el panel enfoca el input.
//   La salida se pinta como TEXTO (nunca HTML). La transcripción se conserva por contenedor al cambiar de pestaña.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { TERMINAL_CLEAR } from '@/data/terminal'
import { useEngineApi } from '@/data/store/hooks'

import { saveTranscript, transcripts } from './terminalTranscripts'

export function TerminalView({ containerId, containerName, autoFocus = false }: { containerId: string; containerName: string; autoFocus?: boolean }) {
  const api = useEngineApi()
  const id12 = containerId.slice(0, 12)
  const [lines, setLines] = useState<string[]>(() => transcripts.get(containerId) ?? [`Conectado a ${containerName} (sh). Escribe «help» para ver los comandos de la demo.`])
  const [value, setValue] = useState('')
  const history = useRef<string[]>([])
  const hIdx = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const session = useRef<ReturnType<typeof api.exec.open> | null>(null)

  useEffect(() => {
    const s = api.exec.open(containerId)
    session.current = s
    const off = s.onData((chunk) => {
      if (chunk === TERMINAL_CLEAR) return setLines([])
      setLines((prev) => (chunk === '' ? prev : [...prev, ...chunk.replace(/\n$/, '').split('\n')]))
    })
    if (autoFocus) inputRef.current?.focus()
    return () => {
      off()
      s.close()
    }
  }, [api, containerId, autoFocus])

  useEffect(() => {
    saveTranscript(containerId, lines)
    const b = boxRef.current
    if (b) b.scrollTop = b.scrollHeight
  }, [containerId, lines])

  const prompt = `root@${id12}:/app# `
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const cmd = value
      setLines((prev) => [...prev, prompt + cmd])
      if (cmd.trim()) {
        history.current.push(cmd)
        hIdx.current = history.current.length
      }
      setValue('')
      session.current?.write(cmd)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (hIdx.current > 0) setValue(history.current[--hIdx.current] ?? '')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      hIdx.current = Math.min(history.current.length, hIdx.current + 1)
      setValue(history.current[hIdx.current] ?? '')
    } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      setLines([])
    }
  }

  return (
    <div className="console term" role="region" aria-label={`Terminal de ${containerName}`} ref={boxRef} onClick={(e) => { if (e.target === e.currentTarget) inputRef.current?.focus() }}>
      <div role="log" aria-live="polite" aria-label="Salida de la terminal">
        {lines.map((l, i) => <div className="term-line" key={i}>{l}</div>)}
      </div>
      <div className="term-in">
        <label htmlFor="termIn" className="sr-only">Comando</label>
        <span aria-hidden="true"><span className="p1">root@{id12}</span>:<span className="p2">/app</span># </span>
        <input id="termIn" ref={inputRef} autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey} />
      </div>
    </div>
  )
}
