// phonemize's package.json lists "types" after "import" for ./en-g2p, so
// TypeScript can't find its types; this is the part kokoro-g2p.ts uses
// (from phonemize 2.0.1 dist/en/g2p.d.ts).
declare module 'phonemize/en-g2p' {
  export class EnglishG2P {
    constructor(options?: { disableDict?: boolean; dialect?: 'en-US' | 'en-GB'; enablePrincipled?: boolean })
    predict(word: string, language?: string, pos?: string): string | null
    trace(word: string, language?: string, pos?: string): { word: string; ipa: string; path: 'dictionary' | 'morphology' | 'decomposition' | 'rules' }
  }
  export default EnglishG2P
}
