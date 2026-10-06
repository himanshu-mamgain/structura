import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useValue, type Editor } from 'tldraw'
import type { AssistReply, AssistTurn, Explanation } from '@structura/shared'
import { streamAssist } from './api'
import { applyActions, captureCanvas } from './canvas'
import { DiagramBuilder } from './diagram'
import { erdToDiagram } from './erd'
import { ExplanationCard } from './ExplanationCard'
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
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const [explaining, setExplaining] = useState(false)
  const selectedCount = useValue('selected shapes', () => editor.getSelectedShapeIds().length, [editor])

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

  /** Finishes any drawing that was streamed (or only arrived at the end), applies edits, then reports what changed. */
  async function applyReply(
    replyText: string,
    result: Pick<AssistReply, 'actions' | 'diagram' | 'erd'>,
    builders: { diagram: DiagramBuilder | null; erd: DiagramBuilder | null },
  ) {
    try {
      let drawn = 0
      if (result.diagram) drawn += await (builders.diagram ?? new DiagramBuilder(editor)).finish(result.diagram)
      if (result.erd) drawn += await (builders.erd ?? new DiagramBuilder(editor)).finish(erdToDiagram(result.erd))
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
    // Created on the first streamed snapshot, so drawings grow as they're generated.
    const builders: { diagram: DiagramBuilder | null; erd: DiagramBuilder | null } = { diagram: null, erd: null }
    setExplaining(false)

    try {
      const canvas = await captureCanvas(editor)
      await streamAssist(
        { transcript: text, ...canvas, history: history.current },
        (event) => {
          if (event.type === 'reply') {
            setReply(event.reply)
            speaker.push(event.reply)
          } else if (event.type === 'diagram' || event.type === 'erd') {
            const kind = event.type
            if (!builders[kind]) {
              builders[kind] = new DiagramBuilder(editor)
              setStatus('drawing')
            }
            const next = event.type === 'diagram' ? event.diagram : erdToDiagram(event.erd)
            builders[kind]!.update(next).catch(reportDrawError)
          } else if (event.type === 'explanation') {
            setExplanation(event.explanation)
            setExplaining(true)
          } else if (event.type === 'done') {
            setReply(event.reply)
            speaker.flush(event.reply)
            if (event.explanation) setExplanation(event.explanation)
            setExplaining(false)
            // The card itself stays out of history; a note keeps follow-ups ("go deeper") in context.
            const note = event.explanation ? ` [Showed an explanation card: ${event.explanation.title}]` : ''
            history.current = [
              ...history.current,
              { role: 'user' as const, text },
              { role: 'assistant' as const, text: event.reply + note },
            ].slice(-MAX_HISTORY_TURNS)
            void applyReply(event.reply, event, builders)
          } else {
            setError(event.error)
            setExplaining(false)
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

  const busy = status === 'thinking' || status === 'drawing' || status === 'listening'

  return (
    <>
      {explanation && (
        <ExplanationCard
          explanation={explanation}
          streaming={explaining}
          onAsk={(question) => void ask(question)}
          onClose={() => setExplanation(null)}
        />
      )}
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

        {selectedCount > 0 && !busy && (
          <button type="button" className="assistant-chip" onClick={() => void ask('Explain the selected concept in depth.')}>
            Explain selected
          </button>
        )}

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
    </>
  )
}
