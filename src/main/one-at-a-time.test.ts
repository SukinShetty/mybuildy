import { describe, it, expect, vi, afterEach } from 'vitest'
import { oneAtATime, TimedOutError } from './one-at-a-time'

afterEach(() => { vi.useRealTimers() })

describe('window capture: one call at a time, never stuck', () => {
  it('runs calls strictly one after another, in order', async () => {
    let running = 0
    let most = 0
    const order: number[] = []
    const call = oneAtATime(async (n: number) => {
      running++; most = Math.max(most, running)
      await new Promise((r) => setTimeout(r, 5))
      order.push(n); running--
      return n * 2
    }, 1000, 'capture')
    expect(await Promise.all([call(1), call(2), call(3)])).toEqual([2, 4, 6])
    expect(most).toBe(1)
    expect(order).toEqual([1, 2, 3])
  })

  it('a call that never answers gives up at the limit, and the next call still runs', async () => {
    vi.useFakeTimers()
    const call = oneAtATime((n: number) => (n === 1 ? new Promise<number>(() => {}) : Promise.resolve(n)), 10_000, 'Window capture')
    const stuck = call(1)
    const next = call(2)
    const stuckResult = stuck.catch((e) => e)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await stuckResult).toBeInstanceOf(TimedOutError)
    expect(String(await stuckResult)).toMatch(/Window capture did not answer within 10 s/)
    expect(await next).toBe(2)
  })

  it('a failing call does not block the ones after it', async () => {
    const call = oneAtATime(async (n: number) => { if (n === 1) throw new Error('boom'); return n }, 1000, 'capture')
    await expect(call(1)).rejects.toThrow('boom')
    expect(await call(2)).toBe(2)
  })
})
