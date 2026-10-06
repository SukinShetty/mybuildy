// capture-sources.ts — main process. The ONE way MyBuildy asks Electron for
// window images (desktopCapturer.getSources): one call at a time, each given
// 10 s at most (one-at-a-time.ts). Overlapping calls could leave one of them
// unanswered forever, which froze watching after a paste.

import { desktopCapturer, type DesktopCapturerSource, type SourcesOptions } from 'electron'
import { oneAtATime } from './one-at-a-time'

export const CAPTURE_TIMEOUT_MS = 10_000

export const getCaptureSources: (options: SourcesOptions) => Promise<DesktopCapturerSource[]> =
  oneAtATime((options: SourcesOptions) => desktopCapturer.getSources(options), CAPTURE_TIMEOUT_MS, 'Window capture')
