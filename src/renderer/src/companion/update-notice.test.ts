import { describe, it, expect } from 'vitest'
import { updateNoticeView } from './update-notice'

describe('the robot\'s update notice', () => {
  it('available: "New update available", the notes, and an Update button', () => {
    const v = updateNoticeView({ phase: 'available', version: '0.1.1', notes: 'Fixes' })
    expect(v.title).toBe('New update available: MyBuildy 0.1.1')
    expect(v.notes).toBe('Fixes')
    expect(v.primary).toEqual({ label: 'Update', action: 'download' })
  })
  it('downloading: progress, no button that could install', () => {
    const v = updateNoticeView({ phase: 'downloading', version: '0.1.1', notes: '', percent: 140 })
    expect(v.primary).toBeNull()
    expect(v.status).toBe('100%')
  })
  it('downloaded: Restart to update installs', () => {
    expect(updateNoticeView({ phase: 'ready', version: '0.1.1', notes: '' }).primary).toEqual({ label: 'Restart to update', action: 'install' })
  })
})
