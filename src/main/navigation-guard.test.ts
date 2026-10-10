// navigation-guard.test.ts
// Pure predicates behind the global web-contents security guard:
//   - isSafeExternalUrl: which URLs may be forwarded to the OS browser
//   - isAllowedAppNavigation: which URLs the app's own renderers may navigate to
//     (only the packaged file:// bundle or the dev server origin)
//   - isBlockedDevShortcut: reload/devtools keys blocked in packaged builds

import { describe, it, expect } from 'vitest'
import {
  isSafeExternalUrl,
  isAllowedAppNavigation,
  isBlockedDevShortcut,
} from './navigation-guard'

describe('isSafeExternalUrl', () => {
  it('allows https and mailto', () => {
    expect(isSafeExternalUrl('https://example.com/docs')).toBe(true)
    expect(isSafeExternalUrl('mailto:hello@example.com')).toBe(true)
  })

  it('denies http, file, custom protocols and malformed URLs', () => {
    expect(isSafeExternalUrl('http://example.com')).toBe(false)
    expect(isSafeExternalUrl('file:///C:/Windows/system.ini')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('custom-app://payload')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
    expect(isSafeExternalUrl('')).toBe(false)
  })
})

describe('isAllowedAppNavigation', () => {
  it('allows only the specified bundled renderer document', () => {
    expect(isAllowedAppNavigation('file:///C:/app/resources/renderer/index.html', undefined, 'file:///C:/app/resources/renderer/index.html')).toBe(true)
    expect(isAllowedAppNavigation('file:///C:/app/renderer/index.html?companion=true', null, 'file:///C:/app/renderer/index.html')).toBe(true)
  })

  it('rejects arbitrary files, sibling documents, traversal and non-file bundled URLs', () => {
    const bundle = 'file:///app/renderer/index.html'
    for (const target of ['file:///tmp/hostile.html', 'file:///app/renderer/other.html', 'file:///app/renderer/../hostile.html', 'file://other-host/app/renderer/index.html']) {
      expect(isAllowedAppNavigation(target, null, bundle)).toBe(false)
    }
    expect(isAllowedAppNavigation(bundle)).toBe(false)
    expect(isAllowedAppNavigation(bundle, null, 'https://example.com/index.html')).toBe(false)
    expect(isAllowedAppNavigation(`${bundle}?guidance=true#view`, null, bundle)).toBe(true)
    expect(isAllowedAppNavigation('data:text/html,hello', 'file:///tmp/')).toBe(false)
  })

  it('allows the dev server origin when one is configured', () => {
    const dev = 'http://localhost:5173'
    expect(isAllowedAppNavigation('http://localhost:5173/', dev)).toBe(true)
    expect(isAllowedAppNavigation('http://localhost:5173/index.html?guidance=true', dev)).toBe(true)
  })

  it('denies other origins even when a dev server is configured', () => {
    const dev = 'http://localhost:5173'
    expect(isAllowedAppNavigation('http://localhost:9999/', dev)).toBe(false)
    expect(isAllowedAppNavigation('https://example.com/', dev)).toBe(false)
    expect(isAllowedAppNavigation('http://evil.localhost:5173/', dev)).toBe(false)
  })

  it('denies remote and scriptable URLs with no dev server (packaged)', () => {
    expect(isAllowedAppNavigation('https://example.com/', undefined)).toBe(false)
    expect(isAllowedAppNavigation('http://localhost:5173/', undefined)).toBe(false)
    expect(isAllowedAppNavigation('javascript:alert(1)', undefined)).toBe(false)
    expect(isAllowedAppNavigation('not a url', undefined)).toBe(false)
  })

  it('tolerates a malformed dev server URL by denying http', () => {
    expect(isAllowedAppNavigation('http://localhost:5173/', 'not a url')).toBe(false)
    expect(isAllowedAppNavigation('file:///C:/app/index.html', 'not a url')).toBe(false)
  })
})

describe('isBlockedDevShortcut', () => {
  const key = (
    k: string,
    mods: Partial<{ control: boolean; meta: boolean; shift: boolean; alt: boolean; code: string }> = {},
    type = 'keyDown'
  ) => ({
    type,
    key: k,
    code: mods.code,
    control: mods.control ?? false,
    meta: mods.meta ?? false,
    shift: mods.shift ?? false,
    alt: mods.alt ?? false,
  })

  it('blocks Ctrl+R, F5 and Ctrl+Shift+I', () => {
    expect(isBlockedDevShortcut(key('r', { control: true }))).toBe(true)
    expect(isBlockedDevShortcut(key('R', { control: true }))).toBe(true)
    expect(isBlockedDevShortcut(key('F5'))).toBe(true)
    expect(isBlockedDevShortcut(key('i', { control: true, shift: true }))).toBe(true)
    expect(isBlockedDevShortcut(key('I', { control: true, shift: true }))).toBe(true)
  })

  it('blocks the other devtools routes: F12, Ctrl+Shift+J, Ctrl+Shift+C', () => {
    expect(isBlockedDevShortcut(key('F12'))).toBe(true)
    expect(isBlockedDevShortcut(key('j', { control: true, shift: true }))).toBe(true)
    expect(isBlockedDevShortcut(key('J', { control: true, shift: true }))).toBe(true)
    expect(isBlockedDevShortcut(key('c', { control: true, shift: true }))).toBe(true)
  })

  it('blocks the macOS Cmd equivalents', () => {
    expect(isBlockedDevShortcut(key('r', { meta: true }))).toBe(true)
    expect(isBlockedDevShortcut(key('i', { meta: true, shift: true }))).toBe(true)
    expect(isBlockedDevShortcut(key('j', { meta: true, shift: true }))).toBe(true)
  })

  it('blocks the macOS DevTools chords Cmd+Option+I / J / C by physical key', () => {
    // With Option held, macOS reports a composed character as `key` (e.g. "ˆ"
    // for I), so the physical `code` is what identifies the chord.
    expect(isBlockedDevShortcut(key('ˆ', { meta: true, alt: true, code: 'KeyI' }))).toBe(true)
    expect(isBlockedDevShortcut(key('∆', { meta: true, alt: true, code: 'KeyJ' }))).toBe(true)
    expect(isBlockedDevShortcut(key('ç', { meta: true, alt: true, code: 'KeyC' }))).toBe(true)
    expect(isBlockedDevShortcut(key('ˆ', { alt: true, code: 'KeyI' }))).toBe(false) // Option alone types text
  })

  it('does not block plain typing or other shortcuts', () => {
    expect(isBlockedDevShortcut(key('r'))).toBe(false)
    expect(isBlockedDevShortcut(key('i', { shift: true }))).toBe(false)
    expect(isBlockedDevShortcut(key('c', { control: true }))).toBe(false) // plain Ctrl+C copy stays
    expect(isBlockedDevShortcut(key('j', { control: true }))).toBe(false)
    expect(isBlockedDevShortcut(key('F4'))).toBe(false)
  })

  it('ignores keyUp events', () => {
    expect(isBlockedDevShortcut(key('r', { control: true }, 'keyUp'))).toBe(false)
    expect(isBlockedDevShortcut(key('F5', {}, 'keyUp'))).toBe(false)
  })
})
