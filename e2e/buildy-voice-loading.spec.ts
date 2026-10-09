// buildy-voice-loading.spec.ts — what happens when Buildy needs to speak while
// his voice is still loading (a cold Mac took 7.7 s, an Intel app under
// Rosetta 18.6 s). DEV BUILD ONLY: the slow / hung load is simulated
// (MYBUILDY_E2E_KOKORO_LOAD, e2e dev runs only) and the time limit shortened.
//   - slow load: the line waits, the robot shows he's getting ready to speak
//     ("waiting", not idle), then Buildy's voice says it
//   - hung load: when the time limit passes, the line is spoken in the
//     computer's voice, with the notice and the reason

import { test, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { launchMyBuildy, IS_PACKAGED_RUN, type MyBuildyApp } from './helpers'

test.skip(IS_PACKAGED_RUN, 'Simulating a slow load uses dev-build test switches')
test.setTimeout(180_000)

const LINE = 'Claude Code just finished building your invoice page.'

async function open(env: Record<string, string>): Promise<{ m: MyBuildyApp; log: () => string }> {
  const m = await launchMyBuildy({ env: { MYBUILDY_E2E_KOKORO: '1', ...env } })
  const file = path.join(await m.app.evaluate(({ app }) => app.getPath('userData')), 'logs', 'watch.log')
  return { m, log: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') }
}
const speak = (m: MyBuildyApp, text: string) =>
  m.app.evaluate((_e, t) => (globalThis as unknown as Record<string, { speak(x: string): void }>)['__mybuildyE2E'].speak(t), text)

test('slow load: he waits, shows he is getting ready to speak, then Buildy’s voice says the line', async () => {
  const { m, log } = await open({ MYBUILDY_E2E_KOKORO_LOAD: 'slow:6000' })
  try {
    await speak(m, LINE)
    await expect(m.companion.getByTestId('mascot')).toHaveAttribute('data-animation', 'waiting', { timeout: 5_000 })
    expect(log()).not.toMatch(/voice-line/) // nothing spoken yet: the line is held
    await expect.poll(log, { timeout: 60_000 }).toMatch(/voice-line engine=kokoro voice=bella/)
    await expect(m.companion.getByTestId('mascot')).not.toHaveAttribute('data-animation', 'waiting')
    await expect(m.companion.getByTestId('voice-fallback')).toHaveCount(0) // a slow load is not a failure
  } finally {
    await m.close()
  }
})

test('hung load: when the time limit passes, the computer’s voice says the line — with the notice and the reason', async () => {
  const { m, log } = await open({ MYBUILDY_E2E_KOKORO_LOAD: 'hang', MYBUILDY_E2E_KOKORO_LOAD_TIMEOUT_MS: '4000' })
  try {
    await speak(m, LINE)
    await expect(m.companion.getByTestId('mascot')).toHaveAttribute('data-animation', 'waiting', { timeout: 3_000 })
    const notice = m.companion.getByTestId('voice-fallback')
    await expect(notice).toContainText("Buildy's voice couldn't start, so MyBuildy is using your computer's voice", { timeout: 15_000 })
    await expect(notice).toContainText("Buildy's voice is taking too long to start on this computer.")
    await expect.poll(log, { timeout: 15_000 }).toMatch(/voice-line engine=system/)
    expect(log()).toMatch(/voice-engine kokoro=slow limitMs=4000/)
    expect(log()).toMatch(/voice-fallback reason=kokoro-slow speaking=system/)
  } finally {
    await m.close()
  }
})
