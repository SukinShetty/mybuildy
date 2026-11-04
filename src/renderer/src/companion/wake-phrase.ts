// wake-phrase.ts — was "Hey Buildy" said at the start, and what was asked after it.
//
// The words come from the on-device speech model (main/listen-worker.ts); this
// file only reads text. The small model spells the name a few ways ("Hey
// Buildy", "Hey, Bildy", "A building", "Hey Billy"), so close spellings count,
// but ONLY at the very start of what was heard, and only when the name is
// followed by a pause, nothing, or a request ("Hey Billy, come here" is caught
// by the request check only if it sounds like a request to MyBuildy).
// Two rules: LOOSE (default; also accepts billy/beauty/bud/buddy, which is how
// the model often hears the name in noise) and STRICT (internal fallback).
// Same rules as the audio eval (scripts/wake-eval/two_sum.py). Pure and unit-tested.

export interface WakeMatch {
  /** "Hey Buildy" was said at the start. */
  heard: boolean
  /** What came after the name (may be empty: then the next thing said is the command). */
  command: string
}

export type WakeRule = 'loose' | 'strict'
/** Default rule (eval: two-stage loose ≈75% clean, 0/h on 1.35 h of real read speech). */
export const WAKE_RULE: WakeRule = 'loose'
/** Fallback if the loose rule wakes too often in real use. */
export const WAKE_RULE_FALLBACK: WakeRule = 'strict'

const STRICT_NAMES = 'buildy|buildie|bildy|billdy|baldy|bill d|bill b|building|billie'
const LOOSE_NAMES = STRICT_NAMES + '|billy|beauty|bud|buddy'

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\u2019']/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Find the wake phrase at the start of `text` (a transcript of one stretch of speech). */
export function findWakePhrase(text: string, rule: WakeRule = WAKE_RULE): WakeMatch {
  const t = text.toLowerCase().replace(/[\u2019']/g, '').replace(/[^a-z ,.?!]/g, ' ').replace(/\s+/g, ' ').trim()
  const names = rule === 'loose' ? LOOSE_NAMES : STRICT_NAMES
  const m = new RegExp('^(hey|hay|a|hi|okay hey)[,.!]? (' + names + ')\\b([,.?!]?)\\s*(.*)$').exec(t)
  if (!m) return { heard: false, command: '' }
  const rest = m[4]
  if (!(m[3] !== '' || rest === '' || REQUEST_START.test(words(rest).join(' ')))) return { heard: false, command: '' }
  return { heard: true, command: rest === '' ? '' : commandText(text.trim(), m[1], m[2]) }
}

// The words after the name, keeping the speaker's own punctuation ("why did it fail?").
function commandText(original: string, lead: string, name: string): string {
  const parts = original.split(/\s+/)
  const skip = words(lead).length + words(name).length
  let seen = 0
  let k = 0
  while (k < parts.length && seen < skip) { seen += words(parts[k]).length; k++ }
  return parts.slice(k).join(' ').replace(/^[\s,.:;!\-]+/, '').trim()
}

const REQUEST_START = /^(what|whats|why|how|hows|where|when|who|which|can|could|would|will|should|please|tell|explain|help|give|show|check|fix|did|does|do|is it|are the|any|next)\b/

export type VoiceCommand =
  | { kind: 'suggest-prompt' } // "give me the prompt", "what should I type next?" → Analyze Now
  | { kind: 'ask'; question: string }
  | { kind: 'none' }

/** What to do with a command: the next prompt, or a question for the ask flow. */
export function routeCommand(command: string): VoiceCommand {
  const text = command.trim()
  if (!text) return { kind: 'none' }
  const w = words(text).join(' ')
  if (
    /\b(give|show|get|tell|send)( me)?( the| a| my)?( next)? prompt\b/.test(w) ||
    /\bwhat (should|do|can) i (type|paste|say|send)\b/.test(w) ||
    /^(the )?next (prompt|step)\b/.test(w) ||
    /^(the )?prompt( please)?$/.test(w)
  ) return { kind: 'suggest-prompt' }
  return { kind: 'ask', question: text }
}
