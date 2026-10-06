// analysis-loop.ts — main process
// Live companion loop: watches a user-selected window continuously.
//
// Lifecycle:
//   1. User picks a window → startWatching()
//   2. IMMEDIATE first analysis (no delay, no gates) → always speaks
//   3. 10s interval: capture → image gate → AI → change gate → speak if meaningful
//      — EXCEPT while the agent is mid-turn ("working" or just after a Send):
//        then NO AI calls; a 5s LOCAL low-res poll + turn-detector.ts decide
//        when the turn ended and fire one analysis.
//   4. User asks question → fresh capture + session context → conversational answer
//   5. User picks different window → clear session → restart
//
// Session context:
//   Lightweight memory of what MyBuildy has observed in the current watched window.
//   Cleared on window switch. NOT persisted. NOT old project memory.

import type { BrowserWindow } from 'electron'
import { providerHttpError, readJson } from './ai/provider-errors'
import type { AppSettings, AnalysisResult, Goal } from '../renderer/src/types'
import { emptyProjectMemory, CHOOSE_MODEL_MESSAGE, MAC_PERMISSION_MESSAGES } from '../renderer/src/types'
import { IPC } from '../renderer/src/types'
import { captureWatchedWindow, listLiveWindowSources, capturePollThumbnail } from './capturer'
import { getProvider } from './ai/provider-registry'
import {
  computeImageChangeFraction,
  IMAGE_CHANGE_THRESHOLD,
  detectAnalysisChange,
} from './change-detector'
import type { AnalysisChangeResult } from './change-detector'
import { formatSpokenGuidance } from './ai/speech-formatter'
import { buildQuestionSystemPrompt, buildQuestionUserPrompt } from './ai/prompt-builder'
import { fetchWithTimeout, withCancellation } from './ai/fetch-with-timeout'
import * as nemp from './nemp-bridge'
import { checkPromptQuality, buildQualityPatch } from './ai/prompt-quality-check'
import { verifyPromptOutcome } from './ai/verifier-check'
import {
  getMostRecentPending, resolveOutcome, clearOutcomes, replacePendingOutcome,
} from './verifier'
import type { PromptOutcome } from './verifier'
import { evaluateSendEligibility, sanitizePromptForSend, detectDestructivePrompt } from './prompt-sender-core'
import { executeSend, isSendInFlight, isWatchedWindowPresent } from './prompt-sender'
import { SendAuthorizer, shouldRegisterOutcome, type SendContext } from './send-authorization'
import { getActiveProject } from './projects'
import { sendGuidanceSendState, showGuidanceWindow } from './guidance-window'
import { recordProviderCall, getCallsThisHour, isAtHourlyCap } from './cost-guard'
import { mapProviderError, isAuthOrBillingError } from './ai/provider-errors'
import { chatCompletionLimits } from './ai/request-shape'
import { hasVisionPass } from './vision-approvals'
import { enqueueSpeech } from './voice-player'
import { RecentTopics } from './semantic-dedup'
import { isStaleSession, startContinuity, pollContinuityWithPresence, type ContinuityEvent, type LostReason } from './capture-guard'
import { probeWindowPresence } from './window-presence'
import { logWatchEvent } from './watch-log'
import {
  TurnDetector, TURN_POLL_INTERVAL_MS,
  shouldAnnouncePermission, permissionAlertLine,
} from './turn-detector'
import type { WatchContinuity } from './capture-guard'
import { debugLog, debugError } from './debug-log'
import { prepareForDisplay } from './display-consistency'
import { noteAnalysisForRobot } from './robot-visibility'
import { parseQuestionReply } from './ai/question-reply'
import type { VerificationVerdict, SendEligibility, SendPromptResult, QuestionAnswer } from '../renderer/src/types'

// Recently-spoken completion subjects + next-steps, for semantic (near-duplicate)
// dedup within a 3-minute window. Cleared on each fresh watch session.
const recentSpokenCompletions = new RecentTopics()
const recentSpokenNextMoves = new RecentTopics()

// ─── Session context ────────────────────────────────────────────────────────

interface SessionContext {
  windowName: string
  observations: string[]    // last 5 whatIsHappening summaries (rolling)
  currentState: string      // latest whatIsHappening
  currentNextMove: string   // latest bestNextMove
  startedAt: string
}

let session: SessionContext | null = null

function updateSession(analysis: AnalysisResult): void {
  if (!session) return
  session.currentState = analysis.whatIsHappening
  session.currentNextMove = analysis.bestNextMove
  session.observations.push(analysis.whatIsHappening)
  if (session.observations.length > 5) session.observations.shift()
}

export function getSessionContext(): SessionContext | null {
  return session
}

// ─── State ───────────────────────────────────────────────────────────────────

let loopTimer: ReturnType<typeof setTimeout> | null = null
let isRunning = false
let isPaused = false
let isQuietMode = false
let isFirstCycle = true
let previousScreenshot: string | null = null
let previousAnalysis: AnalysisResult | null = null
let lastSpokeAt = 0
let lastSpokenNextMove = ''
let watchedSourceId: string | null = null
let watchedWindowName: string | null = null
let companionRef: BrowserWindow | null = null
let watchedGoal: Goal | null = null   // injected into every analysis prompt so guidance is goal-aware

// Concurrency control: a monotonic session id (bumped on every start/stop/switch)
// and an in-flight guard so cycles can never overlap and stale-window results are
// discarded. The async getters are reloaded EVERY cycle so editing the goal or
// changing settings mid-watch takes effect without restarting.
let currentSession = 0
// Cancels every provider request of the current watch session (analysis,
// grading, verification, spoken questions) the moment the user presses Stop.
let watchAbort = new AbortController()
let inFlight = false
let getSettingsFn: (() => Promise<AppSettings>) | null = null
let getGoalFn: (() => Promise<Goal | null>) | null = null

// Watch continuity: a cheap 2s poll (independent of the ~10s analysis cycle)
// that tracks the watched window by source id so legitimate title changes —
// coding agents rename the terminal every turn — never halt the watch. See
// capture-guard.ts for the missing/lost grace rules.
let continuity: WatchContinuity | null = null
let continuityTimer: ReturnType<typeof setInterval> | null = null
let continuityPollBusy = false
const CONTINUITY_POLL_MS = 2_000

// Turn-end detection (Phase 5 Task A): while the agent is mid-turn — last
// analysis said "working", or within 3 min of a Send — the 10s timer makes NO
// AI calls. A 5s LOCAL low-res poll feeds the pure TurnDetector state machine,
// which fires exactly one analysis when the turn likely ended (changed →
// stable → stable) or as a 3-minute progress checkpoint. See turn-detector.ts.
const turnDetector = new TurnDetector()
let turnPollTimer: ReturnType<typeof setInterval> | null = null
let turnPollBusy = false
let lastPollThumbnail: string | null = null

// The analysis currently shown in the guidance panel for THIS cycle. Parallel
// background passes (prompt-quality grader, verifier) patch it and re-send so
// they compose instead of clobbering each other's fields.
let displayAnalysis: AnalysisResult | null = null
let displaySession = 0

