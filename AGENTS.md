# MyBuildy — Agent Instructions

<!-- Single source of truth for all AI coding agents working on this project. -->

## What is MyBuildy?

A desktop companion (Windows and macOS; Linux runs from source, untested) that helps non-technical builders work with AI coding agents in a terminal (any agent for watching, explaining, verifying and hand-off; Paste into terminal is built and tested against Claude Code, implemented but not yet end-to-end tested for Codex CLI, untested for others; it never presses Enter). MyBuildy watches the coding tool's window, explains what's happening in plain language, judges it against the user's stated goal, tracks what's built and what's missing, and gives the user the exact next prompt — which it can send into the watched window on an approving click (Windows). Narrated out loud by an always-on-top voice mascot. MyBuildy runs the loop; the user approves each step.

Inspired by Clicky's screen-aware companion model — adapted to a different problem and a different tech stack.

## Architecture

- **App shell**: Electron 44
- **UI**: React 19 + TypeScript (no framework, plain CSS custom properties)
- **State**: Zustand 5 — single store, all screens read from it
- **Build tool**: electron-vite 5 (Vite 7 for renderer, separate bundles for main/preload/renderer)
- **Screen capture**: Electron `desktopCapturer` — built-in, works on Windows and macOS
- **AI**: multi-provider via a registry in `src/main/ai/` — Anthropic (Claude), OpenAI, Google Gemini, OpenRouter, Ollama, LM Studio, and custom OpenAI-compatible endpoints. Live model lists, no default model, and a vision check (`ai/vision-gate.ts`) that gates watching until the chosen model proves it can read images. All API calls happen in the main process; keys are encrypted with Electron `safeStorage` (`secure-store.ts`) — plaintext saving is refused.
- **Voice**: the order is ElevenLabs (when the user set a key), then Buildy's own voice — Kokoro 82M, fp16, Bella (`af_bella`, default) or Puck (`am_puck`), chosen in Settings → Voice and used from the next sentence, bundled in the installer and run in a utility process (`kokoro-worker.ts`, `kokoro-engine.ts`), one sentence per chunk (`kokoro-chunks.ts`, through the queue's `chunk` option) — then the computer's own voice (Web Speech; a natural female voice, never Microsoft David). Every fallback shows a plain-English notice with the reason (`voice-health.ts`) and is logged (`voice-line engine=… voice=…`, `voice-fallback`). A line that arrives while the voice is still loading waits (the robot shows "waiting" — getting ready to speak); after `KOKORO_LOAD_TIMEOUT_MS` (45 s) it is spoken in the computer's voice with the notice, and a late load takes over again. The guidance panel highlights a sentence only while its audio plays. Playback is owned by a dedicated hidden voice window created with `backgroundThrottling: false`, driven by a serial voice queue (`voice-queue.ts`) that chunks long guidance and never cuts off mid-sentence.
- **Persistence**: local JSON in Electron `app.getPath('userData')`, plus per-project memory via the Nemp integration (`nemp-bridge.ts`), namespaced under `userData/mybuildy-memory/<projectId>` — local-only.
  - Windows: `C:\Users\<user>\AppData\Roaming\MyBuildy\`
  - macOS: `~/Library/Application Support/MyBuildy/`

### Process model

Three renderer windows, all routed by query param in `App.tsx` (`?companion` / `?guidance` / `?voice`), driven from one main process:

```
Main process (Node.js)              Renderer windows (React)
─────────────────────────           ──────────────────────────────
index.ts                            companion/   ← always-on-top mascot + pill
  ↓ creates                         guidance/    ← frosted side panel, full analysis
BrowserWindows                      voice/       ← hidden, owns audio playback
  ↓ loads
renderer/index.html?<window>
                                    Screens (guidance window):
