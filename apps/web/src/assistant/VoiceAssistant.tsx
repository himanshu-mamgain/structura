import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Editor } from 'tldraw'
import type { AssistTurn } from '@structura/shared'
import { streamAssist } from './api'
import { applyActions, captureCanvas } from './canvas'
import { listen, SentenceSpeaker, speechRecognitionSupported, stopSpeaking, type Recognition } from './speech'

// Earlier turns are sent as text only (no old screenshots), capped to keep requests small.
const MAX_HISTORY_TURNS = 10

type Status = 'idle' | 'listening' | 'thinking' | 'error'

export function VoiceAssistant({ editor }: { editor: Editor }) {
  const [status, setStatus] = useState<Status>('idle')
  const [heard, setHeard] = useState('')
  const [reply, setReply] = useState('')
  const [error, setError] = useState('')
  const [typed, setTyped] = useState('')
  const [voiceOn, setVoiceOn] = useState(true)

  const history = useRef<AssistTurn[]>([])
  const recognition = useRef<Recognition | null>(null)
  const request = useRef<AbortController | null>(null)
  const voiceOnRef = useRef(voiceOn)
  voiceOnRef.current = voiceOn

  useEffect(() => () => {
    recognition.current?.abort()
    request.current?.abort()
    stopSpeaking()
  }, [])

  async function ask(transcript: string) {
    const text = transcript.trim()
    if (!text) {
      setStatus('idle')
      return
    }
    request.current?.abort()
    stopSpeaking()
    const controller = new AbortController()
    request.current = controller

    setHeard(text)
    setReply('')
    setError('')
    setStatus('thinking')

    const speaker = new SentenceSpeaker()
    speaker.enabled = voiceOnRef.current

    try {
      const canvas = await captureCanvas(editor)
      await streamAssist(
        { transcript: text, ...canvas, history: history.current },
        (event) => {
          if (event.type === 'reply') {
            setReply(event.reply)
            speaker.push(event.reply)
          } else if (event.type === 'done') {
            setReply(event.reply)
            speaker.flush(event.reply)
            const applied = applyActions(editor, event.actions)
            if (applied) setReply(`${event.reply} (${applied} edit${applied === 1 ? '' : 's'} applied, Ctrl+Z to undo)`)
            history.current = [
              ...history.current,
              { role: 'user' as const, text },
              { role: 'assistant' as const, text: event.reply },
            ].slice(-MAX_HISTORY_TURNS)
            setStatus('idle')
          } else {
            setError(event.error)
            setStatus('error')
          }
        },
        controller.signal,
      )
    } catch (err) {
      if (controller.signal.aborted) return
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  function toggleMic() {
    if (status === 'listening') {
      recognition.current?.stop()
      return
    }
    request.current?.abort()
    stopSpeaking()
    setHeard('')
    setError('')
    recognition.current = listen({
      onText: setHeard,
      onFinal: (text) => {
        recognition.current = null
        void ask(text)
      },
      onError: (err) => {
        setError(err === 'not-allowed' ? 'Microphone permission was denied' : `Speech error: ${err}`)
        setStatus('error')
      },
    })
    if (recognition.current) setStatus('listening')
  }

  function submitTyped(e: FormEvent) {
    e.preventDefault()
    const text = typed
    setTyped('')
    void ask(text)
  }

  function toggleVoice() {
    if (voiceOn) stopSpeaking()
    setVoiceOn(!voiceOn)
  }

  const statusLabel = {
    idle: 'Ask about your design',
    listening: 'Listening…',
    thinking: 'Thinking…',
    error: 'Something went wrong',
  }[status]

  return (
    <div className="assistant">
      <div className="assistant-header">
        <span className={`assistant-dot is-${status}`} />
        <span className="assistant-status">{statusLabel}</span>
        <button
          type="button"
          className="assistant-icon-btn"
          onClick={toggleVoice}
          title={voiceOn ? 'Mute spoken replies' : 'Speak replies aloud'}
          aria-pressed={voiceOn}
        >
          {voiceOn ? '🔊' : '🔇'}
        </button>
      </div>

      {heard && <p className="assistant-heard">“{heard}”</p>}
      {reply && <p className="assistant-reply">{reply}</p>}
      {error && <p className="assistant-error">{error}</p>}

      <div className="assistant-controls">
        {speechRecognitionSupported && (
          <button
            type="button"
            className={`assistant-mic ${status === 'listening' ? 'is-on' : ''}`}
            onClick={toggleMic}
            title={status === 'listening' ? 'Stop listening' : 'Talk to Claude'}
            aria-label={status === 'listening' ? 'Stop listening' : 'Talk to Claude'}
          >
            🎤
          </button>
        )}
        <form onSubmit={submitTyped} className="assistant-form">
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={speechRecognitionSupported ? 'or type…' : 'Type a request…'}
            aria-label="Request for the design assistant"
          />
        </form>
      </div>
    </div>
  )
}
