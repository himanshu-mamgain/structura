import { useState } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { VoiceAssistant } from './assistant/VoiceAssistant'

export default function App() {
  const [editor, setEditor] = useState<Editor | null>(null)

  return (
    <div className="app">
      <Tldraw
        persistenceKey="structura"
        onMount={setEditor}
        // Required on production domains (not localhost). Keys are domain-locked, so it's fine in the bundle.
        licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined}
      />
      {editor && <VoiceAssistant editor={editor} />}
    </div>
  )
}
