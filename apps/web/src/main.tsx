import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import './shell.css'
import './features.css'
import { keepLinksInApp } from './pwa/externalLinks'
import { initInstallPrompt } from './pwa/install'

initInstallPrompt()
keepLinksInApp()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
