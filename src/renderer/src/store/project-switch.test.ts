// A normal project switch must not carry the brainstorm conversation, its
// extracted project data, or the last analysis into the next project.
import { describe, it, expect } from 'vitest'
import { useAppStore } from './useAppStore'

describe('project switch resets per-project renderer state', () => {
  it('clears brainstorm history, extracted data and the cached analysis', () => {
    const s = useAppStore.getState()
    s.addBrainstormUserMessage('Plan a recipe box for project A')
    s.appendBrainstormStreamChunk('Sure — for project A you could…')
    s.finalizeBrainstormAssistantMessage('Sure — for project A you could…', {
      projectName: 'Recipe box', productSummary: 'Project A summary', targetUser: '', coreProblem: '', firstPrompt: '',
    } as never)
    s.setLatestAnalysis({ whatIsHappening: 'project A terminal' } as never)
    expect(useAppStore.getState().brainstormMessages.length).toBeGreaterThan(0)

    useAppStore.getState().resetForProjectSwitch()

    const after = useAppStore.getState()
    expect(after.brainstormMessages).toEqual([])
    expect(after.brainstormStreamingBuffer).toBe('')
    expect(after.brainstormPhase).toBe('idle')
    expect(after.brainstormErrorMessage).toBeNull()
    expect(after.lastExtractedProjectData).toBeNull()
    expect(after.latestAnalysis).toBeNull()
  })

  it('the Guidance tab follows the one watch: nothing watched any more clears its analysis', () => {
    const s = useAppStore.getState()
    s.applyWatchStatus({ windowName: 'Windows PowerShell', auto: true, analyzing: false, message: null })
    s.setLatestAnalysis({ whatIsHappening: 'agent idle' } as never)
    useAppStore.getState().applyWatchStatus({ windowName: 'Windows PowerShell', auto: false, analyzing: true, message: null })
    expect(useAppStore.getState().latestAnalysis).not.toBeNull() // paused / analysing: the result stays

    useAppStore.getState().applyWatchStatus({ windowName: null, auto: false, analyzing: false, message: null })
    const after = useAppStore.getState()
    expect(after.watchStatus.windowName).toBeNull()
    expect(after.latestAnalysis).toBeNull()
  })
})
