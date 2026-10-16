import { useState } from 'react'
import { CalendarCheck, Headphones, Play, Settings2, Square } from 'lucide-react'
import { useProgress } from '../learn/progress'
import { setSpeechSettings, speak, speechSupported, stopSpeaking, useSpeechSettings, useVoices } from '../learn/speech'
import { planToday } from '../learn/today'
import course from '../learn/course.json'
import { STATIC_TOPICS, type StaticTopic } from '../topics'

/** Voice and speed for the voice guide, from the voices installed on this device. */
export function VoiceSettings() {
  const voices = useVoices()
  const settings = useSpeechSettings()
  if (!speechSupported) return <p className="voice-note">This browser can't speak. Try Chrome, Edge or Safari.</p>
  return (
    <div className="voice-settings">
      <label>
        <span>Voice</span>
        <select value={settings.voiceURI ?? ''} onChange={(e) => setSpeechSettings({ voiceURI: e.target.value || null })}>
          <option value="">Automatic (Indian English if available)</option>
          {voices.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name} · {v.lang}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Speed</span>
        <select value={settings.rate} onChange={(e) => setSpeechSettings({ rate: Number(e.target.value) })}>
          {[0.8, 0.9, 1, 1.1, 1.25, 1.5].map((r) => (
            <option key={r} value={r}>
              {r}×
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="btn btn-ghost" onClick={() => void speak('Hi! This is how I sound. Let’s learn some system design.')}>
        <Play size={14} /> Test
      </button>
    </div>
  )
}

/** A button that opens the voice settings in a small popover. */
export function VoiceSettingsButton() {
  const [open, setOpen] = useState(false)
  return (
    <div className="voice-settings-wrap">
      <button type="button" className="icon-btn" onClick={() => setOpen(!open)} aria-expanded={open} title="Voice settings">
        <Settings2 size={18} />
      </button>
      {open && (
        <div className="voice-popover card">
          <VoiceSettings />
        </div>
      )}
    </div>
  )
}

/** Home's "Today's pick": what to study today, from progress, and a spoken plan. */
export function TodayCard({ onOpen }: { onOpen: (topic: StaticTopic) => void }) {
  const progress = useProgress()
  const plan = planToday(STATIC_TOPICS, progress, course.quiz.length)
  const [speaking, setSpeaking] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  async function listen() {
    if (speaking) {
      stopSpeaking()
      setSpeaking(false)
      return
    }
    setSpeaking(true)
    await speak(plan.script)
    setSpeaking(false)
  }

  return (
    <section className="card today" aria-label="Today's pick">
      <header>
        <span className="today-label">
          <CalendarCheck size={16} /> Today's pick
        </span>
        {speechSupported && (
          <button type="button" className="icon-btn" onClick={() => setSettingsOpen(!settingsOpen)} aria-expanded={settingsOpen} title="Voice settings">
            <Settings2 size={18} />
          </button>
        )}
      </header>
      <h2>{plan.headline}</h2>
      <p>{plan.reason}</p>
      <ol className="today-steps">
        {plan.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <div className="today-actions">
        {plan.topic && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              stopSpeaking()
              onOpen(plan.topic!)
            }}
          >
            <Play size={16} fill="currentColor" /> Start
          </button>
        )}
        {speechSupported && (
          <button type="button" className={`btn${speaking ? ' is-on' : ''}`} onClick={() => void listen()}>
            {speaking ? <Square size={15} /> : <Headphones size={17} />} {speaking ? 'Stop' : 'Listen'}
          </button>
        )}
      </div>
      {settingsOpen && <VoiceSettings />}
    </section>
  )
}