ipc-handlers.ts                       Goal · Brainstorm · Guidance · Memory · Settings
  ↳ LIST_WINDOWS / CAPTURE_WINDOW   (capturer.ts)
  ↳ ANALYZE / BRAINSTORM_*          (analysis-loop.ts, ai/)
  ↳ COMPANION_* / PUSH_TO_TALK      (companion control, voice I/O)
  ↳ LOAD/SAVE_* , SET_SECRET        (settings + secrets, one-way)
  ↳ MEMORY_EXPORT_MYBUILDYMD          (nemp-bridge.ts)

preload/index.ts
  ↳ contextBridge → window.mybuildy.*
```

### IPC channel map

All channel names are defined in `src/renderer/src/types.ts` (`IPC` constant). Grouped overview — check `types.ts` for the exact current list before adding or renaming a channel:

| Group | Channels | Purpose |
|---|---|---|
| Watch | `mybuildy:list-windows`, `mybuildy:select-watch-source`, `mybuildy:watch-status`, `mybuildy:watch-status-get`, `mybuildy:analyze-now` | List windows, choose what's watched, and the ONE watch status (window, Auto, analysing, message) that main sends to both the robot and the Guidance tab; Analyze Now runs the watch's own analysis cycle — there is no second capture/analysis path |
| Analysis | `mybuildy:companion-analysis`, `mybuildy:analysis-result`, `mybuildy:brainstorm-start/-chunk/-done/-error` | Each analysis result, to the robot and the Guidance tab; streaming brainstorm chat |
| Providers | `mybuildy:get-provider-infos`, `mybuildy:test-connection` | Provider metadata for the Settings UI; connectivity check |
| Companion control | `mybuildy:companion-start/-stop/-pause/-resume/-quiet` (pause/resume = Auto off/on in the Guidance tab; stop ends the watch everywhere), `mybuildy:open-panel`, `mybuildy:show-companion`, `mybuildy:reset-companion`, `mybuildy:companion-shutdown`, `mybuildy:companion-state` | Watch lifecycle, quiet mode, window management |
| Voice | `mybuildy:companion-speak`, `mybuildy:companion-audio`, `mybuildy:push-to-talk`, `mybuildy:ask-question`, `mybuildy:transcribe-audio`, `mybuildy:companion-answer` | TTS playback, push-to-talk input, Whisper STT, spoken answers |
| State | `mybuildy:load-project`, `mybuildy:save-project`, `mybuildy:load-settings`, `mybuildy:save-settings`, `mybuildy:set-secret` (one-way), `memory:export-mybuildymd`, `mybuildy:copy-text` | Persistence and secrets. `LOAD_SETTINGS` returns redacted settings — raw keys never cross IPC to the renderer |

### Screen capture approach

`desktopCapturer.getSources()` runs in the main process and returns:
- Window list with JPEG thumbnails (320×200) for the window picker UI
- High-res capture for vision-model analysis

Watched-window auto-detection looks for known AI coding tools and terminal app names; if ambiguous or not found, the user picks a window manually.

### Analysis response shape

Providers must return the structured analysis JSON (see `src/main/ai/prompt-builder.ts`): what's happening, what it means, what's built/missing/broken, where the user is stuck, the best next move, the exact next prompt to paste, and a short encouraging buddy note. A second-pass prompt-quality check (`prompt-quality-check.ts`) grades the suggested prompt before it is shown.

## Key files

| File | Purpose |
|---|---|
| `src/main/index.ts` | App entry. Creates windows, tray, single-instance, registers IPC handlers. |
| `src/main/capturer.ts` | `desktopCapturer` — list windows, capture screenshots, auto-detect the coding tool. |
| `src/main/analysis-loop.ts` | The live watch → analyze → speak loop. |
| `src/main/companion-window.ts` | The always-on-top mascot window. |
| `src/main/guidance-window.ts` | The separate guidance panel window. |
| `src/main/voice-player.ts` | Hidden audio window + queue glue. |
| `src/main/voice-queue.ts` | Electron-free serial TTS queue (chunking, dedup). |
| `src/main/semantic-dedup.ts` | Near-duplicate detection (shared). |
| `src/main/kokoro-engine.ts`, `kokoro-worker.ts`, `kokoro-chunks.ts` | Buildy's own voice: the bundled Kokoro model (`resources/kokoro`, fetched and SHA-256-checked by `npm run fetch:voice`, pinned revision) loaded once in a utility process; one sentence per chunk, made ahead while the previous one plays. e2e runs skip loading it unless `MYBUILDY_E2E_KOKORO=1`. |
| `src/main/voice-health.ts` | Voice order fallbacks in plain words: which voice failed, which one speaks instead, and why. |
| `src/main/nemp-bridge.ts` | Local persistent project memory (Nemp integration). |
| `src/main/ai/provider-interface.ts`, `provider-registry.ts` | Provider contract + factory/registry for all providers. |
| `src/main/ai/providers/` | anthropic · openai-compatible (OpenAI/OpenRouter/LM Studio/custom) · gemini · ollama |
| `src/main/ai/prompt-builder.ts` | System/user prompts for analysis. |
| `src/main/ai/speech-formatter.ts` | Spoken-guidance phrasing. |
| `src/main/ai/prompt-quality-check.ts` | Second-pass prompt grader. |
| `src/main/ai/elevenlabs-tts.ts` | TTS synthesis. |
| `src/main/ipc-handlers.ts` | Registers all IPC channels. Single file for easy auditing. |
| `src/preload/index.ts` | `contextBridge` — exposes `window.mybuildy.*` to the renderer. |
| `src/renderer/src/types.ts` | Shared TypeScript interfaces + IPC channel name constants. |
| `src/renderer/src/store/` | Zustand stores — all app state. |
| `src/renderer/src/App.tsx` | Root component; routes windows by query param. |
| `src/main/projects.ts`, `projects-core.ts` | Project system — per-project memory dirs under `userData/mybuildy-memory/<projectId>`. |
| `src/main/turn-detector.ts` | Turn-end detection state machine (Electron-free, unit-tested). |
| `src/main/capture-guard.ts`, `window-presence.ts` | Watch identity by source id; missing/lost grace rules. On Windows a minimized or hidden window drops out of Electron's window list, so before declaring a window lost the loop asks Windows (fixed PowerShell, handle via env) whether the same window — same handle, same owning process — still exists. |
| `src/main/watch-log.ts` | Local diagnostic log of watch/send state changes (`userData/logs/watch.log`); titles only with `MYBUILDY_DEBUG`. |
| `src/main/display-consistency.ts` | Last step before the guidance panel shows an analysis: hand-off text is a short user-facing question (never checker reasoning); partial/failed verdicts strip "goal reached" claims. |
| `src/main/memory-durability.ts` | Project memory keeps durable facts only; momentary agent state ("currently reading", "idle") is never stored and is purged on load. |
| `src/main/ai/question-reply.ts` | Spoken-question replies: conversational reply plus a separate goal/prompt suggestion (own box, own Copy button; goals need a "Done when" check). |
| `src/renderer/src/setup/` (`SetupWizard.tsx`, `setup-model.ts`), `src/main/setup-state.ts`, `setup-permissions.ts` | The guided first-run setup: one step per screen, resumes at the saved step after a restart (macOS Screen Recording), asks macOS permissions at the step that explains them. The microphone is never requested here. |
| `src/renderer/src/companion/next-step.ts` | The line under the robot: always the next action in plain words. |
| `src/main/e2e-fakes.ts` | e2e only (`MYBUILDY_E2E=1` + `MYBUILDY_E2E_FAKES=1`, unpackaged): fake platform, macOS permissions and provider, so the wizard is tested on both platforms without an AI call. |
| `src/renderer/src/handoff.ts` | Hand-off identity shared by the guidance and companion windows: an answered or skipped hand-off clears the mascot's "!" alert for good. |
| `src/main/prompt-sender.ts`, `prompt-sender-core.ts` | Paste-into-watched-window (Windows: fixed PowerShell; macOS: fixed osascript/JXA that resolves the window owner via CGWindowList, verifies it is frontmost, then Cmd+V — never Enter/Return) + destructive-prompt guard. `send-authorization.ts` binds each paste at click time to the prompt, project, watch session and window, and allows it once. Prompt only via clipboard, target only via `MYBUILDY_TARGET_*` env vars. |
| `src/main/mac-permissions-core.ts` | macOS Screen Recording / Accessibility / Automation decisions + fixed System Settings URLs (Electron-free, unit-tested). |
| `src/main/secure-store.ts` | Encrypted API-key storage (Electron `safeStorage`). |
| `worker/` | Worker proxy — **not used in v0.1, see below**. |

## Development setup

```bash
# --legacy-peer-deps is required: npm 10+ crashes with an arborist "edgesOut" error
# on a clean install without it, even though every peer dependency resolves.
npm install --legacy-peer-deps

