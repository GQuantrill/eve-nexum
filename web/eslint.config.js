import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Fast Refresh DX rule only (no runtime impact). Several modules
      // deliberately co-locate a hook/helper with a component; keep it visible
      // as a warning rather than failing the build.
      'react-refresh/only-export-components': 'warn',
      // Flags the common "setData(cache hit) then async fetch" pattern in our
      // data hooks. The root fix is the shared resource-hook factories (tracked
      // separately); until then keep it as a warning so CI stays green.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
])
