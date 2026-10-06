// types.ts
// Shared TypeScript interfaces used across the renderer, preload, and main process.
// This file is the contract — if you change a shape here, update the corresponding
// IPC handler and any consumer.

// ─── Project Memory ───────────────────────────────────────────────────────────

export type ExplanationStyle = 'very_simple' | 'balanced' | 'technical'

// ─── Goal ───────────────────────────────────────────────────────────────────
// The user's stated purpose for what they're building. Every analysis is judged
// against this so the user knows whether each step moves them toward the goal.

export interface Goal {
  purpose: string            // the main "what are you building" answer
  audience?: string          // "Who is this for?"
  mostImportant?: string     // "single most important thing it should do"
  successCriteria?: string   // "what does success look like in one month"
  createdAt: string          // ISO timestamp
  lastReviewedAt?: string    // when the goal was last shown to / reviewed by the user
}

export function emptyGoal(): Goal {
  const now = new Date().toISOString()
  return { purpose: '', createdAt: now, lastReviewedAt: now }
}

// ─── Project records (project-scoped memory) ──────────────────────────────────
// One record per project. ALL memory (Nemp store, project memory, goal,
// verifier pending outcomes) is namespaced by `id`; the active project id is
// persisted in userData/projects.json.

export interface ProjectRecord {
  id: string            // uuid
  name: string          // display name (renameable)
  goalText: string      // the goal's purpose text (kept in sync on goal save)
  createdAt: string     // ISO timestamp
  lastActiveAt: string  // ISO timestamp — bumped when the project becomes active
}

// Result of deleting a project (main/projects.ts deleteProject).
export type DeleteProjectResult =
  | { deleted: true; activeProjectId: string; switched: boolean }
  | { deleted: false; reason: 'unknown' | 'last' | 'watching' }

// Record + derived info for the project switcher UI.
export interface ProjectSummary extends ProjectRecord {
  featureCount: number  // completed features recorded in this project's memory
}

export interface ProjectMemory {
  projectName: string
  productSummary: string
  targetUser: string
  coreProblem: string
  completedFeatures: string[]
  missingFeatures: string[]
  activeBlockers: string[]
  explanationStyle: ExplanationStyle
  brainstormSummary: string   // Extracted from the brainstorm chat
  goal: Goal | null           // The user's stated goal (null until set; skipping leaves it null)
  goalPromptSeen: boolean      // true once the user has set OR skipped the goal prompt
  createdAt: string           // ISO date string
  updatedAt: string
  // Compact project-memory context (from the Nemp bridge) injected into the
  // analysis system prompt. Optional + transient — not persisted to disk.
  memoryContext?: string
}

// ─── Nemp Memory layer (loop engineering Block 2) ─────────────────────────────
// A single flat memory entry, mirroring Nemp's on-disk Memory shape.

export interface MemoryEntry {
  key: string
  value: string
  tags: string[]
  timestamp: string  // ISO
  source: string
}

// Structured view of memory for the Memory screen.
export interface MemorySnapshot {
  goal: Goal | null
  completed: MemoryEntry[]
  inProgress: MemoryEntry[]
  blockersOpen: MemoryEntry[]
  blockersResolved: MemoryEntry[]
  decisions: MemoryEntry[]
  patterns: MemoryEntry[]
  recent: MemoryEntry[]
}

export function emptyProjectMemory(): ProjectMemory {
  const now = new Date().toISOString()
  return {
    projectName: '',
    productSummary: '',
    targetUser: '',
    coreProblem: '',
    completedFeatures: [],
    missingFeatures: [],
    activeBlockers: [],
    explanationStyle: 'very_simple',
    brainstormSummary: '',
    goal: null,
    goalPromptSeen: false,
    createdAt: now,
    updatedAt: now,
  }
}

// ─── AI Provider ──────────────────────────────────────────────────────────────

export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'openrouter'
  | 'ollama'
  | 'lmstudio'
  | 'custom'

// ─── Settings ─────────────────────────────────────────────────────────────────
// SECURITY: API keys are secrets. They live ONLY in the main process (encrypted via
// secure-store) and are never sent to the renderer. The renderer holds RedactedSettings
// (non-secret fields + has* booleans). `AppSettings` is the MAIN-internal full shape
// with secrets injected at call time — it must never cross IPC to the renderer.

// Names of the encrypted secrets managed by the main-process secure store.
export type SecretName =
  | 'anthropicApiKey'
  | 'openaiApiKey'
  | 'geminiApiKey'
  | 'openrouterApiKey'
  | 'customApiKey'
  | 'elevenLabsApiKey'