// Identity of the displayed prompt (send-to-terminal). A fresh id is assigned
// whenever nextPrompt is set or patched; a send request must present the id of
// the CURRENTLY displayed prompt or it is rejected as stale.
let promptIdCounter = 0
function nextPromptId(): string {
  return `prompt:${currentSession}:${++promptIdCounter}`
}

const LOOP_INTERVAL_MS = 10_000
const NORMAL_COOLDOWN_MS = 15_000
const QUIET_COOLDOWN_MS = 30_000

const EMPTY_PROJECT = emptyProjectMemory()

// ─── Runtime provider-error / cost-guard state ───────────────────────────────

// Providers that cannot work without a stored API key.
const KEYED_PROVIDERS = new Set(['anthropic', 'openai', 'gemini', 'openrouter'])

const BUDGET_PAUSE_MESSAGE = 'Paused to protect your API budget. Click to resume.'
const VISION_BLOCK_MESSAGE = "This model can't see your screen. Pick one that passes the check."
const AUTH_PAUSE_MESSAGE = 'Paused after repeated key or billing errors. Fix it in Settings, then press play to resume.'

// After 3 consecutive key/billing errors, watching pauses.
let consecutiveAuthErrors = 0
// Whether the mascot label currently shows an error message (so a following
// successful cycle can clear it back to the watched-window name).
let errorLabelShown = false

/** Pause the watch and surface `message` on the mascot label + guidance panel. */
function pauseWithMessage(companionWindow: BrowserWindow, message: string): void {
  isPaused = true
  errorLabelShown = true
  if (!companionWindow.isDestroyed()) {
    companionWindow.webContents.send(IPC.COMPANION_WATCHED_SOURCE, {
      windowName: watchedWindowName, message,
    })
  }
  showGuidanceWindow({ kind: 'message', message })
  notifyCompanionState(companionWindow, 'idle')
}

/**
 * Map a runtime provider failure to plain English and surface it on the mascot
 * label + guidance panel. Three consecutive key/billing errors pause the watch.
 */
function surfaceProviderError(companionWindow: BrowserWindow, error: unknown): void {
  const mapped = mapProviderError(String(error))
  if (isAuthOrBillingError(mapped.kind)) consecutiveAuthErrors++
  else consecutiveAuthErrors = 0

  errorLabelShown = true
  if (!companionWindow.isDestroyed()) {
    companionWindow.webContents.send(IPC.COMPANION_WATCHED_SOURCE, {
      windowName: watchedWindowName, message: mapped.message,
    })
  }
  showGuidanceWindow({ kind: 'message', message: mapped.message })

  if (consecutiveAuthErrors >= 3) {
    console.log('[AnalysisLoop] 3 consecutive key/billing errors — pausing watch')
    pauseWithMessage(companionWindow, AUTH_PAUSE_MESSAGE)
  }
}

/** Clear a previously shown error label once a cycle succeeds again. */
function clearErrorLabel(companionWindow: BrowserWindow): void {
  if (!errorLabelShown) return
  errorLabelShown = false
  if (watchedWindowName) notifyWatchedSource(companionWindow, watchedWindowName)
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Start watching a specific window. Clears all stale state.
 * Runs an immediate first analysis that always speaks.
 */
export function startWatching(
  companionWindow: BrowserWindow,
  sourceId: string,
  windowName: string,
  getSettings: () => Promise<AppSettings>,
  getGoal: () => Promise<Goal | null>
): void {
  clearStaleState()

  // New watching session — any in-flight cycle from a previous window is now stale.
  currentSession++
  const mySession = currentSession

  companionRef = companionWindow
  watchedSourceId = sourceId
  watchedWindowName = windowName
  getSettingsFn = getSettings
  getGoalFn = getGoal
  watchedGoal = null
  isRunning = true
  isPaused = false
  isFirstCycle = true

  // Create fresh session context
  session = {
    windowName,
    observations: [],
    currentState: '',
    currentNextMove: '',
    startedAt: new Date().toISOString(),
  }

  // Structural log only — no window title (it may contain user content).
  console.log(`[AnalysisLoop] Now watching session ${mySession} (${sourceId})`)

  // Track window identity by source id, independent of title changes.
  continuity = startContinuity(sourceId, windowName)
  logWatchEvent('watch-started', { session: mySession, source: sourceId }, { title: windowName })
  // Record which process owns the window, so a later missing id can be
  // confirmed as the SAME window (minimized) rather than lost (window-presence.ts).
  void probeWindowPresence(sourceId).then((presence) => {
    if (!continuity || continuity.sourceId !== sourceId || isStaleSession(mySession, currentSession)) return
    if (presence?.exists) continuity.ownerPid = presence.ownerPid
    logWatchEvent('watch-owner', { session: mySession, known: continuity.ownerPid !== null })
  })
  continuityTimer = setInterval(() => {
    void pollWatchContinuity(companionWindow, mySession)
  }, CONTINUITY_POLL_MS)

  notifyWatchedSource(companionWindow, windowName)
  notifyCompanionState(companionWindow, 'idle')

  // IMMEDIATE first cycle, then a recursive setTimeout chain (each cycle fully
  // finishes before the next is scheduled — no overlap).
  void runCycleAndReschedule(companionWindow, mySession)
}

/** Run one cycle (guarded) then schedule the next, unless the session changed.
 *  `force` bypasses the working-mode skip: used by the turn detector's own
 *  analyze-now trigger and the immediate post-send analysis. */
async function runCycleAndReschedule(companionWindow: BrowserWindow, mySession: number, force = false): Promise<void> {
  if (mySession !== currentSession) return // a newer session superseded this chain
  if (!isPaused && !inFlight && watchedSourceId) {
    if (!force && turnDetector.isWorking(Date.now())) {
      // Agent mid-turn: spend nothing. The 5s local poll (below) decides when
      // the turn ended and triggers ONE analysis via runCycleAndReschedule(force).
      ensureTurnPoll(companionWindow, mySession)
    } else {
      inFlight = true
      try {
        await withCancellation(watchAbort.signal, () => runOneAnalysisCycle(companionWindow, mySession))
      } catch (error) {
        debugError('[AnalysisLoop] Cycle error:', error)
        notifyCompanionState(companionWindow, 'idle')
      } finally {
        inFlight = false
      }
    }
  }
  scheduleNextCycle(companionWindow, mySession)
}

function scheduleNextCycle(companionWindow: BrowserWindow, mySession: number): void {
  if (mySession !== currentSession) return
  loopTimer = setTimeout(() => { void runCycleAndReschedule(companionWindow, mySession) }, LOOP_INTERVAL_MS)
}

/** The current Stop signal: aborted (and replaced) every time Stop is pressed. */
export function stopSignal(): AbortSignal {
  return watchAbort.signal
}

/** `reason` goes to the diagnostic watch log only (watch-log.ts). */
export function stopAnalysisLoop(reason = 'stop'): void {
  if (isRunning) logWatchEvent('watch-stopped', { session: currentSession, reason })
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = null }
  // Cancel whatever is in flight right now (a provider call mid-analysis).
  watchAbort.abort()
  watchAbort = new AbortController()
  // Bump the session so any in-flight cycle discards its result.
  currentSession++
  clearStaleState()
  isRunning = false
  isPaused = false
  inFlight = false
  watchedSourceId = null
  watchedWindowName = null
  getSettingsFn = null
  getGoalFn = null
  session = null
  console.log('[AnalysisLoop] Stopped')
  void pushSendEligibility()
}

