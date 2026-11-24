import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WakeWordSetting } from './wake-word-setting'
import {
  WAKE_WORD_AVAILABLE,
  WAKE_WORD_COMING_SOON_HINT,
} from '../types'
import { shouldListenForWakeWord } from '../companion/wake-listener'

const gate = {
  watching: true,
  captureNoticeAccepted: true,
  robotVisible: true,
  listenModel: 'ready' as const,
  micButtonRecording: false,
  wakeWordEnabled: true,
}

function render(props: { available?: boolean; savedEnabled: boolean; listenModel?: 'missing' | 'ready' }): string {
  return renderToStaticMarkup(createElement(WakeWordSetting, {
    available: props.available,
    savedEnabled: props.savedEnabled,
    listenModel: props.listenModel ?? 'ready',
    onChange: () => {},
  }))
}

describe('wake word Coming soon (launch hold)', () => {
  it('with the flag off, a stored wakeWordEnabled=true never starts listening and the checkbox renders disabled with Coming soon', () => {
    expect(WAKE_WORD_AVAILABLE).toBe(false)
    expect(shouldListenForWakeWord(gate)).toBe(false)

    const html = render({ savedEnabled: true })
    expect(html).toContain('disabled')
    expect(html).toContain('Coming soon')
    expect(html).toContain('Wake word: say &quot;Hey Buildy&quot;')
    expect(html).toContain(WAKE_WORD_COMING_SOON_HINT)
    expect(html).not.toContain('checked')
    expect(html).toContain('data-testid="wake-word-toggle"')
  })

  it('Settings uses WakeWordSetting, which defaults to the shipped flag', () => {
    const settings = readFileSync(join(__dirname, 'SettingsScreen.tsx'), 'utf8')
    expect(settings).toContain('<WakeWordSetting')
    expect(settings).toContain('savedEnabled={settings.wakeWordEnabled === true}')
    const html = render({ savedEnabled: true })
    expect(html).toContain('Coming soon')
  })

  it('when the flag is flipped on, the checkbox can be turned on again', () => {
    const html = render({ available: true, savedEnabled: true })
    expect(html).toContain('checked')
    expect(html).not.toContain('Coming soon')
    expect(html).toContain('Wake word (experimental): say &quot;Hey Buildy&quot;')
  })
})
