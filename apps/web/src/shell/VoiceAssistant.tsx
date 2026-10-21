import { useEffect, useRef, useState } from 'react'
import { AudioLines, Loader2, Mic, MicOff, Pause, Play, Send, Settings2, Sparkles, Square, X } from 'lucide-react'
import { respond, type Reply } from '../learn/assistant'
import { useProgress } from '../learn/progress'
import { pauseSpeaking, resumeSpeaking, speak, stopSpeaking, useNowSpeaking, useSpeechSettings } from '../learn/speech'
import type { StaticTopic } from '../topics'
import { VoiceSettings } from './VoiceGuide'

// The voice assistant: always on screen as a floating orb, on every page. Ask
// by voice or text; it answers aloud from Structura's own content (no AI) and
// can drive the app: open topics, run the walkthrough, start the quiz. While it
// speaks, the current words light up in a karaoke caption.

type Turn = { who: 'you' | 'guide'; text: string; from?: string }

interface Recognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  start(): void
  stop(): void
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error: string }) => void) | null
}

const Recognizer: (new () => Recognition) | undefined =
  typeof window !== 'undefined' ? ((window as unknown as Record<string, new () => Recognition>).SpeechRecognition ?? (window as unknown as Record<string, new () => Recognition>).webkitSpeechRecognition) : undefined

const SUGGESTIONS = ['What should I learn today?', 'Walk me through it', 'What is a load balancer?', 'Give me the takeaways', 'Open RBAC', 'Quiz me']

/** The sentence being spoken, word by word: said words solid, the current one glowing, the rest waiting. */
export function Karaoke({ sentence, word }: { sentence: string; word: number }) {
  return (
    <span className="karaoke" key={sentence}>
      {sentence.split(/\s+/).map((w, i) => (
        <span key={i} className={i < word ? 'is-said' : i === word ? 'is-now' : ''}>
          {w}{' '}
        </span>
      ))}
    </span>
  )
}

export function VoiceAssistant({
  topic,
  open,
  openPage,
}: {
  topic: StaticTopic | null
  open: (topic: StaticTopic | null) => void
  openPage: (page: 'quiz' | 'glossary' | 'listen') => void
}) {
  const [panel, setPanel] = useState(false)
  const [settings, setSettings] = useState(false)
  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState('')
  const [draft, setDraft] = useState('')
  const [turns, setTurns] = useState<Turn[]>([{ who: 'guide', text: 'Hi! Ask me about any topic, or say "what should I learn today?"' }])
  const now = useNowSpeaking()
  const progress = useProgress()
  const { listenLang } = useSpeechSettings()
  const recognition = useRef<Recognition | null>(null)
  const log = useRef<HTMLDivElement>(null)

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' })
  }, [turns, panel])

  function ask(text: string) {
    const question = text.trim()
    if (!question) return
    setDraft('')
    setHeard('')
    const reply: Reply = respond(question, { topic, progress, open, openPage })
    setTurns((t) => [...t, { who: 'you', text: question }, ...(reply.say || reply.show ? [{ who: 'guide' as const, text: reply.show ?? reply.say, from: reply.from }] : [])])
    reply.act?.()
    if (reply.say) void speak(reply.say, { source: reply.source ?? 'assistant', title: reply.from ?? 'Structura' })
  }

  function listen() {
    if (!Recognizer) return
    if (listening) {
      recognition.current?.stop()
      return
    }
    stopSpeaking()
    const r = new Recognizer()
    r.lang = listenLang
    r.interimResults = true
    r.continuous = false
    let final = ''
    r.onresult = (e) => {
      const result = e.results[e.results.length - 1]
      setHeard(result[0].transcript)
      if (result.isFinal) final = result[0].transcript
    }
    r.onend = () => {
      setListening(false)
      if (final) ask(final)
    }
    r.onerror = (e) => {
      setListening(false)
      if (e.error === 'not-allowed') setTurns((t) => [...t, { who: 'guide', text: 'Microphone access is blocked. Allow it in the browser to talk to me, or type below.' }])
    }
    recognition.current = r
    setListening(true)
    setHeard('')
    r.start()
  }

  const sentence = now.sentences[now.sentence] ?? ''
  const state = listening ? 'is-listening' : now.speaking ? 'is-speaking' : ''

  return (
    <>
      {/* The caption: what's being said right now, wherever you are in the app. */}
      {now.speaking && !panel && sentence && (
        <div className="voice-caption-float" aria-live="polite">
          {now.title && <span className="voice-caption-title">{now.title}</span>}
          <Karaoke sentence={sentence} word={now.word} />
          <span className="voice-caption-controls">
            <button type="button" onClick={now.paused ? resumeSpeaking : pauseSpeaking} aria-label={now.paused ? 'Resume' : 'Pause'}>
              {now.paused ? <Play size={15} /> : <Pause size={15} />}
            </button>
            <button type="button" onClick={stopSpeaking} aria-label="Stop">
              <Square size={13} />
            </button>
          </span>
        </div>
      )}

      {panel && (
        <section className="assistant-panel" aria-label="Voice assistant">
          <header>
            <strong>
              <Sparkles size={16} /> Voice assistant
            </strong>
            <button type="button" className="icon-btn" onClick={() => setSettings(!settings)} aria-expanded={settings} aria-label="Voice settings">
              <Settings2 size={17} />
            </button>
            <button type="button" className="icon-btn" onClick={() => setPanel(false)} aria-label="Close assistant">
              <X size={17} />
            </button>
          </header>
          {settings && <VoiceSettings />}
          <div className="assistant-log" ref={log}>
            {turns.map((t, i) => (
              <div key={i} className={`bubble is-${t.who}`}>
                {t.who === 'guide' && i === turns.length - 1 && now.speaking && now.source !== null && sentence ? (
                  <Karaoke sentence={sentence} word={now.word} />
                ) : (
                  t.text
                )}
                {t.from && <span className="bubble-from">{t.from}</span>}
              </div>
            ))}
            {listening && <div className="bubble is-you is-live">{heard || 'Listening…'}</div>}
          </div>
          <div className="assistant-suggestions">
            {SUGGESTIONS.filter((s) => topic || !/walk|takeaway/i.test(s)).map((s) => (
              <button key={s} type="button" onClick={() => ask(s)}>
                {s}
              </button>
            ))}
          </div>
          <form
            className="assistant-input"
            onSubmit={(e) => {
              e.preventDefault()
              ask(draft)
            }}
          >
            {Recognizer && (
              <button type="button" className={`mic${listening ? ' is-on' : ''}`} onClick={listen} aria-label={listening ? 'Stop listening' : 'Speak'}>
                {listening ? <MicOff size={19} /> : <Mic size={19} />}
              </button>
            )}
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={Recognizer ? 'Ask, or tap the mic…' : 'Ask anything…'} aria-label="Ask the assistant" />
            <button type="submit" className="send" aria-label="Send" disabled={!draft.trim()}>
              <Send size={17} />
            </button>
          </form>
        </section>
      )}

      <button type="button" className={`orb ${state}`} onClick={() => setPanel(!panel)} aria-label={panel ? 'Close voice assistant' : 'Open voice assistant'} aria-expanded={panel}>
        <span className="orb-ring" />
        <span className="orb-ring is-2" />
        {now.speaking ? (
          <span className="orb-wave" aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} style={{ animationDelay: `${i * 0.11}s` }} />
            ))}
          </span>
        ) : listening ? (
          <Loader2 size={24} className="spin" />
        ) : (
          <AudioLines size={24} />
        )}
      </button>
    </>
  )
}