// Non-secret settings — persisted to disk and safe to accept from / send to the renderer.
export interface NonSecretSettings {
  provider: ProviderType         // Which AI provider to use
  modelId: string                // Model identifier chosen by the user ('' until they pick one)
  baseUrl: string                // Base URL — used by ollama, lmstudio, custom, openrouter
  autoAnalysisIntervalSeconds: number
  elevenLabsVoiceId: string      // ElevenLabs voice ID (default: Rachel — warm, friendly)
  hourlyCallCap: number          // Cost guard: max provider calls per rolling hour (20–600)
  captureNoticeAccepted: boolean // one-time privacy disclosure accepted (first window pick)
}

// Cost guard bounds (Settings-editable).
export const HOURLY_CALL_CAP_MIN = 20
export const HOURLY_CALL_CAP_MAX = 600
export const HOURLY_CALL_CAP_DEFAULT = 120

// MAIN-internal full settings: non-secret fields + secrets injected from secure-store.
// NEVER serialize this to the renderer.
export interface AppSettings extends NonSecretSettings {
  apiKey: string                 // resolved from secure-store for the active provider
  elevenLabsApiKey: string       // resolved from secure-store
}

// What the renderer receives/holds: non-secret settings + which secrets are set.
// Only booleans — never the secret values.
export interface RedactedSettings extends NonSecretSettings {
  hasApiKey: boolean             // a key for the SELECTED provider exists (convenience)
  hasElevenLabsKey: boolean      // an ElevenLabs key exists in secure-store
  secretFlags: Partial<Record<SecretName, boolean>>  // per-secret existence (for the UI)
  /** A custom key saved by an earlier version is stored but not yet linked to an endpoint, so it is not used. */
  customKeyNeedsEndpoint?: boolean
}

const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM' // Rachel — warm, conversational

export function defaultNonSecretSettings(): NonSecretSettings {
  return {
    provider: 'anthropic',
    // NO default model: the user must pick one from the live model list.
    modelId: '',
    baseUrl: '',
    autoAnalysisIntervalSeconds: 30,
    elevenLabsVoiceId: DEFAULT_VOICE_ID,
    hourlyCallCap: HOURLY_CALL_CAP_DEFAULT,
    captureNoticeAccepted: false,
  }
}

export function defaultSettings(): AppSettings {
  return { ...defaultNonSecretSettings(), apiKey: '', elevenLabsApiKey: '' }
}

export function defaultRedactedSettings(): RedactedSettings {
  return { ...defaultNonSecretSettings(), hasApiKey: false, hasElevenLabsKey: false, secretFlags: {} }
}

// Providers that run without an API key — they just need a reachable baseUrl.
const LOCAL_PROVIDERS: ReadonlySet<ProviderType> = new Set(['ollama', 'lmstudio', 'custom'])

// True when the app can actually reach a provider: either an API key is stored
// for the selected provider, or the provider is local and a baseUrl is set.
// A baseUrl alone on a cloud provider is NOT enough — those require a key.
export function isApiConfigured(
  settings: Pick<RedactedSettings, 'provider' | 'hasApiKey' | 'baseUrl'>
): boolean {
  return settings.hasApiKey || (LOCAL_PROVIDERS.has(settings.provider) && settings.baseUrl.trim() !== '')
}

// True only when the app is fully usable: a reachable provider AND a chosen
// model. With no key or no model, analysis and Brainstorm refuse with
// "Choose a model in Settings".
export function isModelConfigured(
  settings: Pick<RedactedSettings, 'provider' | 'hasApiKey' | 'baseUrl' | 'modelId'>
): boolean {
  return isApiConfigured(settings) && settings.modelId.trim() !== ''
}

export const CHOOSE_MODEL_MESSAGE = 'Choose a model in Settings'

/** Result of the setup check (a red test image the model must name). */
export interface VisionCheckResult {
  success: boolean
  message: string            // plain English — never raw provider text
  latencyMs: number | null
  visionPassed: boolean
  /** Why it failed (e.g. 'billing', 'bad-request'); null on a pass. */
  errorKind: string | null
}

/** Where each cloud provider's credits are topped up (the billing button). */
export const PROVIDER_BILLING_URLS: Partial<Record<ProviderType, string>> = {
  anthropic: 'https://console.anthropic.com/settings/billing',
  openai: 'https://platform.openai.com/settings/organization/billing/overview',
  openrouter: 'https://openrouter.ai/settings/credits',
  gemini: 'https://aistudio.google.com/app/billing',
}

