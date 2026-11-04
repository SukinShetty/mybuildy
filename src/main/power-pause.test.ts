import { describe, it, expect } from 'vitest'
import { PowerPause, type PowerEvents } from './power-pause'

function fakePower() {
  const handlers: Record<string, () => void> = {}
  const events: PowerEvents = { on: (e, fn) => { handlers[e] = fn } }
  return { events, fire: (e: string) => handlers[e]() }
}

describe('wake word pause on sleep / lock', () => {
  it('resume from sleep onto a locked screen stays paused until unlocked (regression)', () => {
    const sent: boolean[] = []
    const p = fakePower()
    new PowerPause((v) => sent.push(v)).attach(p.events)
    p.fire('lock-screen'); p.fire('suspend'); p.fire('resume')
    expect(sent.at(-1)).toBe(true)
    p.fire('unlock-screen')
    expect(sent.at(-1)).toBe(false)
  })

  it('unlock while still asleep (some systems order events oddly) stays paused until awake', () => {
    const sent: boolean[] = []
    const p = fakePower()
    new PowerPause((v) => sent.push(v)).attach(p.events)
    p.fire('suspend'); p.fire('lock-screen'); p.fire('unlock-screen')
    expect(sent.at(-1)).toBe(true)
    p.fire('resume')
    expect(sent).toEqual([true, false])
  })

  it('starting on a locked screen is paused', () => {
    const sent: boolean[] = []
    new PowerPause((v) => sent.push(v), true).attach(fakePower().events)
    expect(sent).toEqual([true])
  })
})
