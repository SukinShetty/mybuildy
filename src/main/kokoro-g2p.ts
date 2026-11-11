// kokoro-g2p.ts — ELECTRON-FREE, unit-tested. Text → Kokoro phonemes for
// Buildy's own voice, with NO eSpeak NG anywhere (eSpeak NG is GPL-3.0; it
// used to come in through kokoro-js → phonemizer). The model, Bella and Puck
// are unchanged: only this text-to-sound step is ours.
//
// How a sentence becomes phonemes:
//   1. normalizeText: kokoro-js's own text clean-up (Apache-2.0, ported below):
//      quotes, Dr./Mr., times, years, money, decimals, number ranges.
//   2. APP_WORDS: a few words Buildy says often and no dictionary has
//      (MyBuildy, Buildy, JSON as "Jay-son"…), pinned with misaki's own
//      `[word](/phonemes/)` syntax.
//   3. misaki (Kokoro's own English G2P, Apache-2.0) via its TypeScript port
//      @titan-design/speech-g2p (MIT): misaki's US gold + silver dictionaries,
//      its number reading, its suffix rules (-s, -ed, -ing) and part-of-speech
//      choice between homographs. Its eSpeak fallback does not exist here.
//   4. readUnknown: every word misaki can't read goes here instead of eSpeak:
//      - "index.html", "C:\Users", "localhost:3000", "file_name": split at the
//        punctuation ("." is said "dot", "@" "at") and each part read again;
//      - "MyBuildy", "ElevenLabs": split where the capitals are, parts read again;
//      - "Sukin's": the word, then 's as s / z / ɪz;
//      - a short all-capitals word or one with no vowel ("npm", "CLI"): letters;
//      - anything else: the `phonemize` package (MIT): its CMUdict-derived
//        dictionary, then word-part analysis, then letter-to-sound rules —
//        it always returns sounds, it never spells a normal word.
//   5. IPA from step 4 is turned into misaki's phoneme letters (the ones
//      Kokoro was trained on).

import { misakiEnglish, type G2p, type G2pToken } from '@titan-design/speech-g2p'
import { EnglishG2P } from 'phonemize/en-g2p'

/** How the last unknown word was read (tests and the sample report use this). */
export type UnknownPath = 'parts' | 'camel-case' | 'possessive' | 'letters' | 'rules' | 'dropped'
export type UnknownWord = { word: string; path: UnknownPath; phonemes: string; detail?: string }

/**
 * Words Buildy says that no dictionary has, or reads in a way that would be
 * wrong here. misaki phoneme letters (A = "ay", I = "eye", O = "oh", ʤ = "j").
 */
export const APP_WORDS: Readonly<Record<string, string>> = {
  MyBuildy: 'mˌIbˈɪldi',
  Mybuildy: 'mˌIbˈɪldi',
  mybuildy: 'mˌIbˈɪldi',
  MYBUILDY: 'mˌIbˈɪldi',
  Buildy: 'bˈɪldi',
  buildy: 'bˈɪldi',
  BUILDY: 'bˈɪldi',
  "Buildy's": 'bˈɪldiz',
  "MyBuildy's": 'mˌIbˈɪldiz',
  JSON: 'ʤˈAsɑn', // "Jay-son", not J-S-O-N
  json: 'ʤˈAsɑn',
  Sukin: 'sˈukɪn',
  README: 'ɹˈidmi',
  localhost: 'lˈOkᵊlhˌOst',
  Localhost: 'lˈOkᵊlhˌOst',
}

// ---------------------------------------------------------------------------
// 1. Text clean-up: a port of kokoro-js 1.2.1 normalize_text (Apache-2.0,
// Copyright hexgrad / Xenova). Two eSpeak-only rules are left out: "(" → "«"
// (Kokoro's tokenizer dropped « anyway; misaki reads brackets itself) and
// "yeah" → "ye'a" (an eSpeak spelling trick; misaki knows "yeah").