/** Shown on the AI key step: subscriptions are not API credits. */
export const API_CREDITS_NOTE =
  "Your key needs credits on your provider's account. ChatGPT Plus and Claude Pro subscriptions don't include these."

/** Failures where trying the next curated model is the sensible next step. */
export function suggestsNextModel(errorKind: string | null): boolean {
  return errorKind === 'bad-request' || errorKind === 'model-not-found' || errorKind === 'cannot-read-images'
    || errorKind === 'empty-answer' || errorKind === 'unknown'
}

// Shown when the OS offers no encrypted key storage (safeStorage unavailable).
// MyBuildy REFUSES to write keys in plain text — saving fails with this message.
export const NO_SECURE_STORAGE_MESSAGE =
  "This computer has no secure key storage, so MyBuildy won't save keys in plain text."

// One-time privacy disclosure shown the FIRST time the user picks a window to
// watch. Continue persists captureNoticeAccepted; Cancel aborts the pick.
export const CAPTURE_NOTICE_MESSAGE =
  "MyBuildy sends screenshots of the one window you choose, plus this project's memory, " +
  'to the AI provider you chose. Your keys and memory are stored only on this computer.'

// Main refuses every capture/upload path until the notice above is accepted —
// whatever a renderer does. This is the refusal text (renderers match on it).
export const CAPTURE_NOTICE_REQUIRED_MESSAGE =
  'Accept the one-time notice first: it explains what MyBuildy sends and to whom.'

// ─── macOS privacy permissions ───────────────────────────────────────────────
// Without these, macOS fails SILENTLY (black captures, keystrokes that do
// nothing), so MyBuildy checks first and says exactly what to turn on. Shown on
// the mascot label and in the guidance panel with an "Open System Settings"
// button (main maps the kind to a fixed System Settings URL).

export type MacPermission = 'screen' | 'accessibility' | 'automation'

export const MAC_PERMISSION_MESSAGES: Record<MacPermission, string> = {
  screen:
    'macOS needs permission to see your screen. Open System Settings > Privacy & Security > ' +
    'Screen Recording (Screen & System Audio Recording on newer macOS), turn on MyBuildy, then quit and reopen MyBuildy. ' +
    'macOS only applies this permission after a restart.',
  accessibility:
    'macOS needs permission to type for you. Open System Settings > Privacy & Security > ' +
    'Accessibility and turn on MyBuildy. The prompt is on your clipboard: press Cmd+V, then Return.',
  automation:
    'macOS needs permission for MyBuildy to control System Events (that is how it presses Cmd+V and Return). ' +
    'Open System Settings > Privacy & Security > Automation, and under MyBuildy turn on System Events. ' +
    'The prompt is on your clipboard: press Cmd+V, then Return.',
}

// macOS says Screen Recording IS granted but the chosen window came back empty:
// either the permission was just granted (macOS applies it only after a
// restart) or the window is minimized / on another desktop.
export const MAC_BLANK_CAPTURE_MESSAGE =
  "MyBuildy can't see anything in that window. If you just turned on Screen Recording, " +
  'quit and reopen MyBuildy. If the window is minimized or on another desktop, bring it into view and pick it again.'

// ─── Where your data goes (Settings wording) ─────────────────────────────────
// Every privacy sentence in Settings comes from here so it is always true:
// "local" only when the model really runs on this computer, the real host for a
// remote custom endpoint, and ElevenLabs named whenever a voice key is saved.

const CLOUD_PROVIDER_NAMES: Partial<Record<ProviderType, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
}

function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

export function dataDestinationNote(input: { provider: ProviderType; baseUrl: string; hasElevenLabsKey: boolean }): string {
  const voice = input.hasElevenLabsKey ? ' Spoken guidance and voice questions are sent to ElevenLabs.' : ''
  const keys = 'Saved keys are stored encrypted on this computer and are never sent back to this screen.'
  if (input.provider === 'ollama' || input.provider === 'lmstudio' ||
      (input.provider === 'custom' && isLocalEndpoint(input.baseUrl))) {
    return `Your model runs on this computer, so screenshots and prompts stay on this computer.${voice}`
  }
  if (input.provider === 'custom') {
    let host = 'your custom endpoint'
    try { host = new URL(input.baseUrl).host || host } catch { /* keep the generic name */ }
    return `Screenshots and prompts are sent to ${host}.`
  }
  return `Screenshots and prompts are sent to ${CLOUD_PROVIDER_NAMES[input.provider] ?? 'your AI provider'}. ${keys}`
}

