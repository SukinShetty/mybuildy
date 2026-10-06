// capturer.ts — main process
// Screen and window capture via Electron's desktopCapturer API.
//
// SAFETY: MyBuildy does NOT auto-detect windows and NEVER falls back to capturing
// the full desktop. The user explicitly chooses which window to watch. If that
// window disappears, capture HALTS (returns null / a halt outcome) so we never
// silently send the user's whole screen to an AI provider.
//
// The picker thumbnails are deliberately LOW-RESOLUTION (so other apps aren't
// captured in high fidelity); only the SELECTED window is captured full-res.

import { desktopCapturer } from 'electron'
import type { WindowSource, CaptureResult } from '../renderer/src/types'
import { findWatchedSource } from './capture-guard'
import { pickableWindows } from './window-list'
import { probeWindowFlags } from './window-presence'
import { isBlankFrame } from './mac-permissions-core'

// Picker thumbnails: small + lower quality to minimise exposure of other windows.
const THUMB_SIZE = { width: 160, height: 100 }
const THUMB_QUALITY = 40
// Full-res capture of the SELECTED window only.
const CAPTURE_SIZE = { width: 1280, height: 800 }
const CAPTURE_QUALITY = 88
// Turn-end poll: LOW-RESOLUTION thumbnail of the watched window only, consumed
// locally by computeImageChangeFraction and discarded. NEVER sent to any
// provider — it exists so mid-turn polling costs no AI calls (turn-detector.ts).
const POLL_SIZE = { width: 480, height: 300 }
const POLL_QUALITY = 50

// ─── Continuity poll (cheap id/title list, no thumbnails) ────────────────────

/**
 * The current window sources as bare (id, name) pairs — no thumbnails, so this
 * is cheap enough to run every 2 s for the watch-continuity poll.
 */
export async function listLiveWindowSources(): Promise<{ id: string; name: string }[]> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  })
  return sources.map((source) => ({ id: source.id, name: source.name }))
}

// ─── List windows (for user to pick from) ────────────────────────────────────

/**
 * The windows the user can pick from, fresh every call: never MyBuildy's own
 * windows (`ownIds`) or system overlays, terminals and coding apps first
 * (window-list.ts). Thumbnails are low-resolution to reduce exposure of other
 * apps' contents.
 */
export async function listOpenWindows(ownIds: ReadonlySet<string>): Promise<WindowSource[]> {
  const [sources, flags] = await Promise.all([
    desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: THUMB_SIZE,
      fetchWindowIcons: false,
    }),
    // Windows: ask the OS which of them are overlays or hidden (in parallel).
    listLiveWindowSources().then((live) => probeWindowFlags(live.map((w) => w.id))),
  ])

  return pickableWindows(sources, ownIds, flags)
    .map((source) => ({
      id: source.id,
      name: source.name,
      thumbnailBase64: source.thumbnail.toJPEG(THUMB_QUALITY).toString('base64'),
    }))
}

// ─── Capture a specific window ───────────────────────────────────────────────

/**
 * Captures a specific window by its source ID at full resolution. Returns null
 * if that id is not in the live list right now — the caller decides whether
 * that means a brief gap (continuity grace) or real loss. NEVER falls back to
 * another window or the full screen. Identity is the id alone: titles change
 * legitimately every agent turn, and HWND/id reuse is guarded by the
 * continuity tracker in capture-guard.ts, not by a title match here.
 */
export async function captureWatchedWindow(
  sourceId: string,
  _expectedName: string | null
): Promise<CaptureResult | null> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: CAPTURE_SIZE,
    fetchWindowIcons: false,
  })

  const target = findWatchedSource(sources, sourceId)
  if (!target) {
    return null // watched window not in the current list — caller decides, never guess
  }

  return {
    imageBase64: target.thumbnail.toJPEG(CAPTURE_QUALITY).toString('base64'),
    windowTitle: target.name,
    sourceId: target.id,
    capturedAt: new Date().toISOString(),
  }
}

/**
 * Low-res LOCAL poll capture of the watched window for turn-end detection.
 * Returns the JPEG base64 or null if the window is not in the live list (the
 * continuity poll owns the missing/lost decision). Same no-fallback rule as
 * captureWatchedWindow: never another window, never the full screen.
 */
export async function capturePollThumbnail(sourceId: string): Promise<string | null> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: POLL_SIZE,
    fetchWindowIcons: false,
  })
  const target = findWatchedSource(sources, sourceId)
  if (!target) return null
  return target.thumbnail.toJPEG(POLL_QUALITY).toString('base64')
}

/**
 * One small frame of the chosen window, checked for content — used at watch
 * start on macOS, where a missing Screen Recording permission yields frames
 * with nothing in them instead of an error. 'missing' = not in the live list.
 */
export async function probeWatchedWindowFrame(sourceId: string): Promise<'ok' | 'blank' | 'missing'> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: THUMB_SIZE,
    fetchWindowIcons: false,
  })
  const target = findWatchedSource(sources, sourceId)
  if (!target) return 'missing'
  const { width, height } = target.thumbnail.getSize()
  if (target.thumbnail.isEmpty()) return 'blank'
  return isBlankFrame(target.thumbnail.toBitmap(), width, height) ? 'blank' : 'ok'
}
