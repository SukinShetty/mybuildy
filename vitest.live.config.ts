// vitest.live.config.ts — REAL provider tests only (npm run test:live).
// Kept out of `npm test` and CI on purpose: these call paid APIs with real keys
// (see live/providers.live.test.ts).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['live/**/*.live.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
  },
})
