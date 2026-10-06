// one-at-a-time.ts — ELECTRON-FREE, unit-tested. Runs calls to `fn` strictly
// one after another, each with a time limit.
//
// Why: Electron's window capture (desktopCapturer.getSources) was asked for
// window images by several timers at once — the 2 s window check, the 5 s
// "has the agent finished?" check after a paste, and the analysis itself — and
// one of those calls could never return. The analysis waiting on it then stayed
// "in flight" for good, so watching, Analyze Now and the post-paste look all
// stopped. capture-sources.ts sends every capture through this.

export class TimedOutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not answer within ${Math.round(ms / 1000)} s`)
    this.name = 'TimedOutError'
  }
}

export function oneAtATime<A, R>(fn: (arg: A) => Promise<R>, timeoutMs: number, label: string): (arg: A) => Promise<R> {
  let previous: Promise<unknown> = Promise.resolve()
  return (arg: A) => {
    const run = previous.then(() => new Promise<R>((resolve, reject) => {
      // A call that never answers is abandoned after the limit; the next one goes ahead.
      const timer = setTimeout(() => reject(new TimedOutError(label, timeoutMs)), timeoutMs)
      fn(arg).then(
        (value) => { clearTimeout(timer); resolve(value) },
        (error) => { clearTimeout(timer); reject(error) },
      )
    }))
    previous = run.catch(() => undefined)
    return run
  }
}
