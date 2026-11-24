// cost-guard.ts — rolling-hour provider-call budget.
// Every provider call (analysis + grader + verifier) is recorded; when the
// count in the sliding 60-minute window reaches the user's cap, watching is
// paused to protect their API budget. The window logic is PURE (unit-tested
// with a fake clock); a module-level singleton tracks the app-wide count.

export const HOUR_MS = 3_600_000

export interface RollingWindow {
  timestamps: number[]   // call times (ms epoch), pruned to the last hour
}

/** Drop timestamps older than one hour before `now`. */
export function pruneWindow(window: RollingWindow, now: number): void {
  const cutoff = now - HOUR_MS
  // timestamps are appended in order — find the first still-valid index.
  let firstValid = 0
  while (firstValid < window.timestamps.length && window.timestamps[firstValid] <= cutoff) firstValid++
  if (firstValid > 0) window.timestamps.splice(0, firstValid)
}

/** Record one provider call at `now`. */
export function recordCall(window: RollingWindow, now: number): void {
  pruneWindow(window, now)
  window.timestamps.push(now)
}

/** Calls made within the last hour as of `now`. */
export function callsInWindow(window: RollingWindow, now: number): number {
  pruneWindow(window, now)
  return window.timestamps.length
}

/** True when the rolling-hour count has reached the cap. */
export function atCap(window: RollingWindow, cap: number, now: number): boolean {
  return callsInWindow(window, now) >= cap
}

// ─── App-wide singleton (used by the analysis loop, grader and verifier) ─────

const globalWindow: RollingWindow = { timestamps: [] }

/** Record one real provider call (analysis, grader or verifier). */
export function recordProviderCall(): void {
  recordCall(globalWindow, Date.now())
}

/** "Calls this hour" for the guidance panel footer. */
export function getCallsThisHour(): number {
  return callsInWindow(globalWindow, Date.now())
}

/** Has the app hit the user's hourly call cap? */
export function isAtHourlyCap(cap: number): boolean {
  return atCap(globalWindow, cap, Date.now())
}

/**
 * Take one request from the hourly budget, just before a paid request is
 * sent: false (and nothing recorded) when the cap is already reached. Every
 * AI request goes through this — watching, questions, Brainstorm, the prompt
 * grader and the verifier — so "the most AI requests MyBuildy will make in any
 * one hour" holds for all of them. Check-and-record is one synchronous step, so
 * two requests can't both take the last slot.
 */
export function reserveProviderCall(cap: number): boolean {
  if (isAtHourlyCap(cap)) return false
  recordProviderCall()
  return true
}

/** What the user sees when a request was not sent because of the hourly cap. */
export function hourlyCapMessage(cap: number): string {
  return `You've reached your limit of ${cap} AI requests this hour, so nothing was sent. You can raise the limit in Settings.`
}
