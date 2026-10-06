import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Editor } from 'tldraw'
import type { AssistReply, AssistTurn } from '@structura/shared'
import { streamAssist } from './api'
import { applyActions, captureCanvas } from './canvas'
import { DiagramBuilder } from './diagram'
import { listen, SentenceSpeaker, speechRecognitionSupported, stopSpeaking, type Recognition } from './speech'

// Earlier turns are sent as text only (no old screenshots), capped to keep requests small.
const MAX_HISTORY_TURNS = 10

type Status = 'idle' | 'listening' | 'thinking' | 'drawing' | 'error'

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

  function reportDrawError(err: unknown) {
    console.error(err)
    setError(`Couldn't draw that: ${err instanceof Error ? err.message : String(err)}`)
    setStatus('error')
  }

  /** Finishes the diagram (if one was streamed or returned) and applies edits, then reports what changed. */
  async function applyReply(
    replyText: string,
    result: Pick<AssistReply, 'actions' | 'diagram'>,
    builder: DiagramBuilder | null,
  ) {
    try {
      const drawn = result.diagram ? await (builder ?? new DiagramBuilder(editor)).finish(result.diagram) : 0
      const edited = applyActions(editor, result.actions)
      if (drawn) setReply(`${replyText} (drew ${drawn} shapes, Ctrl+Z to undo)`)
      else if (edited) setReply(`${replyText} (${edited} edit${edited === 1 ? '' : 's'} applied, Ctrl+Z to undo)`)
      setStatus('idle')
    } catch (err) {
      reportDrawError(err)
    }
  }

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
    // Created on the first streamed diagram snapshot, so the drawing grows as it's generated.
    let builder: DiagramBuilder | null = null

    try {
      const canvas = await captureCanvas(editor)
      await streamAssist(
        { transcript: text, ...canvas, history: history.current },
        (event) => {
          if (event.type === 'reply') {
            setReply(event.reply)
            speaker.push(event.reply)
          } else if (event.type === 'diagram') {
            if (!builder) {
              builder = new DiagramBuilder(editor)
              setStatus('drawing')
            }
            builder.update(event.diagram).catch(reportDrawError)
          } else if (event.type === 'done') {
            setReply(event.reply)
            speaker.flush(event.reply)
            history.current = [
              ...history.current,
              { role: 'user' as const, text },
              { role: 'assistant' as const, text: event.reply },
            ].slice(-MAX_HISTORY_TURNS)
            void applyReply(event.reply, event, builder)
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
    drawing: 'Drawing…',
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
            title={status === 'listening' ? 'Stop listening' : 'Talk to the assistant'}
            aria-label={status === 'listening' ? 'Stop listening' : 'Talk to the assistant'}
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
