import { MODEL_LIST_ERROR_KINDS, type ModelListDiagnostic } from '../types'

// Accept only known, sanitized main-process messages. Never expose arbitrary IPC errors.
export function modelListFailureMessage(message: string): string {
  const actionable = [
    'Your API key was rejected. Check it in Settings, or paste a new one.',
    "Your provider account has no credits left. Add credits on your provider's billing page, then try again.",
    'Your provider asked MyBuildy to slow down. Wait a minute and try again.',
    "Can't reach your AI provider. Check your internet connection and try again.",
    'Your AI provider took too long to answer, so MyBuildy stopped waiting. Try again in a moment.',
    'Your AI provider is having trouble right now. Wait a minute and try again.',
  ]
  if (actionable.includes(message)) return 'Could not load your model list. ' + message
  return 'MyBuildy could not load your model list. Retry, or go Back to check your provider and key.'
}

/** Display only fixed-stage, validated status and allowlisted classification. */
export function modelListDiagnosticText(diagnostic: ModelListDiagnostic | undefined): string | null {
  if (!diagnostic || diagnostic.stage !== 'model-list') return null
  const status = Number.isInteger(diagnostic.status) && diagnostic.status! >= 400 && diagnostic.status! <= 599
    ? `HTTP ${diagnostic.status}` : 'HTTP status unavailable'
  const kind = MODEL_LIST_ERROR_KINDS.includes(diagnostic.kind) ? diagnostic.kind : 'unknown'
  return `Model list · ${status} · ${kind}`
}
