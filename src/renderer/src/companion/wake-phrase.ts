// wake-phrase.ts — is "MyBuildy" in what was heard, and what was asked after it.
//
// The words come from the on-device speech model (main/listen-worker.ts); this
// file only reads text. The small model rarely spells the name the same way
// twice ("MyBuildy", "My buildy", "my buildie", "My building, …"), so a few
// close spellings count, but ONLY at the very start of what was said (after an
// optional "hey" / "ok" / "hi"). "Let me build this", "my buddy …" or "my bill
// …" never wake MyBuildy. Pure and unit-tested (wake-phrase.test.ts, and the
// audio eval in scripts/eval-wake-word.mjs).

export interface WakeMatch {
  /** "MyBuildy" was said at the start. */
  heard: boolean
  /** What came after the name (may be empty: then the next thing said is the command). */
  command: string
}

const LEAD_INS = new Set(['hey', 'hi', 'ok', 'okay', 'oh', 'yo', 'so', 'hello'])
const NAME = 'mybuildy'
// Real words the small model hears when someone says something else ("my
// buddy", "my body", "my bill"): never the name, however close they look.
const NOT_THE_NAME = new Set([
  'buddy', 'body', 'baby', 'bill', 'billy', 'build', 'builds', 'builder', 'builders', 'birdie', 'ability',
  'bitty', 'beauty', 'belly', 'bully', 'boy', 'bad', 'buddies', 'bodies', 'bills', 'buildings',
])

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\u2019']/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d[a.length][b.length]
}

/** How many words at `i` spell the name (0 = not the name). */
function nameLength(w: string[], i: number): number {
  const first = w[i] ?? ''
  if (first === NAME) return 1
  if (/^my?build/.test(first) && distance(first, NAME) <= 2) return 1 // "mybuildie", "mybuilty"
  if (first !== 'my' && first !== 'mi') return 0
  const second = w[i + 1] ?? ''
  if (!second || NOT_THE_NAME.has(second)) return 0
  if (second === 'building') return 2 // the model's most common spelling of the name
  // "my buildy", "my buildie", "my build you", "my build e": close to the name, sounds like "build…"
  for (const n of [2, 3]) {
    const parts = w.slice(i + 1, i + n)
    if (parts.length !== n - 1 || parts.some((p) => NOT_THE_NAME.has(p))) continue
    const joined = 'my' + parts.join('')
    if (/^mybuil/.test(joined) && distance(joined, NAME) <= 2) return n
  }
  return 0
}

/** Find the wake phrase at the start of `text` (a transcript of one stretch of speech). */
export function findWakePhrase(text: string): WakeMatch {
  const original = text.trim()
  const w = words(original)
  let i = 0
  while (i < w.length && i < 2 && LEAD_INS.has(w[i])) i++
  const n = nameLength(w, i)
  if (n === 0) return { heard: false, command: '' }
  const after = i + n
  const command = after >= w.length ? '' : commandText(original, after)
  // "my building" is also an everyday phrase ("my building has a new lift"). Count it
  // as the name only when it's followed by a pause, nothing, or a request/question.
  if (n === 2 && w[i + 1] === 'building' && command && !pauseAfter(original, after) && !looksLikeRequest(command)) {
    return { heard: false, command: '' }
  }
  return { heard: true, command }
}

const REQUEST_START = /^(what|whats|why|how|hows|where|when|who|which|can|could|would|will|should|please|tell|explain|help|give|show|check|fix|did|does|do|is it|are the|any|next)\b/

function looksLikeRequest(command: string): boolean {
  const w = words(command).join(' ')
  return REQUEST_START.test(w) || routeCommand(command).kind === 'suggest-prompt'
}

// Did the speaker pause after the name (the model writes "My building, …" / "My building. …")?
function pauseAfter(original: string, wordsBefore: number): boolean {
  const parts = original.split(/\s+/)
  let seen = 0
  for (const part of parts) {
    seen += words(part).length
    if (seen >= wordsBefore) return /[,.:;!?\-]$/.test(part)
  }
  return false
}

// The words after the name, keeping the speaker's own punctuation ("why did it fail?").
function commandText(original: string, wordsToSkip: number): string {
  const parts = original.split(/\s+/)
  let seen = 0
  let k = 0
  while (k < parts.length && seen < wordsToSkip) {
    seen += words(parts[k]).length
    k++
  }
  return parts.slice(k).join(' ').replace(/^[\s,.:;!\-]+/, '').trim()
}

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
