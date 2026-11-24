// vitest.config.ts — unit tests only.
// The include is pinned to src/ so vitest never picks up the Playwright
// Electron suite in e2e/ (those *.spec.ts files need a real Electron app and
// run via `npm run test:e2e`).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    // phonemize's ESM build imports JSON without `with { type: 'json' }`, which
    // plain Node rejects; let Vite transform it (as the app build does).
    server: { deps: { inline: ['phonemize'] } },
  },
})
