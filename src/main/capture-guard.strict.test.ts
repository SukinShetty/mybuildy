import { describe, expect, it } from 'vitest'
import { pollStrictContinuity, startContinuity } from './capture-guard'

describe('strict launch continuity policy', () => {
  it('ends immediately on a gap and never resumes even with the same id, title and owner', () => {
    const watch = startContinuity('window:42:0', 'Terminal', 100)
    expect(pollStrictContinuity(watch, [], 1000)).toEqual({ kind: 'lost', reason: 'continuity-gap' })
    expect(pollStrictContinuity(watch, [{ id: 'window:42:0', name: 'Terminal' }], 1001)).toEqual({ kind: 'none' })
    expect(watch.state).toBe('lost')
  })
  it('allows a title change while the id stays continuously present', () => {
    const watch = startContinuity('window:42:0', 'Terminal', 100)
    expect(pollStrictContinuity(watch, [{ id: 'window:42:0', name: 'Working' }], 1000)).toEqual({ kind: 'title-changed', from: 'Terminal', to: 'Working' })
    expect(watch.state).toBe('watching')
  })
})
