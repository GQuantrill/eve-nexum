import { defineConfig, loadEnv, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'

// Inject the Google Tag Manager snippet at build time, but ONLY when a
// container ID is provided via VITE_GTM_ID. With no ID (the default, and what
// every self-hoster gets), nothing is injected — so a deployment never loads
// someone else's GTM container or reports its users to a third party. Our own
// deployment sets VITE_GTM_ID at build time (Docker build arg).
function gtmPlugin(gtmId: string): PluginOption {
  return {
    name: 'inject-gtm',
    transformIndexHtml() {
      if (!gtmId) return []
      return [
        {
          tag: 'script',
          injectTo: 'head-prepend',
          children:
            `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});` +
            `var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;` +
            `j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);` +
            `})(window,document,'script','dataLayer','${gtmId}');`,
        },
        {
          tag: 'noscript',
          injectTo: 'body-prepend',
          children:
            `<iframe src="https://www.googletagmanager.com/ns.html?id=${gtmId}" ` +
            `height="0" width="0" style="display:none;visibility:hidden"></iframe>`,
        },
      ]
    },
  }
}

export default defineConfig(({ mode }) => {
  // loadEnv reads .env files; fall back to process.env so the Docker build arg
  // (passed as an env var, not a file) is also picked up.
  const env = loadEnv(mode, process.cwd(), '')
  const gtmId = (env.VITE_GTM_ID ?? process.env.VITE_GTM_ID ?? '').trim()

  return {
    plugins: [react(), gtmPlugin(gtmId)],
    server: {
      port: 5174,
      proxy: {
        '/api': {
          target: process.env.API_TARGET ?? 'http://localhost:3001',
          changeOrigin: true,
        },
        '/auth': {
          target: process.env.API_TARGET ?? 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  }
})
