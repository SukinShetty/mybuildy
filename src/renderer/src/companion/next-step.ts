// next-step.ts — pure: the line under the robot always says what to do next,
// in plain words, from the real current state — never a step already done.
// Unit-tested in next-step.test.ts.

import type { AnalysisResult } from '../types'

export interface NextStepInput {
  needsSetup: boolean
  pastedJustNow: boolean
  watchedSourceMessage: string | null   // main's message (why watching stopped or can't start)
  watchedWindowName: string | null
  isPaused: boolean                      // Auto off: a window is chosen, not watched continuously
  thinking: boolean                      // an analysis (from here or the Guidance tab) or a question is running
  promptAlreadyPasted: boolean           // the analysis's prompt was pasted: that step is done
  analysis: AnalysisResult | null
}

function agentLabel(analysis: AnalysisResult | null): string {
  switch (analysis?.agentName) {
    case 'claude_code': return 'Claude Code'
    case 'codex': return 'Codex'
    default: return 'your coding agent'
  }
}

const capitalized = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export function nextStepLabel(i: NextStepInput): string {
  if (i.pastedJustNow) return 'Pasted — now press Enter in your terminal'
  if (i.needsSetup) return 'Next: finish setting me up — click the gear'
  if (i.watchedWindowName && i.thinking) return 'Thinking about what just happened…'
  if (i.watchedSourceMessage) return i.watchedSourceMessage
  if (!i.watchedWindowName) return "Next: show me your coding agent's window"

  const a = i.analysis
  const agent = agentLabel(a)
  const promptReady = !!a?.nextPrompt?.trim() && !i.promptAlreadyPasted
  if (i.isPaused) {
    // Auto off: what the last look found still stands if it's something to do now.
    if (a?.needsHumanJudgment) return 'Next: answer the question in the panel'
    if (promptReady) return 'Your prompt is ready — click Paste into terminal'
    return 'Paused — click Resume to keep watching'
  }
  if (!a) return `Watching ${agent} — first look coming up`
  if (a.terminalState === 'permission_prompt') return `${capitalized(agent)} is asking you something — answer it in the terminal`
  if (a.terminalState === 'working' || i.promptAlreadyPasted) return `Waiting for ${agent} to finish`
  if (a.needsHumanJudgment) return 'Next: answer the question in the panel'
  if (promptReady) return 'Your prompt is ready — click Paste into terminal'
  return `Watching ${agent} — I'll tell you the next step`
}
