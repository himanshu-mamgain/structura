import { useState } from 'react'
import { CalendarCheck, Download, Headphones, Play, Settings2, Square } from 'lucide-react'
import { useProgress } from '../learn/progress'
import { NATURAL_VOICES, prepareNaturalVoice, setSpeechSettings, speak, type SpeechSettings, speechSupported, stopSpeaking, useNaturalVoice, useSpeechSettings, useVoices } from '../learn/speech'
import { planToday } from '../learn/today'
import course from '../learn/course.json'
import { STATIC_TOPICS, type StaticTopic } from '../topics'

/**
 * Voice settings: the natural voice (Kokoro, downloaded once and kept on the
 * device) or the device's own voices, plus speed and the listening language.
 */
export function VoiceSettings() {
  const voices = useVoices()
  const settings = useSpeechSettings()
  const natural = useNaturalVoice()
  if (!speechSupported) return <p className="voice-note">This browser can't speak. Try Chrome, Edge or Safari.</p>
  const useNatural = settings.engine === 'natural'
  return (
    <div className="voice-settings">
      <div className="seg" role="group" aria-label="Voice type">
        <button type="button" aria-pressed={useNatural} onClick={() => setSpeechSettings({ engine: 'natural' })}>
          Natural voice
        </button>
        <button type="button" aria-pressed={!useNatural} onClick={() => setSpeechSettings({ engine: 'device' })}>
          Device voice
        </button>
      </div>
      {useNatural && natural.status !== 'ready' && (
        <div className="natural-download">
          {natural.status === 'downloading' ? (
            <>
              <span className="progress-bar">
                <span style={{ width: `${natural.progress}%` }} />
              </span>
              <span>Downloading the natural voice… {Math.round(natural.progress)}%</span>
            </>
          ) : (
            <>
              <span>
                {natural.status === 'error' ? 'The download failed. ' : ''}A human-sounding voice (Kokoro) that runs on your device and keeps playing in the
                background. One-time download, about 90 MB.
              </span>
              <button type="button" className="btn btn-primary" onClick={prepareNaturalVoice}>
                <Download size={15} /> {natural.status === 'error' ? 'Try again' : 'Download voice'}
              </button>
            </>
          )}
        </div>
      )}
      {useNatural ? (
        <label>
          <span>Voice</span>
          <select value={settings.naturalVoice} onChange={(e) => setSpeechSettings({ naturalVoice: e.target.value })}>
            {NATURAL_VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
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
      )}
      <label>
        <span>I speak</span>
        <select value={settings.listenLang} onChange={(e) => setSpeechSettings({ listenLang: e.target.value as SpeechSettings['listenLang'] })}>
          <option value="en-IN">English (India)</option>
          <option value="hi-IN">Hindi / Hinglish</option>
          <option value="en-US">English (US)</option>
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
      <button type="button" className="btn btn-ghost" onClick={() => void speak('Hi! This is how I sound. Let’s learn some system design.', { title: 'Voice test' })}>
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
    await speak(plan.script, { source: 'today', title: "Today's pick" })
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
