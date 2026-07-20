import './debug'
import './i18n' // initialise i18next before any component renders
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css' // design tokens — load before any other CSS
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
