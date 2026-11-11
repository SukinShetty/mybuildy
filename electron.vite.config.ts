import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { resolve } from 'path'
import { copyFileSync, mkdirSync } from 'fs'

// Dev-only CSP relaxation (serve mode never ships): Vite HMR needs a websocket
// to the dev server (not covered by 'self', which is scheme-specific) and the
// React refresh preamble is an inline script. Production keeps the strict
// policy written in index.html: connect-src 'self', script-src 'self'.
function devCspPlugin(): Plugin {
  return {
    name: 'mybuildy-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replace(
          "connect-src 'self'",
          "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*"
        )
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    }
  }
}

// Buildy's voice (kokoro-worker.ts) is bundled, not loaded from node_modules:
// only the parts it uses ship, and `sharp` (an image library @huggingface/
// transformers imports but speech never calls) is replaced by an empty stub,
// so no image binaries are needed. onnxruntime-node stays external (native).
// `phonemizer` (eSpeak NG, GPL-3.0, which kokoro-js imports) is replaced by
// a stub that throws: text → phonemes is kokoro-g2p.ts (misaki + rules).
const BUNDLED_VOICE_DEPS = ['kokoro-js', '@huggingface/transformers', '@titan-design/speech-g2p', 'phonemize', 'compromise']

// misaki's pronunciation dictionaries and spaCy's tokenizer rules, read by
// @titan-design/speech-g2p from ../data/ next to its code (out/data/).
const G2P_DATA = ['us_gold.json', 'us_silver.json', 'spacy-en-tokenizer.json']

// kokoro-js reads a voice from ../voices/<id>.bin next to its code: copy
// Buildy's two (Bella and Puck, ~0.5 MB each; the other voices don't ship).
const BUILDY_KOKORO_VOICES = ['af_bella', 'am_puck']
function copyBuildyVoicePlugin(): Plugin {
  return {
    name: 'mybuildy-copy-buildy-voice',
    apply: 'build',
    writeBundle() {
      mkdirSync(resolve(__dirname, 'out/voices'), { recursive: true })
      for (const voice of BUILDY_KOKORO_VOICES) {
        copyFileSync(resolve(__dirname, `node_modules/kokoro-js/voices/${voice}.bin`), resolve(__dirname, `out/voices/${voice}.bin`))
      }
      mkdirSync(resolve(__dirname, 'out/data'), { recursive: true })
      for (const file of G2P_DATA) {
        copyFileSync(resolve(__dirname, `node_modules/@titan-design/speech-g2p/data/${file}`), resolve(__dirname, `out/data/${file}`))
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_VOICE_DEPS }), copyBuildyVoicePlugin()],
    resolve: {
      alias: {
        sharp: resolve(__dirname, 'src/main/sharp-stub.ts'),
        phonemizer: resolve(__dirname, 'src/main/phonemizer-stub.ts')
      }
    },
    build: {
      rollupOptions: {
        // bootstrap.ts is the REAL entry (named `index` so out/main/index.js
        // stays the package.json main). It applies the e2e userData override
        // and only then dynamically imports the app (src/main/index.ts), which
        // Rollup emits as a separate deferred chunk — guaranteeing the override
        // runs before any module reads app.getPath('userData') at import time.
        input: {
          index: resolve(__dirname, 'src/main/bootstrap.ts'),
          // Buildy's voice, run as a utility process (kokoro-engine.ts).
          'kokoro-worker': resolve(__dirname, 'src/main/kokoro-worker.ts'),
          // On-device listening (wake word + mic button), also a utility process (listen-engine.ts).
          'listen-worker': resolve(__dirname, 'src/main/listen-worker.ts')
        },
        output: {
          // Keep the deferred app chunk NEXT TO index.js (not in chunks/…):
          // the app resolves preload/renderer/asset paths relative to
          // __dirname (join(__dirname, '../renderer/…')), which must stay
          // out/main for those to work.
          chunkFileNames: 'app-[name].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react(), devCspPlugin()]
  }
})
