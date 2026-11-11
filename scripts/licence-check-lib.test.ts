import { describe, expect, it } from 'vitest'
import { classifyLicence, declaredLicence, gplSignaturesIn, KNOWN_GPL_INSIDE, reachable } from './licence-check-lib.mjs'

describe('classifyLicence', () => {
  it.each([
    ['MIT', 'ok'], ['Apache-2.0', 'ok'], ['(MIT OR CC0-1.0)', 'ok'], ['BlueOak-1.0.0', 'ok'],
    ['GPL-3.0', 'copyleft'], ['GPL-3.0-or-later', 'copyleft'], ['AGPL-3.0-only', 'copyleft'], ['LGPL-2.1', 'copyleft'],
    ['Apache-2.0 AND LGPL-3.0-or-later', 'copyleft'], ['MIT OR GPL-2.0', 'ok'], ['CC-BY-NC-4.0', 'noncommercial'],
    ['CC-BY-NC-SA-4.0', 'copyleft'], ['PolyForm-Noncommercial-1.0.0', 'noncommercial'], ['PolyForm-Shield-1.0.0', 'ok'],
    ['SEE LICENSE IN LICENSE.txt', 'unknown'], ['', 'unknown'], [null, 'unknown'],
  ])('%s → %s', (expr, verdict) => {
    expect(classifyLicence(expr as string)).toBe(verdict)
  })
})

it('reads old-style licence fields', () => {
  expect(declaredLicence({ license: 'MIT' })).toBe('MIT')
  expect(declaredLicence({ license: { type: 'ISC' } })).toBe('ISC')
  expect(declaredLicence({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0')
  expect(declaredLicence({})).toBeNull()
})

it('phonemizer is known to hide GPL code behind an Apache-2.0 licence field', () => {
  expect(KNOWN_GPL_INSIDE.phonemizer).toMatch(/eSpeak NG/)
})

it('finds eSpeak NG in a bundle, not in ordinary words', () => {
  expect(gplSignaturesIn('var x="espeak-ng-data/phontab"')).toHaveLength(2)
  expect(gplSignaturesIn('Module._espeak_Initialize(')).toHaveLength(1)
  expect(gplSignaturesIn('WeSpeakerResNetModel; "bespeak": "bəspˈik"')).toEqual([])
})

describe('reachable', () => {
  const lock = {
    'node_modules/a': { dependencies: { b: '1', stubbed: '1' } },
    'node_modules/b': { optionalDependencies: { c: '1' } },
    'node_modules/b/node_modules/c': {},
    'node_modules/c': {},
    'node_modules/stubbed': { dependencies: { gpl: '1' } },
    'node_modules/gpl': {},
  }
  it('follows dependencies like Node, nested first, and skips stubbed packages', () => {
    expect([...reachable(lock, ['a'], new Set(['stubbed']))].sort()).toEqual(['node_modules/a', 'node_modules/b', 'node_modules/b/node_modules/c'])
  })
})
