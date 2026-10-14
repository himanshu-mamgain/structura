import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useValue, type Editor } from 'tldraw'
import type { AssistReply, AssistTurn, Explanation } from '@structura/shared'
import { streamAssist } from './api'
import { applyActions, captureCanvas } from './canvas'
import { DiagramBuilder } from './diagram'
import { erdToDiagram } from './erd'
import { matchCommand, type LocalCommand } from './commands'
import { withSchemaSql } from './ddl'
import { ExplanationCard, type WalkState } from './ExplanationCard'
import {
  listen,
  SentenceSpeaker,
  speak,
  speakAndWait,
  speechRecognitionSupported,
  stopSpeaking,
  type Recognition,
} from './speech'
import { buildSteps, focusStep, showWholeDiagram, Spotlight } from './walkthrough'
import { goToTopicPage, openStaticTopic } from '../topics/open'
import { TopicsPanel } from '../topics/TopicsPanel'
import type { StaticTopic, Topic } from '../topics'

// Earlier turns are sent as text only (no old screenshots), capped to keep requests small.
const MAX_HISTORY_TURNS = 10

// Said or typed while a card is open, these play its walkthrough locally, with no AI call.
const WALKTHROUGH_REQUEST = /^(please )?(walk me through|walk through|explain the flow|show (me )?the flow|play the flow|step by step)/i

/** Whether a card has steps to walk through: an end-to-end trace or a numbered "Step by step" section. */
const hasSteps = (explanation: Explanation) =>
  !!explanation.trace?.steps.length || explanation.sections.some((s) => /step/i.test(s.heading) && /^s*d+[.)]/m.test(s.body))

