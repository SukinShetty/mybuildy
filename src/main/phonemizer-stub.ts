// phonemizer-stub.ts — stands in for the `phonemizer` package in the voice
// worker's bundle (electron.vite.config.ts). kokoro-js imports phonemizer,
// which is eSpeak NG (GPL-3.0) compiled to WebAssembly. MyBuildy does not ship
// it: Buildy's voice turns text into phonemes itself (kokoro-g2p.ts) and calls
// Kokoro with those, so this is never called. If it ever were, it fails loudly
// instead of speaking.
export async function phonemize(): Promise<string[]> {
  throw new Error('This phonemizer is not shipped in MyBuildy; use kokoro-g2p.ts')
}
export function list_voices(): never {
  throw new Error('This phonemizer is not shipped in MyBuildy')
}
