// Contrato del editor de código (CodeMirror 6 perezoso con textarea como plan B). La vista solo conoce esto.
import type { Ref } from 'react'

export interface EditorDiagnostic { line: number; column?: number | null; level: 'error' | 'warn'; message: string }
export interface CodeEditorHandle {
  /** Mueve el cursor al inicio de la línea (1-based), la muestra y enfoca el editor. */
  focusLine(line: number, column?: number | null): void
  focus(): void
}
export interface CodeEditorProps {
  /** Identifica el documento: al cambiar se conserva el historial (deshacer) de cada uno. */
  docKey: string
  value: string
  onChange(value: string): void
  language: 'yaml' | 'plain'
  diagnostics: EditorDiagnostic[]
  readOnly?: boolean
  ariaLabel: string
  /** Ctrl/Cmd+S. */
  onSave?(): void
  handleRef?: Ref<CodeEditorHandle>
}