// ─── Paste into terminal ─────────────────────────────────────────────────────
// MyBuildy pastes the prompt into the watched terminal but NEVER presses Enter:
// the user reads it and runs it.

export const PASTE_BUTTON_LABEL = 'Paste into terminal'
export const PASTE_SUCCESS_MESSAGE = 'Pasted into your terminal. Read it, then press Enter to run it.'

/** Plain-English message for a paste that did not happen (permission failures have their own notice). */
export function pasteFailureMessage(result: SendPromptResult, isMac: boolean): string {
  const pasteKey = isMac ? 'Cmd+V' : 'Ctrl+V'
  switch (result.reason) {
    case 'stale':
      return `${result.detail || 'The prompt changed before it could be pasted.'} Nothing was pasted.`
    case 'not_eligible':
      return `${result.detail || "Pasting isn't possible right now."} Nothing was pasted.`
    case 'window_not_in_front':
      return `Your terminal wasn't in front at the last moment, so nothing was pasted. The prompt is on your clipboard: press ${pasteKey} in your terminal, read it, then press Enter.`
    default:
      return `Pasting didn't finish, so the prompt is on your clipboard instead: press ${pasteKey} in your terminal, read it, then press Enter.`
  }
}

/** Which permission a failed send needs, or null if the failure was something else. */
export function permissionForSendFailure(reason: SendFailureReason | undefined): MacPermission | null {
  if (reason === 'accessibility_permission') return 'accessibility'
  if (reason === 'automation_permission') return 'automation'
  return null
}

// ─── Live model lists (fetched in MAIN with the stored key) ──────────────────

export interface ModelChoice {
  id: string
  label: string
  group?: string                   // e.g. "Open-weight models" / "Other models" (OpenRouter)
  promptPricePerM?: number | null  // $ per million input tokens (when the provider reports it)
  completionPricePerM?: number | null
  suggested?: boolean              // rule-based tag; only ever set on a live-listed model
  curated?: boolean                // hand-picked vision chat model, shown by default (see model-suggestions.ts)
}

export interface ModelListResult {
  models: ModelChoice[]
  error: string | null   // plain-English error when the list could not be fetched
}

// ─── Screen Capture ───────────────────────────────────────────────────────────

export interface WindowSource {
  id: string              // desktopCapturer source ID
  name: string            // Window title / application name
  thumbnailBase64: string // low-res JPEG thumbnail for the window picker UI
}

