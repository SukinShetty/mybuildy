import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseAnalysisResponse,
  tryExtractProjectData,
  containsHumanDirectedQuestion,
  toAgentName,
} from './response-parser'

// A representative model output for a routine coding step — MyBuildy can default it,
// so needsHumanJudgment must be false.
const ROUTINE_STEP = JSON.stringify({
  screenContentVisible: true,
  whatIsHappening: 'The login page renders and the form is wired up.',
  whatItMeans: 'Auth is basically working.',
  whatIsBuilt: ['login form'],
  whatIsMissing: ['dashboard'],
  whatIsBroken: [],
  whereUserIsStuck: null,
  bestNextMove: 'Build the dashboard route next.',
  nextPrompt: 'Create a /dashboard route that lists customers in a table.',
  expectedOutcome: 'A /dashboard page renders a table of customers.',
  builderNote: 'Nice progress!',
  isCriticalOverride: false,
  needsHumanJudgment: false,
  humanJudgmentReason: '',
})

// A representative model output for an irreversible/destructive decision — this is
// a genuine human-judgment moment, so needsHumanJudgment must be true.
const DELETE_PROD_DB = JSON.stringify({
  screenContentVisible: true,
  whatIsHappening: 'A migration script is about to DROP the production users table.',
  whatItMeans: 'This would permanently delete all real user accounts.',
  whatIsBuilt: [],
  whatIsMissing: [],
  whatIsBroken: [],
  whereUserIsStuck: null,
  bestNextMove: 'Stop and decide whether deleting the production database is intended.',
  nextPrompt: '',
  expectedOutcome: '',
  builderNote: 'Big one — worth a pause.',
  isCriticalOverride: true,
  needsHumanJudgment: true,
  humanJudgmentReason: 'Dropping the production users table is irreversible and deletes real user data.',
})

describe('parseAnalysisResponse — hand-off detection (Block 6)', () => {
  it('does NOT flag a routine coding choice for human judgment', () => {
    const r = parseAnalysisResponse(ROUTINE_STEP, Date.now())
    expect(r.needsHumanJudgment).toBe(false)
    expect(r.humanJudgmentReason).toBe('')
  })

  it('flags an irreversible "delete production database" step for human judgment', () => {
    const r = parseAnalysisResponse(DELETE_PROD_DB, Date.now())
    expect(r.needsHumanJudgment).toBe(true)
    expect(r.humanJudgmentReason).toMatch(/production|irreversible|delete/i)
  })

  it('defaults needsHumanJudgment to false when the field is absent', () => {
    const r = parseAnalysisResponse('{"whatIsHappening":"typing code","nextPrompt":"x"}', Date.now())
    expect(r.needsHumanJudgment).toBe(false)
  })
})

describe('parseAnalysisResponse — expected outcome (Block 4)', () => {
  it('parses expectedOutcome alongside nextPrompt', () => {
    const r = parseAnalysisResponse(ROUTINE_STEP, Date.now())
    expect(r.nextPrompt).toContain('/dashboard')
    expect(r.expectedOutcome).toContain('table of customers')
  })
})

// ─── Phase 3B — human-question backstop ───────────────────────────────────────
// Questions meant for the human must NEVER reach the paste-prompt. The parser is
// the backstop for ALL providers: a flagged nextPrompt becomes a hand-off
// (needsHumanJudgment) with an EMPTY prompt.

/** Model output with everything routine except the given nextPrompt. */
function analysisJsonWith(nextPrompt: string): string {
  return JSON.stringify({
    screenContentVisible: true,
    whatIsHappening: 'The editor shows the form component.',
    whatItMeans: 'The form is mid-build.',
    whatIsBuilt: ['form layout'],
    whatIsMissing: ['save button'],
    whatIsBroken: [],
    whereUserIsStuck: null,
    bestNextMove: 'Wire up saving next.',
    nextPrompt,
    expectedOutcome: 'The form has a working save button.',
    builderNote: 'Keep going!',
    isCriticalOverride: false,
    needsHumanJudgment: false,
    humanJudgmentReason: '',
  })
}

const NORMAL_BUILD_PROMPT =
  'Add a save button to the form component and wire it to the existing submit handler'

describe('parseAnalysisResponse — human-question backstop (Phase 3B)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('converts a clarification question into a hand-off with an EMPTY prompt', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const raw = analysisJsonWith(
      'Before proceeding: I need to check something. Please clarify: Are you building X or Y?'
    )
    const r = parseAnalysisResponse(raw, Date.now())
    expect(r.nextPrompt).toBe('')
    expect(r.expectedOutcome).toBe('')
    expect(r.needsHumanJudgment).toBe(true)
    expect(r.humanJudgmentReason).toBeTruthy()
    expect(logSpy).toHaveBeenCalledWith('[Prompt] routed human question to hand-off')
  })

  it('passes a normal build prompt through unchanged', () => {
    const r = parseAnalysisResponse(analysisJsonWith(NORMAL_BUILD_PROMPT), Date.now())
    expect(r.nextPrompt).toBe(NORMAL_BUILD_PROMPT)
    expect(r.needsHumanJudgment).toBe(false)
    expect(r.expectedOutcome).toBe('The form has a working save button.')
  })
})

