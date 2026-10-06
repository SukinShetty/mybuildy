import { describe, it, expect } from 'vitest'
import { pickableWindows, codingRank, type WindowFlags } from './window-list'
import { parseFlagsOutput } from './window-presence'

const app: WindowFlags = { visible: true, cloaked: false, toolWindow: false, transparent: false, noActivate: false }

// The list Electron gave on a real Windows PC (window names as listed), with
// what Windows said about each window.
const LISTED = [
  { id: 'window:852610:1', name: 'MyBuildy' },                    // this app's own window
  { id: 'window:133466:0', name: 'Status' },                      // a status overlay
  { id: 'window:724776:0', name: 'Buildy plan - Claude - Google Chrome' },
  { id: 'window:459548:0', name: 'session-2 - File Explorer' },
  { id: 'window:6360842:0', name: 'MyBuildy' },                   // another running copy of MyBuildy
  { id: 'window:6099000:0', name: 'Settings' },
  { id: 'window:6492776:0', name: 'NVIDIA GeForce Overlay' },
  { id: 'window:1577372:0', name: 'Cua.AgentCursorOverlay.default' },
  { id: 'window:555:0', name: 'Windows PowerShell' },
  { id: 'window:556:0', name: '✳ Fix invoice totals' },           // a Claude Code tab
  { id: 'window:557:0', name: 'main.ts - my-app - Cursor' },
  { id: 'window:558:0', name: 'Closed Store app' },               // cloaked by Windows
]
const FLAGS = new Map<string, WindowFlags>([
  ['window:133466:0', { ...app, toolWindow: true, transparent: true, noActivate: true }],
  ['window:724776:0', app],
  ['window:459548:0', app],
  ['window:6360842:0', { ...app, transparent: true, noActivate: true }],
  ['window:6099000:0', app],
  ['window:6492776:0', { ...app, toolWindow: true, noActivate: true }],
  ['window:1577372:0', { ...app, toolWindow: true, transparent: true, noActivate: true }],
  ['window:555:0', app],
  ['window:556:0', app],
  ['window:557:0', app],
  ['window:558:0', { ...app, cloaked: true }],
])
const OWN = new Set(['window:852610:1'])

describe('the window picker', () => {
  it("never lists MyBuildy's own windows, overlays or hidden windows; coding apps come first", () => {
    expect(pickableWindows(LISTED, OWN, FLAGS).map((w) => w.name)).toEqual([
      'Windows PowerShell',
      '✳ Fix invoice totals',
      'main.ts - my-app - Cursor',
      'Buildy plan - Claude - Google Chrome',
      'session-2 - File Explorer',
      'Settings',
    ])
  })

  it('without the OS flags (macOS, or the probe failed) known overlays and MyBuildy still never show', () => {
    const names = pickableWindows(LISTED, OWN, null).map((w) => w.name)
    expect(names).not.toContain('MyBuildy')
    expect(names).not.toContain('NVIDIA GeForce Overlay')
    expect(names).not.toContain('Cua.AgentCursorOverlay.default')
    expect(names[0]).toBe('Windows PowerShell')
  })

  it('terminals and coding apps on Windows and macOS rank first; a browser tab that mentions them does not', () => {
    for (const name of [
      'Windows PowerShell', 'Administrator: Windows PowerShell', 'Windows Terminal', 'Command Prompt', 'Terminal',
      'sukin — -zsh — 80×24', 'iTerm2', 'README.md - my-app - Visual Studio Code', 'app.tsx - shop - Cursor',
      'Claude', '⠋ Building the login page', 'MINGW64:/c/Users/me/app', 'Ubuntu',
    ]) expect(codingRank(name), name).toBe(0)
    for (const name of ['Inbox - Gmail - Google Chrome', 'Claude Code docs - Microsoft Edge', 'Settings', 'Spotify']) {
      expect(codingRank(name), name).toBe(1)
    }
  })

  it('reads the Windows flags probe output', () => {
    const flags = parseFlagsOutput('555 10000\r\n6492776 10101\r\n558 11000\r\n999 gone\r\nnoise\r\n')
    expect(flags.get('555')).toEqual(app)
    expect(flags.get('6492776')).toEqual({ ...app, toolWindow: true, noActivate: true })
    expect(flags.get('558')?.cloaked).toBe(true)
    expect(flags.get('999')?.visible).toBe(false) // closed between the list and the probe
    expect(flags.size).toBe(4)
  })
})
