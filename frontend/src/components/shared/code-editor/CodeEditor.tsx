// CodeEditor: CodeMirror 6 en chunk perezoso (≈115 KB gz, solo al abrir el editor de stack). Mientras carga, o si el chunk falla,
// se usa un textarea con el mismo contrato (plan B). Contrato de props/handle en ./types.
import { Component, lazy, Suspense, type ReactNode } from 'react'
import { TextareaEditor } from './TextareaEditor'
import type { CodeEditorProps } from './types'

const CodeMirrorEditor = lazy(() => import('./CodeMirrorEditor'))

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

export function CodeEditor(props: CodeEditorProps) {
  const fallback = <TextareaEditor {...props} />
  return (
    <Boundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <CodeMirrorEditor {...props} />
      </Suspense>
    </Boundary>
  )
}
export type { CodeEditorHandle, CodeEditorProps, EditorDiagnostic } from './types'
