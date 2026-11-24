// What Buildy's voice says for words its dictionaries know and don't know —
// with no eSpeak NG (kokoro-g2p.ts). Phonemes are misaki's letters, the ones
// Kokoro was trained on.
import { describe, expect, it } from 'vitest'
import { ipaToMisaki, lastUnknownWords, normalizeText, readUnknown, speakTechToken, textToPhonemes } from './kokoro-g2p'

const VOWELS = /[AIOWYaeiouæɑɔəɛɜɪʊʌᵊᵻ]/

describe('Buildy reads the words Sukin listed (no letter spelling for normal words)', () => {
  const cases: Array<[string, string]> = [
    ['Sukin Shetty', 'sˈukɪn ʃˈɛti'],
    ['MyBuildy', 'mˌIbˈɪldi'],
    ['Buildy', 'bˈɪldi'],
    ['Claude Code', 'klˈɔd kˈOd'],
    ['npm', 'ˈɛn pˈi ˈɛm'], // letters: "N P M"
    ['localhost', 'lˈOkᵊlhˌOst'],
    ['index.html', 'ˈɪndˌɛks dˈɑt ˈAʧ tˈi ˈɛm ˈɛl'], // "index dot H T M L"
    ['PowerShell', 'pˈWəɹʃˌɛl'],
    ['API key', 'ˌApˌiˈI kˈi'],
    ['ElevenLabs', 'əlˈɛvᵊnlˌæbz'],
    ['GitHub', 'ɡˌɪthˈʌb'],
    ['JSON', 'ʤˈAsɑn'], // "Jay-son"
    ['3 tests passed', 'θɹˈi tˈɛsts pˈæst'],
    ['C:\\Users\\User', 'sˈi jˈuzəɹz jˈuzəɹ'], // "C users user"
  ]
  it.each(cases)('%s → %s', (text, phonemes) => {
    expect(textToPhonemes(text)).toBe(phonemes)
  })
})

describe('unknown words', () => {
  it('a made-up word gets sounds from the rules, never letters', () => {
    const ps = textToPhonemes('Zorblatt quexified the flombulator.')
    expect(ps).toMatch(/^z\S+ kw\S+ ðə fl\S+\.$/)
    const unknown = lastUnknownWords()
    expect(unknown.map((u) => [u.word, u.path])).toEqual([
      ['flombulator', 'rules'],
      ['quexified', 'rules'],
      ['Zorblatt', 'rules'],
    ])
    for (const u of unknown) expect(u.phonemes).toMatch(VOWELS)
  })

  it('only short all-capitals or vowel-less words are said as letters', () => {
    expect(readUnknown({ text: 'SDK' })).toBe('ˈɛs dˈi kˈA')
    expect(readUnknown({ text: 'ssh' })).toBe('ˈɛs ˈɛs ˈAʧ')
    expect(lastUnknownWords().at(-1)?.path).toBe('letters')
    expect(readUnknown({ text: 'Shetty' })).toBe('ʃˈɛti')
    expect(lastUnknownWords().at(-1)?.path).toBe('rules')
  })

  it('a long all-capitals word is read as a word', () => {
    expect(readUnknown({ text: 'FLOMBULATOR' })).toMatch(/^fl/)
  })

  it('camel case is split into its words', () => {
    expect(readUnknown({ text: 'SupaBuildy' })).toBe(`${textToPhonemes('Supa')} bˈɪldi`)
  })

  it('possessive of an unknown name', () => {
    expect(textToPhonemes("Sukin's")).toBe('sˈukɪnz')
    expect(textToPhonemes("Zorblatt's")).toMatch(/^zˈɔɹblət[sz]$/)
  })

  it('every phoneme letter is one Kokoro knows', () => {
    const vocab = new Set([...' !"$(),.:;?AIOQSTWYabcdefhijklmnopqrstuvwxyzæçðøŋœɐɑɒɔɕɖəɚɛɜɟɡɣɤɥɨɪɯɰɲɳɴɸɹɻɽɾʁʂʃʈʊʋʌʎʒʔʝʣʤʥʦʧʨʰʲˈˌː̃βθχᵊᵝᵻ—“”…→↓↗↘ꭧ'])
    const ps = textToPhonemes('Zorblatt, Xiaoqing and Nguyen tried Quetzalcoatl.js at 10:30 for $5.50 (really!) — “wow”.')
    for (const ch of ps) expect(vocab.has(ch), `${ch} in ${ps}`).toBe(true)
  })
})

describe('file names, paths and addresses', () => {
  it.each([
    ['index.html', 'index dot html'],
    ['src/main/index.ts', 'src main index dot ts'],
    ['C:\\Users\\User', 'C Users User'],
    ['localhost:3000', 'localhost 3000'],
    ['https://mybuildy.com', 'mybuildy dot com'],
    ['me@example.com', 'me at example dot com'],
    ['file_name.txt', 'file name dot txt'],
  ])('%s is said as "%s"', (token, spoken) => {
    expect(speakTechToken(token)).toBe(spoken)
  })

  it('a sentence keeps the words around a file name', () => {
    expect(textToPhonemes('Open index.html in your browser.')).toBe(`ˈOpᵊn ${textToPhonemes('index.html')} ɪn jʊɹ bɹˈWzəɹ.`)
  })
})

describe('text clean-up (ported from kokoro-js)', () => {
  it('times, money, years, ranges', () => {
    expect(normalizeText('At 10:30 it cost $5.50 in 2026, pages 3-5.')).toBe('At 10 30 it cost 5 dollars and 50 cents in 20 26, pages 3 to 5.')
  })
  it('keeps the dot of a lower-case file name (kokoro-js turned it into a dash)', () => {
    expect(normalizeText('index.html')).toBe('index.html')
    expect(normalizeText('U.S.A')).toBe('U-S-A')
  })
})

describe('IPA from the rules → misaki letters', () => {
  it.each([
    ['ˈhɛɫoʊ', 'hˈɛlO'],
    ['ˈdʒeɪsɑn', 'ʤˈAsɑn'],
    ['ˈpaʊɝ', 'pˈWɜɹ'],
    ['tʃɔɪs', 'ʧYs'],
    ['ˈbɝdɚ', 'bˈɜɹdəɹ'],
  ])('%s → %s', (ipa, misaki) => {
    expect(ipaToMisaki(ipa)).toBe(misaki)
  })
})

describe('the override syntax is not a way in', () => {
  it('text that looks like [word](/phonemes/) is read as the word', () => {
    expect(textToPhonemes('[hello](/zzzz/)')).toBe(textToPhonemes('hello'))
  })
})