function splitNum(num: string): string {
  if (num.includes('.')) return num
  if (num.includes(':')) {
    const [h, m] = num.split(':').map(Number)
    if (m === 0) return `${h} o'clock`
    if (m < 10) return `${h} oh ${m}`
    return `${h} ${m}`
  }
  const year = parseInt(num.slice(0, 4), 10)
  if (year < 1100 || year % 1000 < 10) return num
  const left = num.slice(0, 2)
  const right = parseInt(num.slice(2, 4), 10)
  const suffix = num.endsWith('s') ? 's' : ''
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`
    if (right < 10) return `${left} oh ${right}${suffix}`
  }
  return `${left} ${right}${suffix}`
}

function flipMoney(m: string): string {
  const bill = m[0] === '$' ? 'dollar' : 'pound'
  if (isNaN(Number(m.slice(1)))) return `${m.slice(1)} ${bill}s`
  if (!m.includes('.')) {
    const s = m.slice(1) === '1' ? '' : 's'
    return `${m.slice(1)} ${bill}${s}`
  }
  const [b, c] = m.slice(1).split('.')
  const d = parseInt(c.padEnd(2, '0'), 10)
  const coins = m[0] === '$' ? (d === 1 ? 'cent' : 'cents') : d === 1 ? 'penny' : 'pence'
  return `${b} ${bill}${b === '1' ? '' : 's'} and ${d} ${coins}`
}

function pointNum(num: string): string {
  const [a, b] = num.split('.')
  return `${a} point ${b.split('').join(' ')}`
}

export function normalizeText(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, '“')
    .replace(/»/g, '”')
    .replace(/[“”]/g, '"')
    .replace(/、/g, ', ')
    .replace(/。/g, '. ')
    .replace(/！/g, '! ')
    .replace(/，/g, ', ')
    .replace(/：/g, ': ')
    .replace(/；/g, '; ')
    .replace(/？/g, '? ')
    .replace(/[^\S \n]/g, ' ')
    .replace(/  +/g, ' ')
    .replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNum)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    // kokoro-js has /gi here, which also turned "index.html" into "index-html";
    // only capitals now (U.S.A → U-S-A), so file names keep their "dot".
    .replace(/(?<=[A-Z])\.(?=[A-Z])/g, '-')
    .trim()
}

// ---------------------------------------------------------------------------
// 5. IPA (from the `phonemize` package) → misaki's phoneme letters.

const IPA_VOWELS = new Set([...'aeiouæɑɒɔəɚɛɜɝɪʊʌɐᵻᵊAIOWYQ'])

export function ipaToMisaki(ipa: string): string {
  let s = ipa
    .normalize('NFC')
    .replace(/[ˑ.‿͡]/g, '')
    .replace(/ː/g, '')
    .replace(/d͡?ʒ/g, 'ʤ')
    .replace(/t͡?ʃ/g, 'ʧ')
    .replace(/eɪ/g, 'A')
    .replace(/aɪ/g, 'I')
    .replace(/aʊ/g, 'W')
    .replace(/[oə]ʊ/g, 'O')
    .replace(/ɔɪ/g, 'Y')
    .replace(/ɝ/g, 'ɜɹ')
    .replace(/ɚ/g, 'əɹ')
    .replace(/ɫ/g, 'l')
    .replace(/r/g, 'ɹ')
    .replace(/g/g, 'ɡ')
    .replace(/ɾ/g, 'T')
    .replace(/ʔ/g, 't')
    .replace(/x/g, 'k')
    .replace(/ɐ/g, 'ə')
    .replace(/ɒ/g, 'ɑ')
    .replace(/n̩/g, 'ᵊn')
    .replace(/l̩/g, 'ᵊl')
    .replace(/[\u0300-\u036f]/g, '')
  // misaki puts a stress mark right before the stressed vowel; IPA puts it
  // before the syllable. Move each mark onto its vowel.
  let out = ''
  let held = ''
  for (const ch of s) {
    if (ch === 'ˈ' || ch === 'ˌ') { held = held === 'ˈ' ? held : ch; continue }
    if (held && IPA_VOWELS.has(ch)) { out += held; held = '' }
    out += ch
  }
  s = out
  // Only letters Kokoro knows.
  return s.replace(/[^AIOQSTWYabcdefhijklmnopqrstuvwxyzæçðøŋœɐɑɒɔɕɖəɚɛɜɟɡɣɤɥɨɪɯɰɲɳɴɸɹɻɽɾʁʂʃʈʊʋʌʎʒʔʝʣʤʥʦʧʨʰʲˈˌβθχᵊᵻ]/g, '')
}

// ---------------------------------------------------------------------------
// 3 + 4. misaki with our unknown-word reader.

const SEPARATOR_WORDS: Readonly<Record<string, string>> = { '.': 'dot', '@': 'at', '+': 'plus', '#': 'hash', '=': 'equals', '&': 'and', '%': 'percent' }
const SILENT_SEPARATORS = /[\\/_:\-~|,;!?()[\]{}<>"'`*^$]/

let rules: EnglishG2P | null = null
let engine: G2p | null = null
const letterCache = new Map<string, string>()
let lastUnknown: UnknownWord[] = []
let depth = 0

function rulesEngine(): EnglishG2P {
  if (!rules) rules = new EnglishG2P({ dialect: 'en-US' })
  return rules
}

function misaki(): G2p {
  if (!engine) engine = misakiEnglish({ fallback: (token) => readUnknown(token) })
  return engine
}

/** misaki reading of a short piece of text (used again for the parts of an unknown word). */
function readAgain(text: string): string {
  depth++
  try {
    return depth > 4 ? '' : misaki().phonemize(pinAppWords(text)).phonemes.trim()
  } finally {
    depth--
  }
}

function letterSounds(letters: string): string {
  return [...letters.toUpperCase()].map((l) => {
    if (!letterCache.has(l)) letterCache.set(l, readAgain(l === 'A' ? 'A.' : l).replace(/[.\s]/g, ''))
    return letterCache.get(l) ?? ''
  }).join(' ')
}

