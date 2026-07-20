import './debug'
import './i18n' // initialise i18next before any component renders
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css' // design tokens — load before any other CSS
import './index.css'
import './styles/overlays.css' // shared overlay UI (menus/dropdowns/popovers), formerly in App.css
import './styles/panes.css' // shared panel/pane styles, formerly in App.css
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
