import './debug'
import './i18n' // initialise i18next before any component renders
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css' // design tokens — load before any other CSS
import './index.css'
// Shared global styles, relocated verbatim out of App.css (Phase 2 bucket-2).
import './styles/buttons.css' // shared icon-button primitives
import './styles/layout.css' // app shell / workspace sidebar / map-canvas frame
import './styles/overlays.css' // shared overlay UI (menus/dropdowns/popovers)
import './styles/tooltip.css' // global [data-tooltip] + react-flow overrides
import './styles/panes.css' // shared panel/pane styles
import './styles/scout.css' // scout/route connection rows
import './styles/forms.css' // shared form controls
import './styles/modals.css' // user stats modal
import './styles/screens.css' // full-screen states + role badge
import './styles/system-node.css' // map node card + label pills + tag badge
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
