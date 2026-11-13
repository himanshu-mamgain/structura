import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import './shell.css'
import './features.css'
import { keepLinksInApp } from './pwa/externalLinks'
import { initInstallPrompt } from './pwa/install'
import { watchForUpdates } from './pwa/updates'

initInstallPrompt()
keepLinksInApp()
watchForUpdates()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