export interface CaptureResult {
  imageBase64: string          // JPEG screenshot for Claude vision
  windowTitle: string
  sourceId: string
  capturedAt: string           // ISO date string
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

// The exact JSON shape the AI must return for screen analysis.
// Keep this in sync with the system prompt in prompt-builder.ts.
// NOTE: Screen-agnostic — works for any watched window, not just Claude Code.

// How the current activity relates to the user's goal.
export type GoalAlignment = 'on-track' | 'drift' | 'blocked'

// Model-reported identity of the AI coding agent visible in the watched window.
// Drives the send-button label ("Send to Claude Code" / "Send to Codex" /
// "Send") and the permission-alert wording. Parser defaults to 'other' when
// the model omits it or returns something unrecognized.
export type AgentName = 'claude_code' | 'codex' | 'other'

// Model-classified state of any AI coding agent (Claude Code, Codex CLI or
// similar) visible in the watched window. Gates the "Send to Claude Code"
// button: sending is only allowed when the agent is idle and awaiting input.
export type TerminalState =
  | 'awaiting_prompt'      // agent input box visible, empty and idle
  | 'working'              // agent is mid-turn (generating / running tools)
  | 'permission_prompt'    // agent is asking y/n or for approval
  | 'not_a_coding_agent'   // shell prompt, editor, browser, anything else
  | 'unknown'

// ─── Verifier (loop engineering Block 4) ──────────────────────────────────────
// After MyBuildy suggests a prompt, the NEXT analysis verifies whether the pasted
// prompt achieved its intended outcome. This verdict is computed in the main
// process (verifier-check.ts) and attached transiently to the following analysis.
export type VerificationStatus = 'success' | 'failed' | 'partial'

export interface VerificationVerdict {
  status: VerificationStatus
  note: string   // one plain-English sentence about what happened
}

export interface AnalysisResult {
  screenContentVisible: boolean
  whatIsHappening: string           // Plain language: what's happening on screen right now
  whatItMeans: string               // Why this matters for the product
  whatIsBuilt: string[]             // Features/things that appear to be done
  whatIsMissing: string[]           // Features/things still needed
  whatIsBroken: string[]            // Errors, failures, broken things
  whereUserIsStuck: string | null   // If the user appears stuck, describe it; else null
  bestNextMove: string              // One clear sentence: what to do right now
  nextPrompt: string                // Suggested next prompt or action
  // Verifier (Block 4): a one-sentence description of what success looks like for
  // nextPrompt. Present whenever nextPrompt is non-empty; the next cycle checks it.
  expectedOutcome?: string
  builderNote: string               // Encouraging, buddy-style note from MyBuildy
  // Goal alignment — present only when the user has set a goal (see Goal type).
  goalAlignment?: GoalAlignment | null
  alignmentNote?: string            // One-sentence plain-English reason for the alignment judgment
  // One sentence: what MyBuildy currently understands the user is building (memory + screen).
  projectUnderstandingNote?: string
  // True only for a NEW, fundamentally different blocker. When true the voice
  // queue truncates after the current chunk so the alert is spoken next.
  isCriticalOverride?: boolean
  // Hand-off detection (Block 6): true ONLY for genuine human-judgment moments
  // (architectural tradeoffs, irreversible commitments, legal/compliance, or two
  // equally-valid approaches). Never for routine coding choices MyBuildy can default.
  needsHumanJudgment?: boolean
  humanJudgmentReason?: string      // one plain-English sentence describing the decision
  // Verifier (Block 4): verdict on the PREVIOUS suggested prompt, attached by the
  // main-process loop (never produced by the model, never persisted).
  verification?: VerificationVerdict | null
  // Set by MAIN (display-consistency.ts) only when the Verifier passed AND the
  // analysis says the user's goal is reached — the robot's goal-complete moment.
  goalReached?: boolean
  // Model-classified coding-agent state (see TerminalState). Parser defaults to
  // 'unknown' when the model omits it.
  terminalState?: TerminalState
  // Which coding agent the model saw on screen (see AgentName). Parser defaults
  // to 'other' when missing/invalid.
  agentName?: AgentName
  // Destructive-prompt guard (speed bump, not a sandbox): computed by MAIN from
  // the displayed nextPrompt via detectDestructivePrompt. Non-null arms the
  // two-click "Review first" flow in the guidance panel.
  sendGuard?: { reason: string } | null
  // Cost guard: provider calls in the current rolling hour, attached by MAIN
  // when the analysis is pushed (shown in the guidance panel footer).
  callsThisHour?: number
  // Identity of the currently-displayed prompt, assigned by the MAIN process
  // (analysis-loop) whenever nextPrompt is set or patched. The renderer sends
  // ONLY this id back on "Send to Claude Code" — main resolves the text itself
  // and rejects ids that no longer match the displayed prompt.
  promptId?: string
  analyzedAt: string                // ISO date string
  analysisDurationMs: number
}

// ─── Send-to-terminal (approve-and-send) ──────────────────────────────────────
// Main computes eligibility and pushes it to the guidance window; the renderer
// only renders it (disabled button + tooltip) and never decides for itself.

export interface SendEligibility {
  canSend: boolean
  sendBlockedReason: string   // tooltip text when canSend is false; '' when true
}

export type SendFailureReason =
  | 'window_not_in_front'
  | 'timeout'
  | 'not_eligible'
  | 'stale'
  | 'unknown'
  | 'accessibility_permission'  // macOS: MyBuildy may not post keystrokes (Accessibility)
  | 'automation_permission'     // macOS: MyBuildy may not control System Events (Automation)

export interface SendPromptResult {
  sent: boolean
  reason?: SendFailureReason
  /** Plain-English explanation when a paste was aborted (e.g. what changed since the click). */
  detail?: string
}

// ─── Guidance panel ───────────────────────────────────────────────────────────
// The guidance panel lives in its own floating window (separate from the mascot
// window) so guidance content can never overflow or push the mascot out of view.
// The companion forwards either an analysis result or a spoken-question answer.

// A goal or prompt the user asked for in a spoken question ("give me a goal
// for…", "what should I tell the agent…"). Shown in its own box beneath the
// conversational reply, with a Copy button that copies only this.
export interface AnswerSuggestion {
  kind: 'goal' | 'prompt'
  text: string        // goal: what to build; prompt: the exact prompt for the agent
  doneWhen?: string   // goal only: a check that can be verified ("Done when …")
}

// Result of choosing a window to watch: started, or the plain-English reason not.
export interface WatchStartResult {
  started: boolean
  message: string | null
}

// The one watch, as the robot and the Guidance tab both show it. Main owns it
// (analysis-loop.ts) and sends it to both windows on every change.
export interface WatchStatus {
  windowName: string | null   // the watched window; null = nothing watched
  auto: boolean               // watching continuously (the robot watching, Auto on); false = paused / off
  analyzing: boolean          // an analysis of the watched window is running right now
  message: string | null      // why watching stopped or can't start, or what needs the user
}

// MyBuildy is speaking with the computer's voice because the ElevenLabs key
// failed (main/voice-health.ts). Shown on the robot and in Settings; never silent.
export interface VoiceFallback {
  code: string
  reason: string   // plain English: why ElevenLabs didn't work
}
export const VOICE_FALLBACK_HEADLINE = "Your voice key isn't working, so MyBuildy is using your computer's voice"

// "Analyze Now": started, already running (its result is on the way), or no window watched yet.
export type AnalyzeNowResult = 'started' | 'already-running' | 'no-window'

// ─── First-run setup wizard ──────────────────────────────────────────────────
export interface SetupPermissionStatus {
  screen: 'granted' | 'not-granted' | 'unknown'
  accessibility: boolean
  automation: 'granted' | 'denied' | 'unknown'
}

export interface SetupInfo {
  needed: boolean          // show the wizard on launch
  step: string | null      // where to resume (saved on every step change)
  platform: string         // which platform's steps to show
}

export interface QuestionAnswer {
  question: string
  answer: string                 // the conversational reply (never contains the suggestion)
  suggestion?: AnswerSuggestion
}

export type GuidancePayload =
  | { kind: 'analysis'; analysis: AnalysisResult }
  | { kind: 'answer'; answer: QuestionAnswer }
  | { kind: 'message'; message: string }   // plain notice (e.g. "No guidance yet")
  | { kind: 'permission'; permission: MacPermission }  // macOS permission missing — message + Open System Settings

// ─── Brainstorm Chat ──────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string  // ISO date string
}