/** The rule-based reader (phonemize: dictionary → word parts → letter-to-sound rules). */
function readWithRules(word: string): { phonemes: string; detail: string } {
  const g2p = rulesEngine()
  const trace = g2p.trace(word.toLowerCase())
  const ipa = g2p.predict(word.toLowerCase()) ?? trace.ipa
  return { phonemes: ipaToMisaki(ipa), detail: trace.path }
}

function note(word: string, path: UnknownPath, phonemes: string, detail?: string): string | null {
  if (depth === 0 || path !== 'dropped') lastUnknown.push({ word, path, phonemes, detail })
  return phonemes || null
}

/** What we say for a word misaki has no reading for (misaki's "rating 2"). */
export function readUnknown(token: Pick<G2pToken, 'text'>): string | null {
  const word = token.text.normalize('NFKC')
  if (!/[\p{L}\p{N}]/u.test(word)) return note(word, 'dropped', '')
  // Punctuation inside a word: index.html, C:\Users, localhost:3000, file_name.txt.
  if (/[^\p{L}\p{N}']/u.test(word) || /^'|'$/.test(word)) {
    const spoken = word
      .split(/([.@+#=&%])/)
      .map((part) => (SEPARATOR_WORDS[part] ? ` ${SEPARATOR_WORDS[part]} ` : part.split(SILENT_SEPARATORS).join(' ')))
      .join('')
      .replace(/\s+/g, ' ')
      .replace(/^ dot | dot $/g, ' ')
      .trim()
    if (spoken && spoken !== word) return note(word, 'parts', readAgain(spoken), spoken)
  }
  // Possessive: Sukin's → Sukin + z.
  const possessive = /^(.+?)'s$/i.exec(word)
  if (possessive) {
    const base = readAgain(possessive[1])
    if (base) {
      const end = base.replace(/[ˈˌ]/g, '').slice(-1)
      const s = /[szʃʒʧʤ]/.test(end) ? 'ɪz' : /[ptkfθ]/.test(end) ? 's' : 'z'
      return note(word, 'possessive', base + s)
    }
  }
  // CamelCase: MyBuildy, ElevenLabs, PowerShell (when the dictionary lacks the whole).
  const camel = word.replace(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/g, ' ')
  if (camel !== word) return note(word, 'camel-case', readAgain(camel), camel)
  // Letters: a short all-capitals word (CLI, SDK) or one with no vowel at all (npm, ssh).
  if (/^[A-Za-z]{1,5}$/.test(word) && (word === word.toUpperCase() || !/[aeiouyAEIOUY]/.test(word))) {
    return note(word, 'letters', letterSounds(word))
  }
  if (/^\d+$/.test(word)) return note(word, 'parts', readAgain(word.split('').join(' ')))
  // Everything else: rules, never letter spelling.
  const { phonemes, detail } = readWithRules(word)
  return note(word, 'rules', phonemes, detail)
}

function pinAppWords(text: string): string {
  // Text that already looks like misaki's override syntax is read as plain words.
  let out = text.replace(/\[([^\]]*)\]\(\/[^)]*\/\)/g, '$1')
  for (const [word, phonemes] of Object.entries(APP_WORDS)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_.\\\\/:])${escaped}(?![\\p{L}\\p{N}_]|'s\\b|[.:/\\\\][\\p{L}\\p{N}])`, 'gu'), `[${word}](/${phonemes}/)`)
  }
  return out
}

// A file name, path, address or URL: index.html, src/main/index.ts,
// C:\Users\User, localhost:3000, https://mybuildy.com, me@example.com.
const TECH_TOKEN = /(?:[a-z][a-z0-9+.-]*:\/\/)?[\p{L}\p{N}_~-]*(?:[\p{L}\p{N}_~-][.\/\\:@][\p{L}\p{N}_~-]|[\p{L}]:\\)[\p{L}\p{N}_~.\/\\:@-]*[\p{L}\p{N}_~\/\\-]/gu

/** How a file name, path or address is said: parts as words, "." as "dot", "@" as "at". */
export function speakTechToken(token: string): string {
  return token
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // https:// is not read out
    .replace(/^www\./i, '')
    .replace(/\./g, ' dot ')
    .replace(/@/g, ' at ')
    .replace(/[\/\\:_~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function speakTechTokens(text: string): string {
  return text.replace(TECH_TOKEN, (token) => {
    const spoken = speakTechToken(token)
    lastUnknown.push({ word: token, path: 'parts', phonemes: '', detail: spoken })
    return spoken
  })
}

/** Text → the phoneme string Kokoro's tokenizer takes. No eSpeak NG. */
export function textToPhonemes(text: string): string {
  lastUnknown = []
  const prepared = pinAppWords(speakTechTokens(normalizeText(text)))
  if (!prepared) return ''
  return misaki()
    .phonemize(prepared)
    .phonemes.replace(/\s+/g, ' ')
    .trim()
}

/** The unknown words of the last textToPhonemes call, and how each was read. */
export function lastUnknownWords(): UnknownWord[] {
  return lastUnknown.slice()
}

/** Load the dictionaries now (the voice warm-up calls this so the first line isn't slower). */
export function warmUpG2p(): void {
  textToPhonemes('Hi, MyBuildy.')
}