/**
 * Stop watching because the ACTIVE PROJECT is about to change. MUST run BEFORE
 * the memory layer is re-pointed (setActiveMemoryDir / nemp init / verifier
 * namespace): the analysis loop reads memory context and writes observations,
 * completions and pending outcomes through project-global state, and a project
 * switch does not bump the loop's session token by itself — so a mid-flight or
 * next cycle started under the OLD window would otherwise tee that window's
 * activity into the NEW project's store. stopAnalysisLoop() bumps the session
 * (any in-flight cycle discards its result before writing) and, unlike the
 * renderer-initiated COMPANION_STOP path, the companion doesn't know yet — so
 * we also tell it the watch ended and a window must be re-picked (same
 * notification shape as haltWatchAsLost).
 */
export function stopWatchForProjectSwitch(): void {
  const wasWatching = isRunning
  const companion = companionRef
  stopAnalysisLoop('project-switch')
  // The displayed analysis (and its paste authorization) belonged to the old project.
  displayAnalysis = null
  displaySession = -1
  if (wasWatching && companion && !companion.isDestroyed()) {
    companion.webContents.send(IPC.COMPANION_WATCHED_SOURCE, {
      windowName: null,
      message: 'Project switched — show MyBuildy your coding agent.',
    })
    notifyCompanionState(companion, 'idle')
  }
}

export function pauseAnalysisLoop(): void { isPaused = true }
export function resumeAnalysisLoop(): void { isPaused = false }
export function setQuietMode(quiet: boolean): void { isQuietMode = quiet }
export function isAnalysisLoopRunning(): boolean { return isRunning && !isPaused && watchedSourceId !== null }
/** A window is being watched (paused or not; a watch whose window was lost has ended) — its project must not be deleted. */
export function isWatching(): boolean { return isRunning && watchedSourceId !== null && continuity?.state !== 'lost' }

// ─── Watch continuity poll (every 2s, independent of the analysis cycle) ─────

/**
 * One continuity tick: refresh the live source list and react to what the
 * tracker says. Title changes and brief disappearances keep the watch alive
 * (the analysis cycle, post-send analysis and Verifier all continue as if
 * nothing happened); only a real loss halts and asks for reselection.
 */
async function pollWatchContinuity(companionWindow: BrowserWindow, mySession: number): Promise<void> {
  if (isStaleSession(mySession, currentSession) || !continuity || continuityPollBusy) return
  continuityPollBusy = true
  let event: ContinuityEvent
  try {
    const sources = await listLiveWindowSources()
    if (isStaleSession(mySession, currentSession) || !continuity) return
    const watch = continuity
    // The OS is only asked at decision points (going missing, about to be lost).
    event = await pollContinuityWithPresence(watch, sources, Date.now(), () => probeWindowPresence(watch.sourceId))
  } catch (error) {
    console.warn('[Watch] continuity poll failed:', error)
    return
  } finally {
    continuityPollBusy = false
  }
  if (isStaleSession(mySession, currentSession) || !continuity) return

  switch (event.kind) {
    case 'title-changed':
      // Same source id in consecutive polls = same window; the title is cosmetic.
      watchedWindowName = event.to
      console.log('[Watch] title changed — same window, watch continues')
      debugLog(`[Watch] title: "${event.from}" -> "${event.to}"`)
      logWatchEvent('title-changed', { session: mySession }, { from: event.from, to: event.to })
      notifyWatchedSource(companionWindow, event.to)
      void pushSendEligibility()
      break
    case 'went-missing':
      // On Windows a MINIMIZED or hidden window drops out of the source list;
      // the OS check says whether it is still open. The grace rules still run.
      console.log(`[Watch] watched window missing from source list — ${event.stillOpen ? (event.minimized ? 'minimized' : 'hidden, still open') : 'not confirmed open'}; grace period started`)
      logWatchEvent('missing', { session: mySession, stillOpen: !!event.stillOpen, minimized: !!event.minimized })
      notifyWindowAway(companionWindow, !!event.stillOpen, !!event.minimized)
      void pushSendEligibility()
      break
    case 'still-open':
      // The rules would have halted, but the OS confirms it is the same window,
      // still open (minimized or hidden) — keep the watch, restart the grace.
      console.log('[Watch] watched window still open (not in the capture list) — watch kept')
      logWatchEvent('still-open', { session: mySession, minimized: event.minimized })
      notifyWindowAway(companionWindow, true, event.minimized)
      break
    case 'resumed':
      watchedWindowName = event.title
      console.log('[Watch] resumed — watched window is back in the source list')
      debugLog(`[Watch] resumed with title "${event.title}"`)
      logWatchEvent('resumed', { session: mySession }, { title: event.title })
      notifyWatchedSource(companionWindow, event.title)
      void pushSendEligibility()
      break
    case 'lost':
      console.log(`[Watch] watched window lost (${event.reason}) — halting, awaiting reselection`)
      haltWatchAsLost(companionWindow, event.reason, mySession)
      break
    case 'none':
      break
  }
}

/** Mascot label while the watched window is out of the capture list. */
function notifyWindowAway(companionWindow: BrowserWindow, stillOpen: boolean, minimized: boolean): void {
  if (companionWindow.isDestroyed()) return
  companionWindow.webContents.send(IPC.COMPANION_WATCHED_SOURCE, {
    windowName: watchedWindowName,
    message: minimized
      ? 'The watched window is minimized. Restore it and MyBuildy carries on watching.'
      : stillOpen
        ? 'The watched window is hidden. Show it and MyBuildy carries on watching.'
        : 'Looking for the watched window…',
  })
}

/** Halt exactly as the old target-lost path did: pause and ask for reselection. */
function haltWatchAsLost(companionWindow: BrowserWindow, reason: LostReason, mySession: number): void {
  logWatchEvent('lost', { session: mySession, reason })
  isPaused = true
  if (continuityTimer) { clearInterval(continuityTimer); continuityTimer = null }
  stopTurnPoll()
  if (!companionWindow.isDestroyed()) {
    companionWindow.webContents.send(IPC.COMPANION_WATCHED_SOURCE, {
      windowName: null,
      message: `"${watchedWindowName}" is no longer open. Show MyBuildy your coding agent again.`,
    })
  }
  notifyCompanionState(companionWindow, 'idle')
  void pushSendEligibility()
}

// ─── Turn-end poll (every 5s, LOCAL only, while the agent is working) ────────

/** Start the 5s low-res poll if it isn't already running. */
function ensureTurnPoll(companionWindow: BrowserWindow, mySession: number): void {
  if (turnPollTimer) return
  console.log('[TurnDetector] agent mid-turn — AI calls paused, 5s local poll started')
  turnPollTimer = setInterval(() => {
    void runTurnPollTick(companionWindow, mySession)
  }, TURN_POLL_INTERVAL_MS)
}