npm run dev             # dev server (Electron + Vite HMR)
npm run build           # production build
npm run typecheck       # tsc over main, renderer, and e2e configs
npm test                # vitest unit suite
npm run test:e2e        # Playwright e2e suite (builds first)
npm run test:e2e:packaged  # e2e against a packaged build
npm run package         # installer for this OS (Windows NSIS / macOS DMGs) → dist/
```

**First run**: open Settings, pick a provider, and enter an API key (cloud) or a Base URL (local). There is no default model — one must be chosen and pass the vision check. `npm run typecheck`, `npm run build`, and `npm test` must stay green — CI (Node 22) enforces them on every PR.

## Project system (per-project memory)

Every project gets its own memory directory: `userData/mybuildy-memory/<projectId>` (see `projects-core.ts` for the path rules; `mybuildy-memory/default` is the fallback). `projects.ts` owns the project registry and re-initializes the Nemp bridge on the active project's directory when the user switches projects. Memory never leaks across projects — `e2e/memory-isolation.spec.ts` and the unit tests in `nemp-bridge.project-scope.test.ts` assert this. The Delete-all-data path (`memory.ts` → `deleteAllMyBuildyData`) removes keys, settings, project records, and every project's memory.

## Turn detector

`src/main/turn-detector.ts` is a pure, Electron-free state machine that decides *when an analysis is worth paying for*. While the coding agent is mid-turn, the loop takes a cheap low-resolution local capture every 5 s (never sent anywhere) and feeds the change fraction in. A turn end = the screen changed and then stayed stable for two consecutive polls — analyze then (within ~10 s of the agent stopping). Continuous change for 3 minutes forces one checkpoint analysis. "Working" mode comes from the last analysis's `terminalState` or from being within 3 minutes of a paste. No timers, no `Date.now()` — callers pass timestamps, which keeps the policy fully unit-testable (`turn-detector.test.ts`).

## E2E testing

The Playwright suite in `e2e/` launches the real Electron app. Isolation works via `src/main/bootstrap.ts` — the actual entry point — which honours `MYBUILDY_USER_DATA_DIR` **only when `MYBUILDY_E2E=1`** and overrides Electron's `userData`/`sessionData` paths *before* the app modules are evaluated (dynamic import; never convert it to a static import — path-at-import-time modules would break). `e2e/helpers.ts` creates a fresh throwaway profile per launch, snapshots the real userData dir, and asserts after close that it was untouched. No e2e test ever calls an AI provider: the fresh profile has no key and no model, so analysis paths refuse by design.

- `npm run test:e2e` — builds, then runs against `out/`
- `npm run test:e2e:packaged` — runs the same suite against the packaged exe (`scripts/e2e-packaged.mjs` sets `MYBUILDY_E2E_EXE`)

## Release pipeline

`.github/workflows/release.yml` triggers on `v*` tags, guarded to the canonical repo (`SukinShetty/mybuildy`) so forks don't cut releases. It runs typecheck + tests, builds, packages a Windows NSIS installer (`MyBuildy-Setup-<version>.exe`, unsigned) on windows-latest and macOS DMGs for arm64 + x64 (`MyBuildy-<version>-<arch>.dmg`) on macos-latest, Developer ID signed with the hardened runtime and notarized by electron-builder from the `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` repository secrets, then each DMG notarized, stapled and checked by `scripts/mac-notarize-dmgs.sh` (a local build without a certificate is ad-hoc signed by `scripts/after-pack.js` instead); a final job writes one `SHA256SUMS.txt` over all files and puts them on the release for the tag with `scripts/release-assets.mjs`: an existing release (draft or published) gets its files replaced in place and keeps its state; with no release yet, ONE **draft** is created — publishing is a manual step. `mac-signed-build.yml` (manual, `workflow_dispatch`) builds, signs and notarizes the same two DMGs and uploads them as workflow artifacts only — never to a release. Every job that packages the app first runs `npm run fetch:voice` (cached): the voice model is bundled via `build.extraResources`, `onnxruntime-node` is unpacked from the asar, and `scripts/after-pack.js` keeps only the target platform's engine binaries; `scripts/mac-notarize-dmgs.sh` also checks the engine's native files are Developer ID signed with the hardened runtime, and the signed-build workflow launches the signed apps to prove the voice loads. `npm run test:live` (not in CI) also speaks with Kokoro and ElevenLabs, and runs the real setup check and one screen analysis for every curated model on Anthropic, OpenAI and OpenRouter, with keys from a local file. `ci.yml` runs typecheck + build + test on Node 22 on ubuntu-latest and macos-latest for every push/PR to main.

## Release rule

- **Never delete a published release**, and never delete its tag. Download links (the website, testers) point straight at `releases/download/<tag>/<file>`; deleting the release or tag takes every one of them offline.
- **Always replace assets in place.** To re-release the same version, move the tag with a single force-update (never delete and re-push it); `release.yml` then replaces each file on the existing release one at a time (upload under a temporary name, move the old file aside, give the new file the real name, delete the old one — `SHA256SUMS.txt` last), re-downloads every file to check its SHA256, and leaves the release published or draft exactly as it was.
- Only a person publishes a release. The version number changes only when the maintainer says so.

## Worker (not used in v0.1)

The proxy in `worker/` is **not used by the app in v0.1** and is kept only for a possible hosted option later. It is disabled pending authentication work: as written it is an unauthenticated open relay for whoever holds the URL. **Do not deploy it or point the app at it** until per-user auth lands. See `worker/README.md` and `SECURITY.md`.

## Code style

### Naming
- Optimize for clarity over concision. A developer with zero context should understand what a variable or function does from its name alone.
- `analyzeClaudeCodeScreen` not `analyze`. `captureWindowForAnalysis` not `capture`.
- IPC handlers: prefix with the channel name they handle.

### React / TypeScript
- No classes — functional components only
- All async operations: `async/await`, not `.then()`
- Types: explicit everywhere. No `any`.
- Inline styles (CSSProperties objects) — no CSS modules, no Tailwind (keep deps minimal)
- State: all app state lives in Zustand. No prop drilling beyond one level.

### Do NOT
- Do not add features beyond what was asked
- Do not add comments to code you didn't touch
- Do not add a router library — screen routing is done via Zustand state
- Do not add a component library — use CSS custom properties and plain HTML elements
- Do not put API calls in React components — all AI/storage calls go through IPC

## Security notes

- `contextIsolation: true`, `nodeIntegration: false` — the renderer cannot access Node.js
- All external API calls happen in the main process through `providerFetch` (no redirects, Stop-cancellable). A key typed in Settings reaches main once via `mybuildy:set-secret` (one-way) and is stored encrypted; saved keys are never sent back to any renderer
- CSP in `index.html` restricts what the renderer can load
- API keys stored encrypted (Electron `safeStorage`) in userData, never in the app bundle or version control; plaintext saving is refused
- MyBuildy sends screen captures to the AI provider the user configures — treat capture contents as sensitive (see `SECURITY.md`)
