// update-notice.ts — what the robot's update notice says, for each phase.
// Pure, so the wording and buttons are unit-tested (update-notice.test.ts).

import type { UpdateNotice } from '../types'

export interface UpdateNoticeView {
  title: string
  notes: string
  /** The main button, or null while downloading. */
  primary: { label: string; action: 'download' | 'install' } | null
  status: string | null
}

export function updateNoticeView(notice: UpdateNotice): UpdateNoticeView {
  switch (notice.phase) {
    case 'available':
      return { title: `New update available: MyBuildy ${notice.version}`, notes: notice.notes, primary: { label: 'Update', action: 'download' }, status: null }
    case 'downloading':
      return { title: `Downloading MyBuildy ${notice.version}…`, notes: notice.notes, primary: null, status: `${Math.max(0, Math.min(100, notice.percent))}%` }
    case 'ready':
      return { title: `MyBuildy ${notice.version} is ready`, notes: notice.notes, primary: { label: 'Restart to update', action: 'install' }, status: 'MyBuildy will close and reopen.' }
  }
}
