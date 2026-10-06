import { describe, it, expect } from 'vitest'
import {
  isStaleSession, findWatchedSource,
  startContinuity, pollContinuity, normalizeTitle,
  MISSING_RESUME_ANY_TITLE_MS, MISSING_LOST_MS,
} from './capture-guard'

describe('findWatchedSource — resolve by source id (titles change every agent turn)', () => {
  const CIVITAS = { id: 'window:42:0', name: 'CIVITAS' }
  const POWERSHELL = { id: 'window:99:0', name: 'Windows PowerShell' }

  it('returns the watched window when its id is present', () => {
    const live = [CIVITAS, POWERSHELL]
    expect(findWatchedSource(live, 'window:42:0')).toEqual(CIVITAS)
  })

  it('returns null when the stored id is NOT in the current window list', () => {
    const live = [POWERSHELL] // CIVITAS closed, id gone entirely
    expect(findWatchedSource(live, 'window:42:0')).toBeNull()
  })

  it('resolves by id even when the title changed (renames are NOT target loss)', () => {
    // Was: 'HALTS when the watched window title changed' — coding agents rename
    // the terminal every turn, so a rename must keep the watch. HWND reuse is
    // guarded by the continuity tracker, not by a title match here.
    const live = [{ id: 'window:42:0', name: 'Set up SQLite database and client management feature' }]
    expect(findWatchedSource(live, 'window:42:0')).toEqual(live[0])
  })

  it('returns null when nothing is selected', () => {
    expect(findWatchedSource([CIVITAS], null)).toBeNull()
  })
})

describe('watch continuity — same id in consecutive polls = same window', () => {
  const ID = 'window:42:0'
  const T0 = 1_000_000

  it('a title change with the same id keeps the watch and updates the stored title', () => {
    const watch = startContinuity(ID, '✳ Claude Code')
    const event = pollContinuity(watch, [{ id: ID, name: 'Set up SQLite database and client management feature' }], T0)
    expect(event).toEqual({
      kind: 'title-changed',
      from: '✳ Claude Code',
      to: 'Set up SQLite database and client management feature',
    })
    expect(watch.state).toBe('watching')
    expect(watch.title).toBe('Set up SQLite database and client management feature')
    // Next poll with the new title is business as usual.
    expect(pollContinuity(watch, [{ id: ID, name: 'Set up SQLite database and client management feature' }], T0 + 2000))
      .toEqual({ kind: 'none' })
  })

  it('an unchanged poll emits none', () => {
    const watch = startContinuity(ID, '✳ Claude Code')
    expect(pollContinuity(watch, [{ id: ID, name: '✳ Claude Code' }], T0)).toEqual({ kind: 'none' })
    expect(watch.state).toBe('watching')
  })

  it('id absent → went-missing once, then quiet while the grace runs', () => {
    const watch = startContinuity(ID, '✳ Claude Code')
    expect(pollContinuity(watch, [], T0)).toEqual({ kind: 'went-missing' })
    expect(watch.state).toBe('missing')
    expect(pollContinuity(watch, [], T0 + 2000)).toEqual({ kind: 'none' })
  })

  it('id back within 15s resumes regardless of title (renamed during the gap)', () => {
    const watch = startContinuity(ID, '✳ Claude Code')
    pollContinuity(watch, [], T0)
    const event = pollContinuity(watch, [{ id: ID, name: 'Totally different task title' }], T0 + 10_000)
    expect(event).toEqual({ kind: 'resumed', title: 'Totally different task title' })
    expect(watch.state).toBe('watching')
    expect(watch.title).toBe('Totally different task title')
  })

  it('id back between 15s and 60s with the SAME normalized title resumes', () => {
    const watch = startContinuity(ID, '✳ Claude Code')
    pollContinuity(watch, [], T0)
    const event = pollContinuity(watch, [{ id: ID, name: '⠋ Claude Code' }], T0 + 30_000)
    expect(event).toEqual({ kind: 'resumed', title: '⠋ Claude Code' })
    expect(watch.state).toBe('watching')
  })

  it('id back between 15s and 60s with a DIFFERENT normalized title halts (possible HWND reuse)', () => {
    // Was part of: 'HALTS when the id was reused by a DIFFERENT window (HWND reuse)'
    // — reuse requires the original window's destruction, which shows up as a
    // missing gap. After the 15s any-title grace, a returning id with another
    // identity is indistinguishable from reuse, so it halts.
    const watch = startContinuity(ID, 'CIVITAS')
    pollContinuity(watch, [], T0)
    const event = pollContinuity(watch, [{ id: ID, name: 'Windows PowerShell' }], T0 + 30_000)
    expect(event).toEqual({ kind: 'lost', reason: 'returned-with-new-title' })
    expect(watch.state).toBe('lost')
  })

  it('absent for 60s halts and stays lost', () => {
    const watch = startContinuity(ID, '✳ Claude Code')
    pollContinuity(watch, [], T0)
    expect(pollContinuity(watch, [], T0 + MISSING_LOST_MS)).toEqual({ kind: 'lost', reason: 'missing-too-long' })
    expect(watch.state).toBe('lost')
    // Once lost, nothing revives it — the user must reselect.
    expect(pollContinuity(watch, [{ id: ID, name: '✳ Claude Code' }], T0 + MISSING_LOST_MS + 2000))
      .toEqual({ kind: 'none' })
    expect(watch.state).toBe('lost')
  })

  it('grace boundaries: 15s is still any-title, 60s is lost even if the id is back', () => {
    const anyTitle = startContinuity(ID, 'CIVITAS')
    pollContinuity(anyTitle, [], T0)
    expect(pollContinuity(anyTitle, [{ id: ID, name: 'renamed' }], T0 + MISSING_RESUME_ANY_TITLE_MS))
      .toEqual({ kind: 'resumed', title: 'renamed' })

    const tooLate = startContinuity(ID, 'CIVITAS')
    pollContinuity(tooLate, [], T0)
    expect(pollContinuity(tooLate, [{ id: ID, name: 'CIVITAS' }], T0 + MISSING_LOST_MS))
      .toEqual({ kind: 'lost', reason: 'missing-too-long' })
  })
})

describe('normalizeTitle — status glyphs and case are not identity', () => {
  it('treats "✳ Claude Code", "⠋ Claude Code" and "claude code" as equal', () => {
    expect(normalizeTitle('✳ Claude Code')).toBe('claude code')
    expect(normalizeTitle('⠋ Claude Code')).toBe('claude code')
    expect(normalizeTitle('claude code')).toBe('claude code')
    expect(normalizeTitle('✳ Claude Code')).toBe(normalizeTitle('⠋ Claude Code'))
  })

  it('collapses whitespace and trims', () => {
    expect(normalizeTitle('  Claude   Code  ')).toBe('claude code')
  })

  it('distinguishes genuinely different titles', () => {
    expect(normalizeTitle('✳ Claude Code')).not.toBe(normalizeTitle('Windows PowerShell'))
  })
})

describe('isStaleSession — discard wrong-window results', () => {
  it('keeps a result from the current session', () => {
    expect(isStaleSession(5, 5)).toBe(false)
  })

  it('discards a result whose session has advanced (window switched/stopped)', () => {
    expect(isStaleSession(5, 6)).toBe(true)
    expect(isStaleSession(5, 0)).toBe(true)
  })
})
