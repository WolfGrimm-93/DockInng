// Transcripciones por contenedor, acotadas: máx. 20 contenedores (LRU) y 500 líneas cada una.
export const TRANSCRIPT_MAX_SESSIONS = 20
export const TRANSCRIPT_MAX_LINES = 500
export const transcripts = new Map<string, string[]>()
export function saveTranscript(id: string, lines: string[]): void {
  transcripts.delete(id)
  transcripts.set(id, lines.length > TRANSCRIPT_MAX_LINES ? lines.slice(-TRANSCRIPT_MAX_LINES) : lines)
  while (transcripts.size > TRANSCRIPT_MAX_SESSIONS) transcripts.delete(transcripts.keys().next().value as string)
}
