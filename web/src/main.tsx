import './debug'
import i18n, { ensureLanguage } from './i18n' // initialise i18next before any component renders
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css' // design tokens — load before any other CSS
import './index.css'
// Shared global styles, relocated verbatim out of App.css (Phase 2 bucket-2).
import './styles/buttons.css' // shared icon-button primitives
import './styles/layout.css' // app shell / workspace sidebar / map-canvas frame
import './styles/sidebar.css' // toolbar, map sidebar, watchlist, content filter, WH picker
import './styles/overlays.css' // shared overlay UI (menus/dropdowns/popovers)
import './styles/tooltip.css' // global [data-tooltip] + react-flow overrides
import './styles/panes.css' // shared panel/pane styles
import './styles/scout.css' // scout/route connection rows
import './styles/forms.css' // shared form controls
import './styles/modals.css' // user stats modal
import './styles/screens.css' // full-screen states + role badge
import './styles/system-node.css' // map node card + label pills + tag badge
import './styles/modal-family.css' // modal shell + modal-based dialogs (uses .field from forms.css)
import './styles/cards.css' // draggable info cards + floating panel
import './styles/panels.css' // side panel, mass tracker, chain-effect summary (uses .btn from buttons.css)
import './styles/landing.css' // public landing page + interactive demo
import App from './App.tsx'

// Wait for the detected language's strings before the first paint. Only
// English ships with the app, so rendering immediately would show a frame of
// English to everyone else before their chunk arrived. The wait is one local
// chunk (~40K gzipped) fetched alongside the rest, and is a no-op for English
// readers; ensureLanguage resolves rather than rejects if it fails, so a bad
// chunk costs the translation, not the app.
void ensureLanguage(i18n.language).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
