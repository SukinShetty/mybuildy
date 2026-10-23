// The microphone is opened only when the user chooses: a click on the mic
// button, or while they have turned on the "MyBuildy" wake word (off by
// default). Never during setup, and there is exactly one place that opens it.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { defaultNonSecretSettings } from '../types'

const rendererDir = join(__dirname, '..')
const renderer = (...p: string[]): string => readFileSync(join(rendererDir, ...p), 'utf8')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

describe('microphone permission', () => {
  it('setup never touches the microphone, and never turns the wake word on', () => {
    const wizard = renderer('setup', 'SetupWizard.tsx') + renderer('setup', 'setup-model.ts')
    expect(wizard).not.toMatch(/getUserMedia|mediaDevices|askForMediaAccess|openMicrophone|WakeListener|setWakeWord/)
    expect(wizard).not.toMatch(/wakeWordEnabled:\s*true/)
    const main = readFileSync(join(rendererDir, '..', '..', 'main', 'setup-permissions.ts'), 'utf8')
    expect(main).not.toMatch(/askForMediaAccess|getUserMedia/)
  })

  it('the wake word is off for a new user', () => {
    expect(defaultNonSecretSettings().wakeWordEnabled).toBe(false)
  })

  it('exactly one place in the app opens the microphone: openMicrophone in voice-mic.ts', () => {
    const callers = sourceFiles(rendererDir).filter((f) => /getUserMedia\(/.test(readFileSync(f, 'utf8')))
    expect(callers.map((f) => f.slice(rendererDir.length + 1).replace(/\\/g, '/'))).toEqual(['companion/voice-mic.ts'])
    const mic = renderer('companion', 'voice-mic.ts')
    expect([...mic.matchAll(/getUserMedia\(/g)]).toHaveLength(1)
    const start = mic.indexOf('export async function openMicrophone')
    expect(mic.indexOf('getUserMedia(')).toBeGreaterThan(start)
  })

  it('the robot opens it only from the mic button and the wake-word listener', () => {
    const src = renderer('companion', 'CompanionApp.tsx')
    const calls = [...src.matchAll(/openMicrophone\(\)/g)].map((m) => m.index!)
    expect(calls).toHaveLength(2)
    const rec = [src.indexOf('const startRecording'), src.indexOf('const discardRecording')]
    const wake = [src.indexOf('new WakeListener({'), src.indexOf('const runVoiceCommandRef')]
    const inside = (i: number, [a, b]: number[]): boolean => i > a && i < b
    expect(calls.filter((i) => inside(i, rec))).toHaveLength(1)
    expect(calls.filter((i) => inside(i, wake))).toHaveLength(1)
    // The listener is started only through the gate (shouldListenForWakeWord), never directly.
    expect([...src.matchAll(/listener\.start\(\)/g)].length).toBe(1)
    expect(src).not.toMatch(/wakeRef\.current\??\.start\(/)
    expect(src).toMatch(/if \(shouldListen\) void listener\.start\(\)/)
  })
})
