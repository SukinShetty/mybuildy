// capture-guard.ts — main process (ELECTRON-FREE, unit-tested)
// Pure decision helpers for safety-critical watch behaviours:
//   1. Screen capture must NEVER silently fall back to the full desktop: only
//      the watched window, found by source id, is ever captured.
//   2. The analysis loop must discard results from a stale watching session (the
//      user switched/stopped the watched window while a cycle was in flight), so
//      guidance for the wrong window is never shown or spoken.
//   3. Continuity-based watch identity: AI coding agents (Claude Code, Codex)
//      rename the terminal on every state change, so the title is NOT an
//      identity field. On Windows a desktopCapturer source id (window:<HWND>:0)
//      can only be reused after the original window is destroyed — so an id that
//      is present in every consecutive continuity poll since selection is the
//      same window regardless of title. Only when the id DISAPPEARS does reuse
//      become possible; the grace rules below guard that gap.

/**
 * Locate the user's watched window in the CURRENT live window list by source id.
 *
 * Identity is the source id ALONE — the title is deliberately not checked,
 * because coding agents legitimately rename their terminal every turn and a
 * title match would halt the watch on every rename. HWND/id reuse (a closed
 * window's id handed to a different window) is guarded by the continuity
 * tracker instead: reuse requires the original window to be destroyed first,
 * which makes the id vanish from at least one 2s continuity poll, and the
 * missing-state rules in pollContinuity decide whether a returning id may be
 * trusted. Returns null to signal "not in the list right now" — the caller
 * NEVER falls through to another window or the full screen.
 */
export function findWatchedSource<T extends { id: string; name: string }>(
  sources: readonly T[],
  watchedId: string | null
): T | null {
  if (!watchedId) return null
  return sources.find((s) => s.id === watchedId) ?? null
}

/**
 * True if a cycle that started in `cycleSession` is now stale because the current
 * session has advanced (window switched / watch stopped+restarted). Stale results
 * must be discarded: do not mutate state, send guidance, or speak.
 */
export function isStaleSession(cycleSession: number, currentSession: number): boolean {
  return cycleSession !== currentSession
}

// ─── Watch continuity (title changes are NOT target loss) ────────────────────

// Missing-id grace rules (see pollContinuity):
//   - back within 15 s → same window even if renamed during the gap → resume
//   - back within 60 s → resume ONLY if the normalized title still matches
//   - absent for 60 s → the window is really gone → halt, user must reselect
export const MISSING_RESUME_ANY_TITLE_MS = 15_000
export const MISSING_LOST_MS = 60_000

export type WatchContinuityState = 'watching' | 'missing' | 'lost'

export interface WatchContinuity {
  sourceId: string
  title: string              // last title seen while confirmed to be the same window
  state: WatchContinuityState
  missingSinceMs: number | null
  // Process that owned the window when the watch started (Windows; null when
  // unknown). Lets an OS presence check confirm a missing id is still the SAME
  // window — see pollContinuityWithPresence.
  ownerPid: number | null
}

/** What the OS says about the watched window right now (window-presence.ts). */
export interface WindowPresence {
  exists: boolean
  minimized: boolean
  ownerPid: number | null
}

export type LostReason = 'missing-too-long' | 'returned-with-new-title' | 'closed' | 'continuity-gap'

export type ContinuityEvent =
  | { kind: 'none' }
  | { kind: 'title-changed'; from: string; to: string }
  // stillOpen: the OS confirmed the same window still exists (minimized/hidden).
  | { kind: 'went-missing'; stillOpen?: boolean; minimized?: boolean }
  | { kind: 'resumed'; title: string }
  // The rules would have declared the window lost, but the OS confirmed it is
  // the same window, still open — the grace period starts again.
  | { kind: 'still-open'; minimized: boolean }
  | { kind: 'lost'; reason: LostReason }

/** Begin tracking the user-selected window (called on watch start). */
export function startContinuity(sourceId: string, title: string, ownerPid: number | null = null): WatchContinuity {
  return { sourceId, title, state: 'watching', missingSinceMs: null, ownerPid }
}

/**
 * Normalize a window title for identity comparison across agent status glyphs:
 * trim, drop leading non-alphanumeric characters (spinners/status marks such as
 * ✳ or ⠋), lowercase, collapse whitespace. "✳ Claude Code", "⠋ Claude Code" and
 * "claude code" all normalize to "claude code".
 */