function stopTurnPoll(): void {
  if (turnPollTimer) { clearInterval(turnPollTimer); turnPollTimer = null }
  turnPollBusy = false
  lastPollThumbnail = null
}

/**
 * One poll tick: cheap low-res LOCAL capture of the watched window (never sent
 * anywhere), change fraction vs the previous tick, fed into the pure
 * TurnDetector. Fires at most one forced analysis (in-flight guard + session
 * token respected). Self-stops when working mode ends, the watch pauses, or
 * the session changes — the normal 10s cycle then resumes untouched.
 */
async function runTurnPollTick(companionWindow: BrowserWindow, mySession: number): Promise<void> {
  if (isStaleSession(mySession, currentSession) || isPaused || !watchedSourceId) {
    stopTurnPoll()
    return
  }
  if (!turnDetector.isWorking(Date.now())) {
    console.log('[TurnDetector] working mode ended — local poll stopped, normal cycle resumes')
    stopTurnPoll()
    return
  }
  if (turnPollBusy || inFlight) return
  turnPollBusy = true
  try {
    const thumbnail = await capturePollThumbnail(watchedSourceId)
    if (isStaleSession(mySession, currentSession)) return
    if (!thumbnail) return // window missing this tick — the continuity poll decides
    const changeFraction = lastPollThumbnail
      ? computeImageChangeFraction(lastPollThumbnail, thumbnail)
      : 0
    lastPollThumbnail = thumbnail
    const action = turnDetector.onPoll({ timestamp: Date.now(), changeFraction })
    if (action === 'analyze-now') {
      console.log('[TurnDetector] turn likely ended (or 3-min checkpoint) — running one analysis')
      triggerImmediateAnalysis(mySession)
    }
  } catch (error) {
    console.warn('[TurnDetector] poll tick failed:', error)
  } finally {
    turnPollBusy = false
  }
}

// ─── Question handling ──────────────────────────────────────────────────────

/**
 * Handle a spoken question from the user.
 * Takes a fresh screenshot, combines with session context, gets a conversational answer.
 */
export async function handleQuestion(
  companionWindow: BrowserWindow,
  question: string,
  settings: AppSettings
): Promise<void> {
  return withCancellation(watchAbort.signal, () => answerQuestion(companionWindow, question, settings))
}

async function answerQuestion(
  companionWindow: BrowserWindow,
  question: string,
  settings: AppSettings
): Promise<void> {
  if (companionWindow.isDestroyed()) return
  // Stop bumps the session: after that, nothing for this question is captured,
  // sent or spoken.
  const questionSession = currentSession
  const stoppedSinceAsked = (): boolean => currentSession !== questionSession

  debugLog(`[AnalysisLoop] Question: "${question}"`)
  notifyCompanionState(companionWindow, 'thinking')

  // Capture fresh screenshot if we have a watched window
  let screenshotBase64: string | null = null
  let windowTitle = watchedWindowName || 'unknown'
  if (watchedSourceId && !stoppedSinceAsked()) {
    const capture = await captureWatchedWindow(watchedSourceId, watchedWindowName)
    if (stoppedSinceAsked()) return
    if (capture) {
      screenshotBase64 = capture.imageBase64
      windowTitle = capture.windowTitle
    }
  }

  if (stoppedSinceAsked()) return
  const provider = getProvider(settings.provider)
  const systemPrompt = buildQuestionSystemPrompt(windowTitle, session)
  const userPrompt = buildQuestionUserPrompt(question, session)

  try {
    // Build the messages for the provider
    // We need to call the provider's raw API since analyzeScreen returns AnalysisResult JSON
    // Use a text-only call via the brainstorm-style interface, but we want a single response
    const raw = await callProviderForAnswer(provider, systemPrompt, userPrompt, screenshotBase64, settings)
    if (stoppedSinceAsked()) return // Stop pressed while answering: say nothing
    // The reply, plus any goal/prompt the user asked for as its own field.
    const { reply, suggestion } = parseQuestionReply(raw)
    const answer: QuestionAnswer = suggestion ? { question, answer: reply, suggestion } : { question, answer: reply }

    if (!companionWindow.isDestroyed()) {
      companionWindow.webContents.send(IPC.COMPANION_ANSWER, answer)
    }

    // Speak the reply only — the suggestion is for reading and copying.
    await speakText(companionWindow, reply, settings)
  } catch (error) {
    if (stoppedSinceAsked()) return
    debugError('[AnalysisLoop] Question answer failed:', error)
    if (!companionWindow.isDestroyed()) {
      companionWindow.webContents.send(IPC.COMPANION_ANSWER, {
        question,
        answer: "Sorry, I couldn't process that question. Try again in a moment.",
      })
    }
  }

  notifyCompanionState(companionWindow, 'idle')
}

