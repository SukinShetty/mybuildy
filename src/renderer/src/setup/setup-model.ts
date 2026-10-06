// setup-model.ts — pure data and rules for the first-run setup wizard
// (SetupWizard.tsx). No React, no window.* — unit-tested in setup-model.test.ts.

export type SetupStepId =
  | 'welcome'
  | 'key'
  | 'model'
  | 'screen'  // macOS only
  | 'paste'   // macOS only
  | 'goal'
  | 'agent'
  | 'window'
  | 'done'

const MAC_ONLY: ReadonlySet<SetupStepId> = new Set(['screen', 'paste'])

const ALL_STEPS: SetupStepId[] = ['welcome', 'key', 'model', 'screen', 'paste', 'goal', 'agent', 'window', 'done']

/** The wizard's steps for a platform: the macOS permission steps appear only on a Mac. */
export function setupSteps(platform: string): SetupStepId[] {
  return ALL_STEPS.filter((s) => platform === 'darwin' || !MAC_ONLY.has(s))
}

/** "Step 2 of 7". */
export function progressLabel(steps: SetupStepId[], step: SetupStepId): string {
  return `Step ${steps.indexOf(step) + 1} of ${steps.length}`
}

/** Where to start: the saved step if it exists on this platform, otherwise the beginning. */
export function resumeStep(steps: SetupStepId[], saved: string | null): SetupStepId {
  return steps.includes(saved as SetupStepId) ? (saved as SetupStepId) : steps[0]
}

export function nextStep(steps: SetupStepId[], step: SetupStepId): SetupStepId {
  return steps[Math.min(steps.indexOf(step) + 1, steps.length - 1)]
}

export function previousStep(steps: SetupStepId[], step: SetupStepId): SetupStepId {
  return steps[Math.max(steps.indexOf(step) - 1, 0)]
}

// ─── Your AI key ─────────────────────────────────────────────────────────────

export interface KeyProvider {
  id: 'anthropic' | 'openai' | 'gemini' | 'openrouter'
  label: string
  blurb: string
  keyUrl: string       // "Where do I get a key?"
  placeholder: string
  notYetTested?: boolean
}

// Recommended: tested end to end against the real APIs (npm run test:live).
export const KEY_PROVIDERS: KeyProvider[] = [
  { id: 'anthropic', label: 'Anthropic', blurb: 'Makers of Claude', keyUrl: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', blurb: 'Makers of ChatGPT', keyUrl: 'https://platform.openai.com/api-keys', placeholder: 'sk-…' },
  { id: 'openrouter', label: 'OpenRouter', blurb: 'One key, many AI models', keyUrl: 'https://openrouter.ai/keys', placeholder: 'sk-or-…' },
]

// Advanced: works in code but not yet tested live, and labelled so.
export const ADVANCED_KEY_PROVIDERS: KeyProvider[] = [
  { id: 'gemini', label: 'Google Gemini', blurb: 'Google’s AI', keyUrl: 'https://aistudio.google.com/app/apikey', placeholder: 'AIza…', notYetTested: true },
]

export const NOT_YET_TESTED_LABEL = 'Not yet tested'

// ─── What do you want to build? ──────────────────────────────────────────────

export interface ReadyGoal {
  id: string
  title: string
  purpose: string     // becomes Goal.purpose
  doneWhen: string    // becomes Goal.successCriteria ("Done when …")
}

export const READY_GOALS: ReadyGoal[] = [
  {
    id: 'habits',
    title: 'A personal habit tracker web page',
    purpose: 'A web page where I list a few daily habits and tick them off each day.',
    doneWhen: 'I can add a habit, tick it off for today, and it is still ticked after I reload the page.',
  },
  {
    id: 'portfolio',
    title: 'A simple portfolio page about me',
    purpose: 'A one-page website that introduces me, with a short bio, a few projects and a way to contact me.',
    doneWhen: 'the page opens in my browser and shows my name, my bio, three projects and my email address.',
  },
  {
    id: 'todo',
    title: 'A to-do list that remembers my tasks',
    purpose: 'A to-do list web page where I can add tasks, mark them done and delete them.',
    doneWhen: 'I can add three tasks, mark one done, close the browser, and all three are still there when I open it again.',
  },
  {
    id: 'expenses',
    title: 'A small expense tracker',
    purpose: 'A web page where I record what I spend, with an amount and a category, and see a total.',
    doneWhen: 'I can add three expenses and the total at the bottom equals their sum.',
  },
]

export const OWN_GOAL_EXAMPLE = {
  purpose: 'A recipe box where I save my favourite recipes and search them by ingredient.',
  doneWhen: 'I can save a recipe, search for one of its ingredients, and the recipe shows up.',
}

/** "Done when …" for display, whatever the stored text starts with. */
export function doneWhenText(check: string): string {
  return `Done when ${check.trim().replace(/^done when[:\s]*/i, '')}`
}

// ─── Open your coding agent ──────────────────────────────────────────────────

export interface AgentInstructions {
  terminal: string          // the app to open
  howToOpen: string
  commands: { label: string; command: string }[]
}

export function agentInstructions(platform: string): AgentInstructions {
  if (platform === 'darwin') {
    return {
      terminal: 'Terminal',
      howToOpen: 'Press Cmd + Space, type Terminal, then press Enter.',
      commands: [
        { label: 'Make a folder for your project and go into it', command: 'mkdir my-project && cd my-project' },
        { label: 'Start Claude Code', command: 'claude' },
      ],
    }
  }
  return {
    terminal: 'PowerShell',
    howToOpen: 'Press the Windows key, type PowerShell, then press Enter.',
    commands: [
      { label: 'Make a folder for your project and go into it', command: 'mkdir my-project; cd my-project' },
      { label: 'Start Claude Code', command: 'claude' },
    ],
  }
}

export const CLAUDE_CODE_INSTALL_URL = 'https://docs.anthropic.com/en/docs/claude-code/setup'