// Extracted structured project data after the brainstorm conversation concludes
export interface ExtractedProjectData {
  projectName: string
  productSummary: string
  targetUser: string
  coreProblem: string
  brainstormSummary: string
  // A concrete, paste-ready first Claude Code prompt to start building. Produced
  // once the product is sufficiently defined; empty string until then.
  firstPrompt: string
}

// ─── IPC Channel Names ────────────────────────────────────────────────────────
// Centralized so typos don't cause silent failures.

export const IPC = {
  LIST_WINDOWS:        'mybuildy:list-windows',
  ANALYZE_NOW:         'mybuildy:analyze-now',         // renderer → main (one analysis of the watched window, now)
  WATCH_STATUS:        'mybuildy:watch-status',        // main → robot + main window (the one WatchStatus)
  WATCH_STATUS_GET:    'mybuildy:watch-status-get',    // renderer → main (current WatchStatus + the analysis on display)
  ANALYSIS_RESULT:     'mybuildy:analysis-result',     // main → main window (each analysis the robot gets, for the Guidance tab)
  VOICE_FALLBACK:      'voice:fallback',               // main → robot + main window (VoiceFallback, or null when ElevenLabs works again)
  VOICE_FALLBACK_GET:  'voice:fallback-get',           // renderer → main (the current VoiceFallback or null)
  OPEN_SETTINGS:       'mybuildy:open-settings',       // robot → main (show the panel on Settings)
  SHOW_SCREEN:         'mybuildy:show-screen',         // main → main window (switch to a screen, e.g. 'settings')
  BRAINSTORM_START:    'mybuildy:brainstorm-start',
  BRAINSTORM_CHUNK:    'mybuildy:brainstorm-chunk',    // main → renderer push
  BRAINSTORM_DONE:     'mybuildy:brainstorm-done',     // main → renderer push
  BRAINSTORM_ERROR:    'mybuildy:brainstorm-error',    // main → renderer push
  GET_PROVIDER_INFOS:  'mybuildy:get-provider-infos',  // renderer → main (provider metadata)
  TEST_CONNECTION:     'mybuildy:test-connection',     // renderer → main (vision check with a red test image)
  LIST_MODELS:         'mybuildy:list-models',         // renderer → main (live model list, stored key, 10-min cache)
  VISION_STATUS:       'mybuildy:vision-status',       // renderer → main (has this provider+model passed the vision check?)
  COMPANION_ANALYSIS:  'mybuildy:companion-analysis',  // main → companion (new analysis result)
  COMPANION_STATE:     'mybuildy:companion-state',     // main → companion (idle/thinking/speaking)
  COMPANION_SPEAK:     'mybuildy:companion-speak',     // main → companion (trigger voice)
  COMPANION_START:     'mybuildy:companion-start',     // renderer → main (start watching)
  COMPANION_STOP:      'mybuildy:companion-stop',      // renderer → main (stop watching)
  COMPANION_PAUSE:     'mybuildy:companion-pause',     // renderer → main (Auto off: pause watching)
  COMPANION_RESUME:    'mybuildy:companion-resume',    // renderer → main (Auto on: resume watching)
  COMPANION_QUIET:     'mybuildy:companion-quiet',     // renderer → main (quiet mode toggle)
  OPEN_PANEL:          'mybuildy:open-panel',          // companion → main (open full panel)
  RESET_COMPANION:     'mybuildy:reset-companion',    // any → main (reset companion position)
  SHOW_COMPANION:      'mybuildy:show-companion',     // any → main (bring companion to front)
  COMPANION_SHUTDOWN:  'mybuildy:companion-shutdown',  // main → companion (stop everything, app is quitting)
  COMPANION_AUDIO:     'mybuildy:companion-audio',    // main → companion (ElevenLabs audio buffer to play)
  PUSH_TO_TALK:        'mybuildy:push-to-talk',       // companion → main (voice input audio)
  ASK_QUESTION:        'mybuildy:ask-question',       // companion → main (spoken question text)
  TRANSCRIBE_AUDIO:    'mybuildy:transcribe-audio',   // companion → main (audio buffer for Whisper STT)
  COMPANION_ANSWER:    'mybuildy:companion-answer',   // main → companion (answer to spoken question)
  SELECT_WATCH_SOURCE: 'mybuildy:select-watch-source', // robot / main window → main (user picks a window)
  GUIDANCE_SHOW:       'guidance:show',             // companion → main (show guidance panel with payload)
  GUIDANCE_HIDE:       'guidance:hide',             // companion → main (hide guidance panel)
  GUIDANCE_DATA:       'guidance:data',             // main → guidance window (payload to render)
  GUIDANCE_RESIZE:     'guidance:resize',           // guidance window → main (report content height)
  GUIDANCE_SHOW_LAST:  'guidance:show-last',         // companion/tray → main (re-show cached guidance)
  GUIDANCE_SET_FOCUSABLE: 'guidance:set-focusable',  // guidance window → main (temporarily focusable while typing a hand-off answer)
  OPEN_LOG_FOLDER:     'mybuildy:open-log-folder',   // main window → main (Settings: open the watch-log folder)
  SETUP_INFO:          'setup:info',                 // main window → main (show the wizard? where to resume? platform)
  SETUP_SAVE_STEP:     'setup:save-step',            // main window → main (remember the current step, for resume)
  SETUP_FINISH:        'setup:finish',               // main window → main (setup completed)
  SETUP_RESET:         'setup:reset',                // main window → main (Settings: Run setup again)
  SETUP_PERMISSIONS:   'setup:permissions',          // main window → main (live macOS permission status)
  SETUP_OPEN_PANE:     'setup:open-pane',            // main window → main (open a macOS Privacy & Security pane)
  SETUP_REGISTER_SCREEN: 'setup:register-screen',    // main window → main (make macOS list MyBuildy under Screen Recording)
  SETUP_REQUEST_PASTE: 'setup:request-paste',        // main window → main (show the Accessibility + Automation prompts now)
  SETUP_RESTART:       'setup:restart',              // main window → main (quit and reopen; resumes at the saved step)
  HANDOFF_RESOLVED:    'guidance:handoff-resolved',  // guidance window → main → companion ("I'll decide" / "Skip for now": clear the "!" badge)
  COPY_TEXT:           'mybuildy:copy-text',          // renderer → main (write to clipboard; works in non-focusable windows)
  SEND_PROMPT:         'mybuildy:send-prompt',        // guidance window → main (send displayed prompt by id into watched window)
  SEND_ELIGIBILITY:    'mybuildy:send-eligibility',   // main → guidance window (canSend + sendBlockedReason)
  SEND_STATUS:         'mybuildy:send-status',        // main → companion (transient "Sent" mascot label)
  COMPANION_DRAG:      'mybuildy:companion-drag',     // main → companion (window drag started/ended + direction — running animation)
  LOAD_PROJECT:        'mybuildy:load-project',
  SAVE_PROJECT:        'mybuildy:save-project',
  LOAD_SETTINGS:       'mybuildy:load-settings',     // → RedactedSettings (never raw keys)
  SAVE_SETTINGS:       'mybuildy:save-settings',     // non-secret settings only
  SET_SECRET:          'mybuildy:set-secret',        // renderer → main, one-way (store an API key)
  CAPTURE_NOTICE_ACCEPT: 'mybuildy:capture-notice-accept', // companion/main → main (persist the one-time privacy disclosure)
  DELETE_ALL_DATA:     'mybuildy:delete-all-data',   // main window → main (wipe keys/settings/memory, restart to first run)
  OPEN_PERMISSION_SETTINGS: 'mybuildy:open-permission-settings', // guidance window → main (macOS: open the Privacy & Security pane for a MacPermission)
  GOAL_GET:            'goal:get',                 // renderer → main (read current goal)
  GOAL_SET:            'goal:set',                 // renderer → main (create/replace goal)
  GOAL_UPDATE:         'goal:update',              // renderer → main (merge into goal, e.g. lastReviewedAt)
  // ─── Projects (project-scoped memory) ────────────────────────────────────
  PROJECTS_LIST:       'projects:list',            // renderer → main → ProjectSummary[]
  PROJECTS_CREATE:     'projects:create',          // renderer → main (create + switch) → ProjectRecord
  PROJECTS_RENAME:     'projects:rename',          // renderer → main → ProjectRecord
  CONFIRM_CUSTOM_KEY_ENDPOINT: 'mybuildy:confirm-custom-key-endpoint', // main window → main (link a legacy custom key to the saved endpoint)
  STOPPED:             'mybuildy:stopped',         // main → main window (Stop pressed: cancel Guidance runs + auto timer)
  PROJECTS_SWITCHED:   'projects:switched',        // main → all windows (active project changed: drop per-project UI state)
  PROJECTS_SWITCH:     'projects:switch',          // renderer → main (set active) → ProjectRecord
  ROBOT_HIDE:          'robot:hide',               // robot → main (Hide: robot + guidance go away, watching continues)
  APP_QUIT:            'app:quit',                 // robot / main window → main (confirmed Quit: shut everything down)
  ROBOT_SCALE_GET:     'robot:scale-get',          // renderer → main → number (robot size)
  ROBOT_SCALE_SET:     'robot:scale-set',          // main window / robot → main (Settings: Robot size)
  ROBOT_ZOOM:          'robot:zoom',               // robot → main ('in' | 'out': Ctrl/Cmd + scroll wheel) → new scale
  ROBOT_SCALE_CHANGED: 'robot:scale-changed',      // main → robot (show the new size briefly)
  PROJECTS_DELETE:     'projects:delete',          // main window → main (delete a project + its memory) → DeleteProjectResult
  PROJECTS_GET_ACTIVE: 'projects:get-active',      // renderer → main → ProjectRecord | null
  // ─── Memory layer (Nemp bridge) ──────────────────────────────────────────
  MEMORY_GET:             'memory:get',                  // → MemorySnapshot
  MEMORY_GET_CONTEXT:     'memory:get-context-summary',  // → string
  MEMORY_SEARCH:          'memory:search',               // (query) → MemoryEntry[]
  MEMORY_ADD_OBSERVATION: 'memory:add-observation',
  MEMORY_ADD_COMPLETION:  'memory:add-completion',
  MEMORY_ADD_BLOCKER:     'memory:add-blocker',
  MEMORY_RESOLVE_BLOCKER: 'memory:resolve-blocker',
  MEMORY_ADD_DECISION:    'memory:add-decision',
  MEMORY_ADD_PATTERN:     'memory:add-pattern',
  MEMORY_EXPORT_MYBUILDYMD: 'memory:export-mybuildymd',
  MEMORY_RESET:           'memory:reset',
  // ─── Voice player (audio owned by a hidden main-process window) ───────────
  VOICE_PLAY_AUDIO:    'voice:play-audio',     // main → voice window (base64 MP3)
  VOICE_PLAY_TTS:      'voice:play-tts',       // main → voice window (system TTS text)
  VOICE_STOP:          'voice:stop',           // main → voice window (stop current)
  VOICE_ENDED:         'voice:ended',          // voice window → main (clip finished)
  VOICE_ERROR:         'voice:error',          // voice window → main (clip failed)
  VOICE_SPEAK_PROGRESS: 'voice:speak-progress', // main → guidance window (current chunk text / null)
  VOICE_CTL_STOP:      'voice:ctl-stop',       // companion → main (explicit stop)
  VOICE_CTL_MUTE:      'voice:ctl-mute',       // companion → main (mute on/off)
  VOICE_CTL_RESET:     'voice:ctl-reset',      // companion → main (reset dedup)
} as const
