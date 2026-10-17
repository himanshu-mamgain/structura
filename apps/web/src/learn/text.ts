// Turning written content into speech-ready sentences. Shared by the live voice
// (speech.ts) and the audio-lesson generator (scripts/lessons.ts), so both read
// the same way.

/** Text the way it should be heard: bullets, symbols and short forms read naturally. */
export function speakable(text: string): string {
  return text
    .replace(/^\s*[-•*]\s+/gm, '')
    .replace(/^\s*(\d+)\.\s+/gm, '$1: ')
    .replace(/→/g, ' to ')
    .replace(/≈/g, ' about ')
    .replace(/≥/g, ' at least ')
    .replace(/×/g, ' times ')
    .replace(/\bvs\b\.?/gi, 'versus')
    .replace(/\be\.g\./gi, 'for example')
    .replace(/\bi\.e\./gi, 'that is')
    .replace(/\bp(50|95|99)\b/g, 'p $1')
    .replace(/\bJWTs?\b/g, (m) => (m.endsWith('s') ? 'J W Ts' : 'J W T'))
    .replace(/[`*_#]/g, '')
}

/** Sentences, as shown and as said. Long utterances get cut off on some browsers, and timing works per sentence. */
export function splitSentences(text: string): string[] {
  return speakable(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}
