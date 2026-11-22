import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import './shell.css'
import './features.css'
import { keepLinksInApp } from './pwa/externalLinks'
import { initInstallPrompt } from './pwa/install'
import { watchForUpdates } from './pwa/updates'
import { startAccount } from './account/account'

initInstallPrompt()
keepLinksInApp()
watchForUpdates()
// Loads Supabase only if this browser is signed in to Studia, or is coming back from GitHub.
startAccount()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