/** How far the explanation card reaches from the left edge, so diagrams are fitted beside it. */
function cardWidth(): number {
  return document.querySelector('.explain')?.getBoundingClientRect().right ?? 0
}

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
  const [showTopics, setShowTopics] = useState(false)
  const [walk, setWalk] = useState<WalkState | null>(null)
  // The hand-written topic on screen, if any: its simulator powers "try your own input".
  const [activeTopic, setActiveTopic] = useState<StaticTopic | null>(null)
  const walkRun = useRef(0)
  const spotlight = useMemo(() => new Spotlight(editor), [editor])
  const walking = walk !== null
  const wasWalking = useRef(false)
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

  // Plays the walkthrough: highlight the step's shapes, read it aloud (or wait a
  // moment when muted), then move on. Changing step or pausing cancels the old one.
  useEffect(() => {
    if (!walk) return
    const step = walk.steps[walk.index]
    focusStep(editor, spotlight, step, cardWidth())
    if (!walk.playing) return
    const run = ++walkRun.current
    const advance = () => {
      if (walkRun.current !== run) return
      setWalk((w) => (w && w.index < w.steps.length - 1 ? { ...w, index: w.index + 1 } : w && { ...w, playing: false }))
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    if (voiceOnRef.current) {
      void speakAndWait(step.text).then(() => {
        timer = setTimeout(advance, 500)
      })
    } else {
      timer = setTimeout(advance, Math.max(3000, step.text.length * 55))
    }
    return () => {
      walkRun.current++
      clearTimeout(timer)
      stopSpeaking()
    }
  }, [editor, spotlight, walk])

  // When a walkthrough ends (stopped, closed, or replaced by a new question),
  // undo the dimming and step back to the whole diagram.
  useEffect(() => {
    if (walking) {
      wasWalking.current = true
      return
    }
    if (!wasWalking.current) return
    wasWalking.current = false
    spotlight.clear()
    showWholeDiagram(editor, cardWidth())
  }, [editor, spotlight, walking])

  useEffect(() => () => spotlight.clear(), [spotlight])

  function startWalk(card: Explanation | null = explanation) {
    if (!card) return
    const steps = buildSteps(editor, card)
    if (!steps.length) {
      setError('This card has no steps to walk through.')
      return
    }
    setError('')
    setWalk({ index: 0, steps, playing: true })
  }

  function stopWalk() {
    setWalk(null)
    editor.selectNone()
  }

  /** Runs a hand-written topic's flow on the user's own input, then plays it. */
  function simulate(values: Record<string, string>) {
    if (!activeTopic?.simulator || !explanation) return
    const card = { ...explanation, trace: activeTopic.simulator.run(values) }
    setExplanation(card)
    startWalk(card)
  }

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
      if (result.diagram) drawn += await (builders.diagram ?? new DiagramBuilder(editor, cardWidth)).finish(result.diagram)
      if (result.erd) drawn += await (builders.erd ?? new DiagramBuilder(editor, cardWidth)).finish(erdToDiagram(result.erd))
      const edited = applyActions(editor, result.actions)
      if (drawn) setReply(`${replyText} (drew ${drawn} shapes, Ctrl+Z to undo)`)
      else if (edited) setReply(`${replyText} (${edited} edit${edited === 1 ? '' : 's'} applied, Ctrl+Z to undo)`)
      setStatus('idle')
    } catch (err) {
      reportDrawError(err)
    }
  }

  /** Simple canvas commands run instantly, with no AI call. */
  function runCommand(command: LocalCommand) {
    request.current?.abort()
    stopSpeaking()
    setError('')
    setStatus('idle')
    let message: string
    switch (command) {
      case 'clear': {
        // Undim first, so undo brings the shapes back at full opacity.
        spotlight.clear()
        setWalk(null)
        const ids = [...editor.getCurrentPageShapeIds()]
        if (ids.length) {
          editor.markHistoryStoppingPoint('clear canvas')
          editor.deleteShapes(ids)
        }
        message = ids.length ? `Cleared ${ids.length} shapes. Say "undo" to bring them back.` : 'The canvas is already empty.'
        break
      }
      case 'undo':
        editor.undo()
        message = 'Undone.'
        break
      case 'redo':
        editor.redo()
        message = 'Redone.'
        break
      case 'fit':
        showWholeDiagram(editor, cardWidth())
        message = 'Showing the whole diagram.'
        break
      case 'stop':
        setWalk(null)
        message = 'Stopped.'
        break
    }
    setReply(message)
  }

  async function ask(transcript: string) {
    const text = transcript.trim()
    if (!text) {
      setStatus('idle')
      return
    }
    const command = matchCommand(text)
    if (command) {
      setHeard(text)
      runCommand(command)
      return
    }
    if (explanation && WALKTHROUGH_REQUEST.test(text)) {
      setHeard(text)
      setStatus('idle')
      startWalk()
      return
    }
    setWalk(null)
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
              builders[kind] = new DiagramBuilder(editor, cardWidth)
              setStatus('drawing')
            }
            const next = event.type === 'diagram' ? event.diagram : erdToDiagram(event.erd)
            builders[kind]!.update(next).catch(reportDrawError)
          } else if (event.type === 'explanation') {
            setActiveTopic(null)
            setExplanation(event.explanation)
            setExplaining(true)
          } else if (event.type === 'done') {
            setReply(event.reply)
            speaker.flush(event.reply)
            if (event.explanation) {
              setActiveTopic(null)
              // Database designs get CREATE TABLE SQL generated from the drawn schema.
              setExplanation(event.erd ? withSchemaSql(event.explanation, event.erd) : event.explanation)
            }
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

  /** Hand-written topics draw instantly; the others are designed by the AI on a fresh page. */
  async function pickTopic(topic: Topic) {
    setShowTopics(false)
    if (topic.kind === 'ai') {
      goToTopicPage(editor, topic.title.replace(/^./, (c) => c.toUpperCase()))
      void ask(topic.prompt)
      return
    }
    request.current?.abort()
    stopSpeaking()
    setError('')
    setHeard(topic.title)
    // Show the card first, so the drawing is framed beside it.
    setWalk(null)
    setActiveTopic(topic)
    setExplanation(topic.database ? withSchemaSql(topic.explanation, topic.database) : topic.explanation)
    setExplaining(false)
    await new Promise(requestAnimationFrame)
    try {
      await openStaticTopic(editor, topic, cardWidth)
      setReply(topic.explanation.summary)
      setStatus('idle')
      if (voiceOnRef.current) speak(topic.explanation.summary)
    } catch (err) {
      reportDrawError(err)
    }
  }

  function designCustomTopic(title: string) {
    setShowTopics(false)
    goToTopicPage(editor, title)
    void ask(`Design ${title}`)
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
      {explanation && !showTopics && (
        <ExplanationCard
          explanation={explanation}
          streaming={explaining}
          walk={walk}
          canWalk={hasSteps(explanation)}
          simulator={activeTopic?.simulator}
          onAsk={(question) => void ask(question)}
          onClose={() => {
            stopWalk()
            setExplanation(null)
          }}
          onWalkStart={() => startWalk()}
          onWalkStep={(delta) =>
            setWalk((w) => w && { ...w, index: Math.min(w.steps.length - 1, Math.max(0, w.index + delta)), playing: false })
          }
          onWalkToggle={() => setWalk((w) => w && { ...w, playing: !w.playing })}
          onWalkStop={stopWalk}
          onSimulate={simulate}
        />
      )}
      {showTopics && (
        <TopicsPanel
          onPick={(topic) => void pickTopic(topic)}
          onCustom={designCustomTopic}
          onClose={() => setShowTopics(false)}
        />
      )}
      <div className="assistant">
        <div className="assistant-header">
          <span className={`assistant-dot is-${status}`} />
          <span className="assistant-status">{statusLabel}</span>
          <button
            type="button"
            className="assistant-icon-btn"
            onClick={() => setShowTopics(!showTopics)}
            title="Learn a topic"
            aria-pressed={showTopics}
          >
            📚 Topics
          </button>
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