async function callProviderForAnswer(
  provider: any,
  systemPrompt: string,
  userPrompt: string,
  screenshotBase64: string | null,
  settings: AppSettings
): Promise<string> {
  const providerType = settings.provider
  let url: string
  let headers: Record<string, string>
  let body: any

  if (providerType === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages'
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    }
    const userContent: any[] = []
    if (screenshotBase64) {
      userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshotBase64 } })
    }
    userContent.push({ type: 'text', text: userPrompt })
    body = {
      model: settings.modelId,
      max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }
  } else if (providerType === 'gemini') {
    const modelId = settings.modelId
    // Key in a header, never the URL.
    url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`
    headers = { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey }
    const parts: any[] = []
    if (screenshotBase64) {
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: screenshotBase64 } })
    }
    parts.push({ text: userPrompt })
    body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { maxOutputTokens: 800 },
    }
  } else {
    // OpenAI-compatible (openai, openrouter, ollama, lmstudio, custom)
    let baseUrl = settings.baseUrl || 'https://api.openai.com'
    if (providerType === 'openai') baseUrl = 'https://api.openai.com'
    else if (providerType === 'openrouter') baseUrl = 'https://openrouter.ai/api'
    else if (providerType === 'ollama') baseUrl = settings.baseUrl || 'http://localhost:11434'
    else if (providerType === 'lmstudio') baseUrl = settings.baseUrl || 'http://localhost:1234'

    url = `${baseUrl}/v1/chat/completions`
    headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`,
    }
    if (providerType === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/SukinShetty/mybuildy'
      headers['X-Title'] = 'MyBuildy'
    }

    const userContent: any[] = []
    if (screenshotBase64) {
      userContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}`, detail: 'high' } })
    }
    userContent.push({ type: 'text', text: userPrompt })

    body = {
      model: settings.modelId,
      ...chatCompletionLimits(providerType, settings.modelId, 800),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }
  }

  const isLocal = providerType === 'ollama' || providerType === 'lmstudio'
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, isLocal)

  if (!response.ok) {
    throw await providerHttpError('Provider', response)
  }

  const json = await readJson<{
    content?: Array<{ text?: string }>
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    choices?: Array<{ message?: { content?: string } }>
  }>(response, 'Provider')

  // Extract text from response
  if (providerType === 'anthropic') {
    return json.content?.[0]?.text || 'No response.'
  } else if (providerType === 'gemini') {
    return json.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.'
  } else {
    return json.choices?.[0]?.message?.content || 'No response.'
  }
}

// ─── Core cycle ──────────────────────────────────────────────────────────────

async function runOneAnalysisCycle(
  companionWindow: BrowserWindow,
  mySession: number
): Promise<void> {
  // Memory writes from this cycle go ONLY to the project active right now.
  const memScope = nemp.memoryScope()
  if (companionWindow.isDestroyed() || !watchedSourceId) {
    stopAnalysisLoop('companion-window-gone')
    return
  }

  // Part 2: reload settings + goal at the START of each cycle so editing the goal
  // or changing settings mid-watch takes effect without restarting the watch.
  const settings = getSettingsFn ? await getSettingsFn() : null
  if (!settings) return
  watchedGoal = getGoalFn ? await getGoalFn() : watchedGoal
  if (isStaleSession(mySession, currentSession)) return

  // Mid-watch gates (settings can change while watching):
  //  1. No model / no key → refuse. There is no default model anywhere.
  if (!settings.modelId.trim() || (KEYED_PROVIDERS.has(settings.provider) && !settings.apiKey)) {
    pauseWithMessage(companionWindow, CHOOSE_MODEL_MESSAGE)
    return
  }
  //  2. Vision gate: watching requires a PASSED vision check for this exact
  //     provider+model (invalidated when the key changes).
  if (!hasVisionPass(settings.provider, settings.modelId, settings.apiKey)) {
    pauseWithMessage(companionWindow, VISION_BLOCK_MESSAGE)
    return
  }
  //  3. Cost guard: at the rolling-hour cap, pause to protect the API budget.
  if (isAtHourlyCap(settings.hourlyCallCap)) {
    pauseWithMessage(companionWindow, BUDGET_PAUSE_MESSAGE)
    return
  }

  const thisIsFirstCycle = isFirstCycle
  isFirstCycle = false

  // Step 1: Capture the watched window (NEVER the full screen — see capturer.ts).
  // Identity is the source id; the continuity poll guards HWND/id reuse across
  // gaps and follows legitimate title renames (see capture-guard.ts).
  const capture = await captureWatchedWindow(watchedSourceId, watchedWindowName)
  if (isStaleSession(mySession, currentSession)) return
  if (!capture) {
    // Watched window not in the source list THIS cycle. The 2s continuity poll
    // owns the missing/lost decision (grace for renames and brief gaps) — the
    // cycle just skips; it never halts the watch or captures anything else.
    console.log('[Watch] capture skipped — watched window not in source list this cycle (continuity poll decides)')
    notifyCompanionState(companionWindow, 'idle')
    return
  }

  // Step 2: Image-level gate — SKIP for first cycle (always analyze on watch start)
  if (!thisIsFirstCycle && previousScreenshot) {
    const changeFraction = computeImageChangeFraction(previousScreenshot, capture.imageBase64)
    if (changeFraction < IMAGE_CHANGE_THRESHOLD) return
  }
  previousScreenshot = capture.imageBase64

  // Step 3: Analyze — pass EMPTY project, AI sees only the screenshot
  notifyCompanionState(companionWindow, 'thinking')

  const provider = getProvider(settings.provider)
  // Inject the user's goal AND the Nemp project-memory context so guidance is
  // memory-aware (knows what's built / decided / blocked).
  let memoryContext = ''
  try {
    memoryContext = await nemp.getContextSummary()
  } catch (error) {
    console.warn('[AnalysisLoop] memory context unavailable:', error)
  }
  if (isStaleSession(mySession, currentSession)) return // stopped/switched meanwhile: no provider call
  const analysisProject = {
    ...EMPTY_PROJECT,
    ...(watchedGoal ? { goal: watchedGoal } : {}),
    memoryContext,
  }
  let analysis: AnalysisResult
  recordProviderCall() // cost guard: analysis call
  try {
    analysis = await provider.analyzeScreen(capture, analysisProject, settings)
  } catch (error) {
    debugError('[AnalysisLoop] Analysis failed:', error)
    if (!isStaleSession(mySession, currentSession)) {
      // Same plain-English provider errors as the Settings check, on the
      // mascot label + guidance panel; 3 key/billing errors in a row pause.
      surfaceProviderError(companionWindow, error)
    }
    notifyCompanionState(companionWindow, 'idle')
    return
  }
  consecutiveAuthErrors = 0

  // ★ STALE-SESSION DISCARD: if the user switched/stopped the watched window while
  // this analysis was in flight, throw the result away — do NOT mutate state, send
  // guidance, or speak. This kills wrong-window guidance from stale cycles.
  if (isStaleSession(mySession, currentSession)) {
    console.log(`[AnalysisLoop] stale cycle discarded (session ${mySession} != ${currentSession})`)
    return
  }

  // A successful cycle clears any stale error message from the mascot label.
  clearErrorLabel(companionWindow)

  // Update session context
  updateSession(analysis)

  // Turn-end detection: record this reading's terminalState. If it says
  // "working" (or we're within 3 min of a send), the next scheduled cycles
  // skip the AI and the 5s local poll takes over (see runCycleAndReschedule).
  const prevTerminalState = previousAnalysis?.terminalState
  turnDetector.noteAnalysis(Date.now(), analysis.terminalState)

  // Step 4: Analysis-level gate
  const change = detectAnalysisChange(previousAnalysis, analysis)
  previousAnalysis = analysis

  // Seed the per-cycle display analysis, then send it to the companion. Parallel
  // background passes patch THIS object and re-send (never clobber each other).
  analysis.promptId = nextPromptId()
  // Destructive-prompt guard (speed bump, not a sandbox): computed here so the
  // renderer only renders the verdict; it drives the two-click "Review first"
  // flow on the send button. Scan the SANITIZED text — the exact bytes a send
  // would deliver — so a newline can't split a hazard across the guard's
  // single-line patterns (e.g. "git push\n--force").
  analysis.sendGuard = detectDestructivePrompt(sanitizePromptForSend(analysis.nextPrompt || ''))
  analysis.callsThisHour = getCallsThisHour() // guidance panel footer
  // Hand-off text and verdict/headline consistency (display-consistency.ts).
  displayAnalysis = prepareForDisplay(analysis)
  displaySession = mySession
  if (!companionWindow.isDestroyed()) {
    companionWindow.webContents.send(IPC.COMPANION_ANALYSIS, displayAnalysis)
    noteAnalysisForRobot(displayAnalysis) // robot hidden → a system notification for alerts
  }
  void pushSendEligibility()

  // Verifier (Block 4): if a prompt was suggested on a PREVIOUS cycle, check
  // whether it worked — using THIS analysis as evidence. Capture the pending
  // outcome BEFORE recording the new one below. Runs in parallel, never blocks.
  const toVerify = getMostRecentPending()
  if (toVerify) {
    runVerifier(companionWindow, toVerify, analysis, memoryContext, settings, mySession, memScope)
  }
  // A suggestion is NOT recorded for verification: only a prompt the user
  // actually pasted is (see handleSendPromptRequest).

  // Tee the analysis into the memory layer AFTER the UI has it (fire-and-forget,
  // never blocks display).
  teeAnalysisToMemory(analysis, memScope)

  // Second-pass prompt-quality grade — runs in parallel, never blocks. If it
  // improves or blanks the prompt, re-send the corrected analysis so the panel
  // updates in place (unless the watch session has since changed).
  gradePromptQuality(companionWindow, analysis, memoryContext, settings, mySession)

  // Permission alert (spec item 2): the agent is asking for approval — ONE
  // short spoken line + the mascot label. Spoken only on the TRANSITION into
  // permission_prompt (never re-spoken while the same prompt stays on screen),
  // and MyBuildy NEVER answers the permission prompt itself.
  let spokePermissionAlert = false
  if (analysis.terminalState === 'permission_prompt') {
    // Prefer the model-reported agentName; the title heuristic is the fallback.
    const alertLine = permissionAlertLine(watchedWindowName, analysis.agentName)
    if (!companionWindow.isDestroyed()) {
      companionWindow.webContents.send(IPC.COMPANION_WATCHED_SOURCE, {
        windowName: watchedWindowName, message: alertLine,
      })
    }
    // Reuse the error-label restore path: the next non-permission successful
    // cycle puts the plain watched-window name back on the mascot.
    errorLabelShown = true
    if (shouldAnnouncePermission(prevTerminalState, analysis.terminalState)) {
      spokePermissionAlert = true
      lastSpokeAt = Date.now()
      // Critical: the user is being waited on — jump the voice queue.
      await speakText(companionWindow, alertLine, settings, 'permission', true)
    }
  }

  // Step 5: Speak
  // Permission alert already said the one thing that matters this cycle.
  if (spokePermissionAlert) {
    debugLog('[AnalysisLoop] permission alert spoken — skipping regular guidance speech this cycle')
  } else if (thisIsFirstCycle) {
    debugLog(`[AnalysisLoop] ★ INITIAL analysis — happening: "${analysis.whatIsHappening?.slice(0, 60)}"`)
    debugLog(`[AnalysisLoop] ★ INITIAL analysis — nextMove: "${analysis.bestNextMove?.slice(0, 60)}"`)
    lastSpokeAt = Date.now()
    lastSpokenNextMove = analysis.bestNextMove
    await speakToCompanion(companionWindow, {
      isSignificant: true,
      isHighPriority: false,
      whatChanged: 'new_step',
      whatHappened: analysis.whatIsHappening,
      bestNextMove: analysis.bestNextMove,
    }, settings, false)
  } else {
    console.log(`[AnalysisLoop] Change detected: ${change.whatChanged || 'none'}, significant=${change.isSignificant}, highPri=${change.isHighPriority}`)
    if (shouldSpeak(change)) {
      lastSpokeAt = Date.now()
      lastSpokenNextMove = change.bestNextMove
      // A brand-new blocker is a critical override (truncates the queue after the
      // current chunk). Driven by the model's isCriticalOverride flag.
      await speakToCompanion(companionWindow, change, settings, !!analysis.isCriticalOverride)
    }
  }

  notifyCompanionState(companionWindow, 'idle')
}

// ─── Speech gating (not used for first cycle) ───────────────────────────────

function shouldSpeak(change: AnalysisChangeResult): boolean {
  if (!change.isSignificant) {
    console.log('[AnalysisLoop] No significant change — staying quiet')
    return false
  }
  if (isQuietMode && !change.isHighPriority) {
    console.log('[AnalysisLoop] Quiet mode — suppressing non-priority change')
    return false
  }

  // Cooldown — high-priority changes (blockers, completions) bypass cooldown
  const cooldown = isQuietMode ? QUIET_COOLDOWN_MS : NORMAL_COOLDOWN_MS
  const elapsed = Date.now() - lastSpokeAt
  if (elapsed < cooldown) {
    if (change.whatChanged !== 'blocker' && change.whatChanged !== 'completion') {
      console.log(`[AnalysisLoop] Cooldown active (${Math.round(elapsed / 1000)}s/${Math.round(cooldown / 1000)}s) — waiting`)
      return false
    }
    console.log(`[AnalysisLoop] High-priority "${change.whatChanged}" bypasses cooldown`)
  }

  // Anti-repeat — only block if the next move is nearly identical (>75% overlap)
  if (lastSpokenNextMove && change.bestNextMove) {
    const overlap = quickWordOverlap(lastSpokenNextMove, change.bestNextMove)
    if (overlap > 0.75) {
      console.log(`[AnalysisLoop] Anti-repeat: ${Math.round(overlap * 100)}% overlap — skipping`)
      return false
    }
  }

  debugLog(`[AnalysisLoop] Will speak: ${change.whatChanged} — "${change.whatHappened?.slice(0, 50)}..."`)
  return true
}

function quickWordOverlap(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2))
  const wb = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2))
  if (wa.size === 0 && wb.size === 0) return 1
  let n = 0; for (const w of wa) { if (wb.has(w)) n++ }
  const u = wa.size + wb.size - n
  return u > 0 ? n / u : 0
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clearStaleState(): void {
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = null }
  if (continuityTimer) { clearInterval(continuityTimer); continuityTimer = null }
  continuity = null
  continuityPollBusy = false
  stopTurnPoll()
  turnDetector.reset()
  previousScreenshot = null
  previousAnalysis = null
  lastSpokeAt = 0
  lastSpokenNextMove = ''
  isFirstCycle = true
  recentSpokenCompletions.clear()
  recentSpokenNextMoves.clear()
  // Drop any pending prompt-outcomes so a new watch session never verifies a
  // suggestion made for a different window.
  clearOutcomes()
  displayAnalysis = null
  consecutiveAuthErrors = 0
  errorLabelShown = false
}

function notifyCompanionState(w: BrowserWindow, state: 'idle' | 'thinking' | 'speaking'): void {
  if (!w.isDestroyed()) w.webContents.send(IPC.COMPANION_STATE, state)
}

function notifyWatchedSource(w: BrowserWindow, windowName: string): void {
  if (!w.isDestroyed()) w.webContents.send(IPC.COMPANION_WATCHED_SOURCE, { windowName, message: null })
}

async function speakToCompanion(
  companionWindow: BrowserWindow,
  change: AnalysisChangeResult,
  settings: AppSettings,
  isCritical = false
): Promise<void> {
  if (companionWindow.isDestroyed()) return

  const now = Date.now()

  // FIX 1 — semantic dedup for completions: if the same fact was already spoken in
  // the last ~3 minutes (in slightly different words), don't repeat it.
  if (change.whatChanged === 'completion' && recentSpokenCompletions.isDuplicate(change.whatHappened, now)) {
    debugLog(`[Speech] Skipped (semantic duplicate of recent): ${change.whatHappened}`)
    // FIX 2 — but if the NEXT STEP is genuinely new, speak only that (not the repeat).
    const next = change.bestNextMove
    if (next && !recentSpokenNextMoves.isDuplicate(next, now)) {
      const nextText = formatSpokenGuidance('', next, 'progress')
      if (nextText) {
        recentSpokenNextMoves.record(next, now)
        debugLog(`[Speech] Display text: "${next}"`)
        debugLog(`[Speech] TTS text: "${nextText}"`)
        debugLog(`[Speech] Formatted for TTS (next-only): "${nextText}"`)
        await speakText(companionWindow, nextText, settings, 'progress', isCritical)
      }
    }
    return
  }

  const text = formatSpokenGuidance(change.whatHappened, change.bestNextMove, change.whatChanged)
  if (!text) {
    console.log('[Speech] Formatter returned empty text — nothing to say')
    return
  }

  // Record what we're about to say so future near-duplicates are caught.
  if (change.whatChanged === 'completion') recentSpokenCompletions.record(change.whatHappened, now)
  if (change.bestNextMove) recentSpokenNextMoves.record(change.bestNextMove, now)

  // Side-by-side sync check: the displayed (panel) content vs the spoken text.
  // These must match in content — TTS may strip markdown but must NOT truncate.
  const displayText = `${change.whatHappened} ${change.bestNextMove}`.replace(/\s+/g, ' ').trim()
  debugLog(`[Speech] Display text: "${displayText}"`)
  debugLog(`[Speech] TTS text: "${text}"`)
  debugLog(`[Speech] Formatted for TTS (${change.whatChanged}): "${text}"`)
  await speakText(companionWindow, text, settings, change.whatChanged, isCritical)
}

/**
 * Hand text to the MAIN-PROCESS voice player (a hidden window that survives
 * companion re-renders / backgrounding). The voice player owns the queue, the
 * lock, chunking, and ElevenLabs synthesis — see voice-player.ts. We only enqueue;
 * we never play here, so new analysis never interrupts the current clip.
 */
async function speakText(
  companionWindow: BrowserWindow,
  text: string,
  _settings: AppSettings,
  changeType?: string | null,
  isCritical = false
): Promise<void> {
  if (companionWindow.isDestroyed()) return
  debugLog(`[Speech] Enqueue to voice player: "${text.slice(0, 80)}..." (critical=${isCritical})`)
  notifyCompanionState(companionWindow, 'speaking')
  enqueueSpeech({ id: `${changeType || 'answer'}-${Date.now()}`, text, isCritical })
}

// ─── Memory + prompt-quality wiring (Block 2 / Part C) ───────────────────────

/**
 * Push the analysis into the Nemp memory layer. Fire-and-forget — the bridge
 * functions log + swallow their own errors, so this never affects the UI.
 */
function teeAnalysisToMemory(analysis: AnalysisResult, memScope: string): void {
  const memory = nemp.writerFor(memScope)
  try {
    // whatIsHappening is NOT stored: it describes this moment on screen (the
    // agent reading, idle, waiting), not a durable fact about the project. It
    // still feeds the in-session context via updateSession.
    if (analysis.goalAlignment === 'on-track') {
      for (const feature of analysis.whatIsBuilt.slice(0, 5)) void memory.recordCompletion(feature)
    }
    if (analysis.goalAlignment === 'blocked') {
      for (const broken of analysis.whatIsBroken.slice(0, 5)) void memory.recordBlocker(broken)
    }
  } catch (error) {
    console.warn('[AnalysisLoop] memory tee failed:', error)
  }
}

/**
 * Run the Haiku second-pass grade in the background. If the prompt is weak, swap
 * in an improved version (or blank it with an explanation) and re-send so the
 * guidance panel updates. Never blocks the main flow.
 */
function gradePromptQuality(
  companionWindow: BrowserWindow,
  analysis: AnalysisResult,
  memoryContext: string,
  settings: AppSettings,
  mySession: number
): void {
  void (async () => {
    try {
      const result = await checkPromptQuality(analysis, memoryContext, watchedGoal, settings)
      // Don't re-send guidance for a window the user has since switched away from.
      if (isStaleSession(mySession, currentSession)) return

      // Pure policy (unit-tested): human-directed → hand-off + dropped prompt;
      // otherwise improved/blanked as before; null when the prompt is fine.
      const patch = buildQualityPatch(analysis, result)
      if (!patch) return
      if (result.humanDirected) {
        console.log('[Prompt] grader routed human question to hand-off')
      } else if (result.improvedPrompt) {
        console.log('[AnalysisLoop] Prompt replaced by grader-improved version')
      } else {
        console.log('[AnalysisLoop] Prompt blanked by grader (no improvement available)')
      }
      patchDisplayAndResend(companionWindow, patch, mySession)
    } catch (error) {
      debugError('[AnalysisLoop] prompt-quality grading failed:', error)
    }
  })()
}

/**
 * Merge a patch into the current cycle's display analysis and re-send it to the
 * companion so the guidance panel updates in place. Discards the patch if the
 * watch session has advanced or the display belongs to a different cycle — so a
 * stale background pass can never repaint the wrong window's guidance.
 */
function patchDisplayAndResend(
  companionWindow: BrowserWindow,
  patch: Partial<AnalysisResult>,
  mySession: number
): void {
  if (isStaleSession(mySession, currentSession)) return
  if (displaySession !== mySession || !displayAnalysis) return
  displayAnalysis = { ...displayAnalysis, ...patch }
  // A patched nextPrompt (grader-improved or verifier corrective) is a NEW
  // displayed prompt — give it a fresh id so send requests for the old one are
  // rejected as stale, and so the new one is itself sendable. Re-run the
  // destructive-prompt guard for the same reason (new text, new verdict).
  if ('nextPrompt' in patch) {
    displayAnalysis.promptId = nextPromptId()
    displayAnalysis.sendGuard = detectDestructivePrompt(
      sanitizePromptForSend(displayAnalysis.nextPrompt || '')
    )
  }
  // A verdict or hand-off patched on after the first display gets the same
  // clean-up: no "goal reached" next to a partial/failed badge, no checker text.
  displayAnalysis = prepareForDisplay(displayAnalysis)
  if (!companionWindow.isDestroyed()) {
    companionWindow.webContents.send(IPC.COMPANION_ANALYSIS, displayAnalysis)
    noteAnalysisForRobot(displayAnalysis) // robot hidden → a system notification for alerts
  }
  void pushSendEligibility()
}

// ─── Send-to-terminal (approve-and-send) ─────────────────────────────────────

/**
 * Compute whether "Send to Claude Code" is allowed RIGHT NOW. Main is the sole
 * decision-maker; the renderer only renders the result.
 */
async function computeSendEligibility(): Promise<SendEligibility> {
  const watchActive = isRunning && !isPaused && watchedSourceId !== null
  // Not eligible while the continuity tracker says the window is missing/lost;
  // only pay for the live window-list lookup when everything cheaper holds.
  const windowFound = watchActive && continuity?.state === 'watching'
    ? await isWatchedWindowPresent(watchedSourceId)
    : false
  return evaluateSendEligibility({
    platform: process.platform,
    watchActive,
    windowFound,
    terminalState: displayAnalysis?.terminalState,
    hasDisplayedPrompt: !!displayAnalysis?.nextPrompt?.trim(),
    sendInFlight: isSendInFlight(),
  })
}

/** Push the current send eligibility to the guidance window (fire-and-forget). */
async function pushSendEligibility(): Promise<void> {
  try {
    sendGuidanceSendState(await computeSendEligibility())
  } catch (error) {
    console.warn('[Send] eligibility push failed:', error)
  }
}

// One authorizer for the app's lifetime: each prompt id can be pasted once.
const sendAuthorizer = new SendAuthorizer()

/** Current main-side state a paste is bound to (see send-authorization.ts). */
function currentSendContext(): SendContext {
  return {
    promptId: displayAnalysis?.promptId ?? null,
    promptText: displayAnalysis?.nextPrompt ?? '',
    projectId: getActiveProject()?.id ?? null,
    session: currentSession,
    sourceId: watchedSourceId,
  }
}

/**
 * Handle a paste request from the guidance window. The renderer supplies ONLY a
 * prompt id; main resolves the text itself and binds the paste, at click time,
 * to the exact prompt text and id, the active project, the watch session and
 * the watched window. The binding is re-checked after every await (and once
 * more immediately before the paste keystroke) and can be used only once.
 * Serialized: a second request while one is in flight is rejected, not queued.
 */
export async function handleSendPromptRequest(promptId: string): Promise<SendPromptResult> {
  logWatchEvent('send-requested', { session: currentSession })
  const result = await sendPromptRequest(promptId)
  // Outcome codes only — never the prompt text.
  logWatchEvent(result.sent ? 'send-pasted' : 'send-refused', {
    session: currentSession,
    reason: result.sent ? undefined : result.reason,
    detail: result.sent ? undefined : result.detail,
  })
  return result
}

async function sendPromptRequest(promptId: string): Promise<SendPromptResult> {
  console.log('[Send] request received')

  const authorization = sendAuthorizer.authorize(promptId, currentSendContext())
  if (!authorization.ok) {
    console.log(`[Send] rejected: ${authorization.reason}`)
    return { sent: false, reason: 'stale', detail: authorization.reason }
  }
  const binding = authorization.binding
  let pasted = false
  try {
    const expectedOutcome = displayAnalysis?.expectedOutcome || ''

    const eligibility = await computeSendEligibility()
    const changedAfterEligibility = sendAuthorizer.changed(binding, currentSendContext())
    if (changedAfterEligibility) {
      console.log(`[Send] aborted: ${changedAfterEligibility}`)
      return { sent: false, reason: 'stale', detail: changedAfterEligibility }
    }
    if (!eligibility.canSend) {
      console.log(`[Send] rejected: not eligible (${eligibility.sendBlockedReason})`)
      return { sent: false, reason: 'not_eligible', detail: eligibility.sendBlockedReason }
    }

    const sendPromise = executeSend(
      binding.promptText,
      { title: watchedWindowName || '', sourceId: binding.sourceId },
      () => sendAuthorizer.changed(binding, currentSendContext()),
    )
    void pushSendEligibility() // in-flight now → button disables while pasting
    const result = await sendPromise
    const changedAfterPaste = sendAuthorizer.changed(binding, currentSendContext())
    pasted = result.sent

    // macOS permission problems: the guidance panel shows the fix inline (it got
    // the reason); the mascot label says it too, until the next good cycle.
    if (!result.sent && (result.reason === 'accessibility_permission' || result.reason === 'automation_permission')) {
      const permission = result.reason === 'accessibility_permission' ? 'accessibility' : 'automation'
      if (companionRef && !companionRef.isDestroyed()) {
        errorLabelShown = true
        companionRef.webContents.send(IPC.COMPANION_WATCHED_SOURCE, {
          windowName: watchedWindowName, message: MAC_PERMISSION_MESSAGES[permission],
        })
      }
    }

    if (shouldRegisterOutcome(result, changedAfterPaste)) {
      // Only a prompt that was actually PASTED becomes the pending outcome
      // (replacing any earlier one) so the verifier judges what the user ran.
      const outcome = replacePendingOutcome(sanitizePromptForSend(binding.promptText), expectedOutcome)
      console.log(`[Send] ${outcome ? 'registered pasted prompt as the pending outcome' : 'no expected outcome — nothing registered for verification'}`)

      if (companionRef && !companionRef.isDestroyed()) {
        companionRef.webContents.send(IPC.SEND_STATUS, 'sent')
      }
      // The user runs the pasted prompt themselves; treat the next 3 minutes as
      // working mode (no timer AI calls; the 5s local poll decides when the
      // agent's turn ends).
      turnDetector.noteSend(Date.now())
      triggerImmediateAnalysis(binding.session)
    }

    void pushSendEligibility()
    return result
  } finally {
    // Only a successful paste uses the authorization up; failures can be retried.
    sendAuthorizer.finish(binding.promptId ?? '', pasted)
  }
}

/**
 * Run one analysis cycle now — after a send (so the next reading confirms the
 * sent prompt landed) or when the turn detector fires — respecting the
 * existing in-flight guard: if a cycle is already running it will pick up the
 * change itself, so we do nothing.
 */
function triggerImmediateAnalysis(mySession: number): void {
  if (isStaleSession(mySession, currentSession)) return
  if (inFlight) {
    console.log('[Send] analysis already in flight — skipping immediate trigger')
    return
  }
  if (!companionRef || companionRef.isDestroyed() || !watchedSourceId) return
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = null }
  console.log('[Send] triggering immediate analysis')
  // force=true: this deliberate one-off must run even in working mode (the
  // 3-min post-send window / a "working" reading would otherwise skip it).
  void runCycleAndReschedule(companionRef, mySession, true)
}

/**
 * Verifier (Block 4): judge whether a previously-suggested prompt achieved its
 * expected outcome, using the current analysis as evidence. Runs in parallel and
 * respects the session token, so a stale-window verdict is discarded and voice
 * never fires for the wrong window. Records completions/blockers in Nemp and, on
 * failure, swaps in a corrective prompt.
 */
function runVerifier(
  companionWindow: BrowserWindow,
  pending: PromptOutcome,
  analysis: AnalysisResult,
  memoryContext: string,
  settings: AppSettings,
  mySession: number,
  memScope: string
): void {
  const memory = nemp.writerFor(memScope)
  void (async () => {
    try {
      const verdict = await verifyPromptOutcome(pending, analysis, watchedGoal, memoryContext, settings)
      // Not enough evidence yet — leave it pending for a later cycle, show nothing.
      if (verdict.status === 'still_pending') return
      // Don't repaint / record for a window the user has since switched away from.
      if (isStaleSession(mySession, currentSession)) return

      resolveOutcome(pending.id, verdict.status, verdict.note, verdict.correctivePrompt)

      const note = verdict.note || pending.expectedOutcome
      if (verdict.status === 'success') {
        void memory.recordCompletion(pending.expectedOutcome)
      } else if (verdict.status === 'failed') {
        void memory.recordBlocker(note)
      }

      const verification: VerificationVerdict = { status: verdict.status, note }
      const patch: Partial<AnalysisResult> = { verification }
      // On a failed/partial outcome, offer the corrective prompt as the next step.
      if (verdict.correctivePrompt) patch.nextPrompt = verdict.correctivePrompt
      patchDisplayAndResend(companionWindow, patch, mySession)
      console.log(`[Verifier] previous prompt → ${verdict.status}`)
    } catch (error) {
      debugError('[AnalysisLoop] verifier failed:', error)
    }
  })()
}