export function normalizeTitle(title: string): string {
  return (title || '')
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Advance the continuity tracker with a fresh window-source poll. Mutates the
 * tracker and returns the event the caller should react to.
 *
 * Present id  → same window (id reuse requires destruction first, which would
 *               have shown up as a missing poll). A changed title is accepted
 *               and stored — never a halt.
 * Missing id  → grace: within MISSING_RESUME_ANY_TITLE_MS any title resumes;
 *               within MISSING_LOST_MS only a normalized-title match resumes
 *               (a returning id with a different title after a long gap is
 *               indistinguishable from HWND reuse by another window → halt);
 *               after MISSING_LOST_MS the watch is lost.
 */
export function pollContinuity(
  watch: WatchContinuity,
  sources: readonly { id: string; name: string }[],
  nowMs: number
): ContinuityEvent {
  if (watch.state === 'lost') return { kind: 'none' }

  const source = findWatchedSource(sources, watch.sourceId)

  if (!source) {
    if (watch.state === 'watching') {
      watch.state = 'missing'
      watch.missingSinceMs = nowMs
      return { kind: 'went-missing' }
    }
    // Already missing — check whether the grace window has run out.
    if (nowMs - (watch.missingSinceMs ?? nowMs) >= MISSING_LOST_MS) {
      watch.state = 'lost'
      return { kind: 'lost', reason: 'missing-too-long' }
    }
    return { kind: 'none' }
  }

  if (watch.state === 'watching') {
    if (source.name !== watch.title) {
      const from = watch.title
      watch.title = source.name
      return { kind: 'title-changed', from, to: source.name }
    }
    return { kind: 'none' }
  }

  // state === 'missing' and the id is back.
  const missingForMs = nowMs - (watch.missingSinceMs ?? nowMs)
  const sameNormalizedTitle = normalizeTitle(source.name) === normalizeTitle(watch.title)
  if (missingForMs <= MISSING_RESUME_ANY_TITLE_MS || (missingForMs < MISSING_LOST_MS && sameNormalizedTitle)) {
    watch.state = 'watching'
    watch.missingSinceMs = null
    watch.title = source.name
    return { kind: 'resumed', title: source.name }
  }
  // Back too late (≥ 60 s) or with a different identity after the 15 s
  // any-title grace — cannot distinguish from HWND reuse. Halt.
  watch.state = 'lost'
  return { kind: 'lost', reason: missingForMs >= MISSING_LOST_MS ? 'missing-too-long' : 'returned-with-new-title' }
}

/**
 * True when the OS confirms the watched window itself still exists: the same
 * handle, owned by the same process as when the watch started. A handle value
 * can only be reused after its window is destroyed, and a reused one would
 * have to land in the same process too — so this is the same window.
 */
export function isSameWindowStillOpen(watch: WatchContinuity, presence: WindowPresence | null): boolean {
  return !!presence && presence.exists && watch.ownerPid !== null && presence.ownerPid === watch.ownerPid
}

/**
 * pollContinuity, plus an OS presence check at the two decision points:
 *
 *   - went-missing: is the window only minimized/hidden? (for the message and
 *     the diagnostic log; the grace rules still run)
 *   - lost: before halting, ask whether the same window still exists. On
 *     Windows a minimized window drops out of the capture list — it is not
 *     gone. If it still exists the watch resumes (id back in the list) or the
 *     grace period starts again (still minimized). Only a window the OS says is
 *     closed — or one that can't be confirmed — is lost.
 *
 * The probe is injected (window-presence.ts in the app), so this stays pure
 * and unit-testable. Resolves null → the rules apply unchanged.
 */
export async function pollContinuityWithPresence(
  watch: WatchContinuity,
  sources: readonly { id: string; name: string }[],
  nowMs: number,
  probe: () => Promise<WindowPresence | null>
): Promise<ContinuityEvent> {
  const event = pollContinuity(watch, sources, nowMs)
  if (event.kind === 'went-missing') {
    const presence = await probe()
    return isSameWindowStillOpen(watch, presence)
      ? { kind: 'went-missing', stillOpen: true, minimized: presence!.minimized }
      : event
  }
  if (event.kind !== 'lost') return event

  const presence = await probe()
  if (presence && !presence.exists) return { kind: 'lost', reason: 'closed' }
  if (!isSameWindowStillOpen(watch, presence)) return event

  const back = findWatchedSource(sources, watch.sourceId)
  if (back) {
    watch.state = 'watching'
    watch.missingSinceMs = null
    watch.title = back.name
    return { kind: 'resumed', title: back.name }
  }
  watch.state = 'missing'
  watch.missingSinceMs = nowMs
  return { kind: 'still-open', minimized: presence!.minimized }
}


/** Launch-safe policy: any observed source-list gap ends the watch. A PID or
 * title match after a gap cannot prove that a recycled window id is the same
 * selected window. The user must explicitly select a window again. */
export function pollStrictContinuity(
  watch: WatchContinuity,
  sources: readonly { id: string; name: string }[],
  nowMs: number,
): ContinuityEvent {
  if (watch.state === 'lost') return { kind: 'none' }
  if (watch.state === 'missing' || !findWatchedSource(sources, watch.sourceId)) {
    watch.state = 'lost'
    return { kind: 'lost', reason: 'continuity-gap' }
  }
  return pollContinuity(watch, sources, nowMs)
}
