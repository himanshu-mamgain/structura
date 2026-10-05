// Browser speech recognition (Web Speech API). Chrome and Edge expose it as
// webkitSpeechRecognition; Firefox does not support it.

interface RecognitionAlternative {
  transcript: string
}
interface RecognitionResult {
  readonly isFinal: boolean
  readonly [index: number]: RecognitionAlternative
}
interface RecognitionEvent {
  readonly resultIndex: number
  readonly results: { readonly length: number; readonly [index: number]: RecognitionResult }
}
export interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

type RecognitionCtor = new () => Recognition

function getRecognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

export const speechRecognitionSupported = typeof window !== 'undefined' && !!getRecognitionCtor()

/**
 * Starts listening. Calls onText with the transcript so far (interim) and
 * onFinal once with the full transcript when the user stops talking.
 */
export function listen(handlers: {
  onText: (text: string) => void
  onFinal: (text: string) => void
  onError: (error: string) => void
}): Recognition | null {
  const Ctor = getRecognitionCtor()
  if (!Ctor) return null

  const recognition = new Ctor()
  recognition.lang = navigator.language || 'en-US'
  recognition.continuous = false
  recognition.interimResults = true

  let finalText = ''
  let latest = ''
  recognition.onresult = (event) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      if (result.isFinal) finalText += result[0].transcript
      else interim += result[0].transcript
    }
    latest = (finalText + interim).trim()
    handlers.onText(latest)
  }
  recognition.onerror = (event) => {
    if (event.error !== 'aborted' && event.error !== 'no-speech') handlers.onError(event.error)
  }
  recognition.onend = () => handlers.onFinal(latest)
  recognition.start()
  return recognition
}

/** Speaks text aloud, queued after anything already being spoken. */
export function speak(text: string) {
  if (!text.trim() || !('speechSynthesis' in window)) return
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}

/**
 * Splits streamed text into sentences as they complete, so speech can start
 * before the whole reply has arrived.
 */
export class SentenceSpeaker {
  private spoken = 0
  enabled = true

  /** Call with the full reply so far; speaks any newly completed sentences. */
  push(textSoFar: string) {
    const rest = textSoFar.slice(this.spoken)
    const match = rest.match(/^[\s\S]*[.!?](\s|$)/)
    if (!match || !/\s$/.test(match[0])) return
    this.spoken += match[0].length
    if (this.enabled) speak(match[0])
  }

  /** Call with the final reply; speaks whatever is left. */
  flush(finalText: string) {
    const rest = finalText.slice(this.spoken)
    this.spoken = finalText.length
    if (this.enabled) speak(rest)
  }
}