describe('containsHumanDirectedQuestion — detection heuristic', () => {
  it.each([
    ['please clarify', 'Please clarify which page should load first.'],
    ['are you building', 'Are you building a checklist or a planner'],
    ['confirm whether', 'First confirm whether the login page should come before the list page.'],
    ['do you want', 'Do you want the table sorted by date or by name'],
  ])('flags the trigger phrase "%s" (case-insensitive)', (_phrase, prompt) => {
    expect(containsHumanDirectedQuestion(prompt)).toBe(true)
    expect(containsHumanDirectedQuestion(prompt.toUpperCase())).toBe(true)
  })

  it('flags a question sentence addressed to "you" (the "you…?" heuristic)', () => {
    expect(
      containsHumanDirectedQuestion('Should the export run before you review the data?')
    ).toBe(true)
    expect(
      containsHumanDirectedQuestion('Which layout would suit your workflow best?')
    ).toBe(true)
  })

  it('does NOT flag a non-question sentence that mentions "you"/"your"', () => {
    expect(containsHumanDirectedQuestion('The form validates your input server-side.')).toBe(false)
    expect(
      containsHumanDirectedQuestion(
        'Add a save button to the form component and wire it to the existing submit handler'
      )
    ).toBe(false)
  })

  it('does NOT flag an empty prompt', () => {
    expect(containsHumanDirectedQuestion('')).toBe(false)
  })
})

// ─── Phase 5 Task B — agent-neutral analysis (agentName) ──────────────────────

describe('toAgentName — normalization', () => {
  it('keeps the three valid values', () => {
    expect(toAgentName('claude_code')).toBe('claude_code')
    expect(toAgentName('codex')).toBe('codex')
    expect(toAgentName('other')).toBe('other')
  })

  it('tolerates case, spacing, and hyphen variants', () => {
    expect(toAgentName('Claude Code')).toBe('claude_code')
    expect(toAgentName('CLAUDE-CODE')).toBe('claude_code')
    expect(toAgentName(' claude ')).toBe('claude_code')
    expect(toAgentName('Codex CLI')).toBe('codex')
    expect(toAgentName('codex-cli')).toBe('codex')
  })

  it('defaults to "other" when missing', () => {
    expect(toAgentName(undefined)).toBe('other')
    expect(toAgentName(null)).toBe('other')
    expect(toAgentName('')).toBe('other')
  })

  it('defaults to "other" for garbage values', () => {
    expect(toAgentName('gpt-magic')).toBe('other')
    expect(toAgentName(42)).toBe('other')
    expect(toAgentName({ agent: 'claude_code' })).toBe('other')
    expect(toAgentName(true)).toBe('other')
  })
})

describe('parseAnalysisResponse — agentName field', () => {
  it('carries a valid agentName through the parse', () => {
    const raw = JSON.stringify({ whatIsHappening: 'Codex CLI awaiting input', nextPrompt: 'x', agentName: 'codex' })
    expect(parseAnalysisResponse(raw, Date.now()).agentName).toBe('codex')
  })

  it('defaults agentName to "other" when the model omits it', () => {
    const r = parseAnalysisResponse(ROUTINE_STEP, Date.now())
    expect(r.agentName).toBe('other')
  })

  it('defaults agentName to "other" for an unrecognized value', () => {
    const raw = JSON.stringify({ whatIsHappening: 'x', nextPrompt: 'x', agentName: 'copilot-ultra' })
    expect(parseAnalysisResponse(raw, Date.now()).agentName).toBe('other')
  })
})

describe('tryExtractProjectData — brainstorm firstPrompt (Part 3)', () => {
  it('extracts a non-empty firstPrompt once the product is defined', () => {
    const full = `Great, I think I understand your idea!

---MYBUILDY_PROJECT_SUMMARY---
PROJECT_NAME: FreelanceCRM
PRODUCT_SUMMARY: A simple CRM for freelancers to track customers.
TARGET_USER: Solo freelancers.
CORE_PROBLEM: Freelancers lose track of client conversations.
MVP_FOCUS: A customer list page.
FIRST_PROMPT: Set up a new Next.js + Tailwind app called FreelanceCRM and build a /customers page that lists customers in a table with an Add customer button.
---END_MYBUILDY_PROJECT_SUMMARY---`

    const data = tryExtractProjectData(full)
    expect(data).not.toBeNull()
    expect(data!.projectName).toBe('FreelanceCRM')
    expect(data!.firstPrompt.length).toBeGreaterThan(0)
    expect(data!.firstPrompt).toMatch(/Next\.js/)
    expect(data!.firstPrompt).not.toContain('END_MYBUILDY_PROJECT_SUMMARY')
  })

  it('returns null when no summary block is present (product not yet defined)', () => {
    expect(tryExtractProjectData('Tell me more about who this is for?')).toBeNull()
  })
})

describe('containsHumanDirectedQuestion — polite instructions to the agent stay prompts', () => {
  it.each([
    'Could you add a photo upload button to the recipe form?',
    'Can you fix the failing login test and run the suite again?',
    'Please could you rename the Save button to Save recipe?',
    'Would you add input validation to the signup form?',
  ])('does not flag %s', (prompt) => {
    expect(containsHumanDirectedQuestion(prompt)).toBe(false)
  })

  it.each([
    'Could you tell me which page should load first?',
    'Would you prefer photos or sharing next?',
    'Can you confirm the database name?',
    'Could you check your API key settings?',
  ])('still flags a question for the human: %s', (prompt) => {
    expect(containsHumanDirectedQuestion(prompt)).toBe(true)
  })
})

