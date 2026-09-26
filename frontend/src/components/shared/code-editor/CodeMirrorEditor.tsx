// Implementación CodeMirror 6 del contrato CodeEditor (chunk perezoso). Colores desde los tokens --console-* (siguen tema y combinaciones).
// Accesibilidad: contenteditable con role=textbox/aria-multiline y aria-label; SIN indentWithTab (Tab mueve el foco; Ctrl+] / Ctrl+[ indentan).
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { yaml } from '@codemirror/lang-yaml'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { EditorState, type Extension } from '@codemirror/state'
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { useEffect, useImperativeHandle, useRef } from 'react'
import type { CodeEditorProps } from './types'

const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--console-info)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--console-ok)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--console-warn)' },
  { tag: [t.comment, t.lineComment], color: 'var(--console-muted)', fontStyle: 'italic' },
  { tag: [t.keyword, t.operator, t.meta, t.separator], color: 'var(--console-debug)' },
  { tag: [t.variableName, t.labelName, t.typeName], color: 'var(--console-fg)' },
  { tag: t.invalid, color: 'var(--console-error)' },
])

const theme = EditorView.theme({
  '&': { color: 'var(--console-fg)', backgroundColor: 'var(--console-bg)', fontSize: '12px', minHeight: '320px', maxHeight: '70vh' },
  '&.cm-focused': { outline: '2px solid var(--ring)', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'auto', minHeight: '320px' },
  '.cm-content': { caretColor: 'var(--console-ok)', padding: '10px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--console-ok)' },
  '.cm-gutters': { backgroundColor: 'var(--console-bg)', color: 'var(--console-muted)', border: 'none', borderRight: '1px solid color-mix(in oklch, var(--console-fg) 12%, transparent)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--console-fg) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--console-fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in oklch, var(--console-info) 35%, transparent) !important' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--console-error)', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--console-warn)', textUnderlineOffset: '3px' },
  '.cm-tooltip': { backgroundColor: 'var(--popover)', color: 'var(--popover-foreground)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--console-error)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--console-warn)' },
  '.cm-lint-marker-error, .cm-lint-marker-warning': { content: 'none' },
})

function build(o: CodeEditorProps, onDoc: (v: string) => void, save: () => void): Extension[] {
  return [
    lineNumbers(), lintGutter(), history(), drawSelection(), highlightActiveLine(),
    o.language === 'yaml' ? yaml() : [],
    syntaxHighlighting(highlight),
    keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { save(); return true } }, ...defaultKeymap, ...historyKeymap]),
    EditorView.contentAttributes.of({ 'aria-label': o.ariaLabel, 'aria-multiline': 'true', role: 'textbox', spellcheck: 'false', ...(o.readOnly ? { 'aria-readonly': 'true' } : {}) }),
    EditorState.readOnly.of(!!o.readOnly),
    EditorView.editable.of(!o.readOnly),
    EditorView.updateListener.of((u) => { if (u.docChanged) onDoc(u.state.doc.toString()) }),
    theme,
  ]
}

export default function CodeMirrorEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const states = useRef(new Map<string, EditorState>())
  const cur = useRef(props)
  cur.current = props
  const activeKey = useRef(props.docKey)

  useImperativeHandle(props.handleRef, () => ({
    focus: () => view.current?.focus(),
    focusLine(line, column) {
      const v = view.current
      if (!v) return
      const l = v.state.doc.line(Math.min(Math.max(line, 1), v.state.doc.lines))
      const pos = Math.min(l.from + Math.max((column ?? 1) - 1, 0), l.to)
      v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
      v.focus()
    },
  }), [])

  const makeState = (doc: string) => EditorState.create({ doc, extensions: build(cur.current, (v) => cur.current.onChange(v), () => cur.current.onSave?.()) })

  useEffect(() => {
    const v = new EditorView({ state: makeState(props.value), parent: host.current! })
    view.current = v
    const map = states.current
    return () => { v.destroy(); view.current = null; map.clear() }
    // Se crea una sola vez; los cambios de documento/props se aplican en los efectos siguientes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cambio de documento (yaml <-> .env): se guarda el estado (con su historial) y se restaura el del otro.
  useEffect(() => {
    const v = view.current
    if (!v || activeKey.current === props.docKey) return
    states.current.set(activeKey.current, v.state)
    activeKey.current = props.docKey
    v.setState(states.current.get(props.docKey) ?? makeState(props.value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.docKey])

  // Texto cambiado desde fuera (descartar, recargar desde disco): se sustituye el documento.
  useEffect(() => {
    const v = view.current
    if (!v) return
    const now = v.state.doc.toString()
    if (now !== props.value) v.dispatch({ changes: { from: 0, to: now.length, insert: props.value } })
  }, [props.value])

  // Solo lectura: se reconstruye el estado conservando documento y cursor (el idioma y la etiqueta van fijos por documento).
  const firstRun = useRef(true)
  useEffect(() => {
    const v = view.current
    if (firstRun.current) { firstRun.current = false; return }
    if (!v) return
    const st = EditorState.create({ doc: v.state.doc, selection: v.state.selection, extensions: build(cur.current, (x) => cur.current.onChange(x), () => cur.current.onSave?.()) })
    v.setState(st)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.readOnly])

  // Diagnósticos -> subrayado + marcadores de margen.
  useEffect(() => {
    const v = view.current
    if (!v) return
    const doc = v.state.doc
    const list: Diagnostic[] = props.diagnostics.filter((d) => d.line >= 1 && d.line <= doc.lines).map((d) => {
      const l = doc.line(d.line)
      const from = Math.min(l.from + Math.max((d.column ?? 1) - 1, 0), l.to)
      return { from, to: Math.max(from, l.to), severity: d.level === 'error' ? 'error' : 'warning', message: d.message }
    })
    v.dispatch(setDiagnostics(v.state, list))
  }, [props.diagnostics, props.value, props.docKey])

  return <div className="cm-host" ref={host} />
}
