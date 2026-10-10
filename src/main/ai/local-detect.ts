// local-detect.ts — main process (ELECTRON-FREE, unit-tested)
// First-run setup, "Use a local model instead": is Ollama / LM Studio running
// on this computer, and which of its models can read images? Only the model
// LIST endpoints are called — detection never loads or runs a model. The
// addresses come from main (the defaults, or an e2e override), never from the
// renderer, so this can't be pointed anywhere else.

import type { LocalModel, LocalProvider, LocalServerStatus, LocalVision } from '../../renderer/src/types'
import { providerFetch } from './fetch-with-timeout'

/** Where each server listens out of the box (the same defaults Settings shows), then 127.0.0.1. */
export const LOCAL_DEFAULT_ADDRESSES: Record<LocalProvider, string[]> = {
  ollama: ['http://localhost:11434', 'http://127.0.0.1:11434'],
  lmstudio: ['http://localhost:1234/v1', 'http://127.0.0.1:1234/v1'],
}

/** A local server answers its model list at once; don't keep the user waiting. */
const DETECT_TIMEOUT_MS = 3000
/** Ask Ollama about at most this many models (one request each). */
const MAX_DETAILED = 40

// Names that say "this model reads images", for servers that don't report it.
const VISION_NAME = /(llava|bakllava|vision|[-_.:]vl\b|[-_.]vl[-_.:]|\d-?vl|vlm|moondream|minicpm-v|pixtral|gemma-?3|cogvlm|internvl|llama3\.2-vision|qwen2(\.5)?-?vl|granite3\.2-vision|mistral-small-?3\.[12])/i
const EMBEDDING_NAME = /embed/i

export interface DetectOptions {
  timeoutMs?: number
  /** The address that counts as "the default" (nothing is saved for it). Defaults to the provider's first default. */
  defaultAddress?: string
}

async function getJson(url: string, timeoutMs: number, init: RequestInit = { method: 'GET' }): Promise<{ ok: boolean; status: number; json: unknown }> {
  // Throws when nothing answers (refused, timed out); resolves with ok=false on an HTTP error.
  const res = await providerFetch(url, init, { isLocal: true, timeoutMs })
  let json: unknown = null
  try { json = await res.json() } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, json }
}

const visionRank: Record<LocalVision, number> = { yes: 0, unknown: 1, no: 2 }

/** Models that can read images first, then "can't tell", then text-only; alphabetical within each. */
export function sortLocalModels(models: LocalModel[]): LocalModel[] {
  return [...models].sort((a, b) => visionRank[a.vision] - visionRank[b.vision] || a.id.localeCompare(b.id))
}

async function detectOllama(base: string, timeoutMs: number): Promise<LocalModel[]> {
  const tags = await getJson(`${base}/api/tags`, timeoutMs)
  if (!tags.ok) throw new Error(`HTTP ${tags.status}`)
  const list = (tags.json as { models?: Array<{ name?: unknown; details?: { families?: unknown } }> } | null)?.models
  if (!Array.isArray(list)) return []
  const entries = list
    .map((m) => ({ name: typeof m?.name === 'string' ? m.name : '', families: Array.isArray(m?.details?.families) ? (m.details!.families as unknown[]).map(String) : [] }))
    .filter((m) => m.name && !EMBEDDING_NAME.test(m.name))

  return Promise.all(entries.map(async (m, i): Promise<LocalModel> => {
    let capabilities: string[] | null = null
    let families = m.families
    if (i < MAX_DETAILED) {
      try {
        const show = await getJson(`${base}/api/show`, timeoutMs, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: m.name, name: m.name }),
        })
        const body = show.json as { capabilities?: unknown; details?: { families?: unknown } } | null
        if (show.ok && Array.isArray(body?.capabilities)) capabilities = (body!.capabilities as unknown[]).map(String)
        if (show.ok && Array.isArray(body?.details?.families)) families = (body!.details!.families as unknown[]).map(String)
      } catch { /* fall back to the list's information */ }
    }
    if (capabilities?.includes('embedding') && !capabilities.includes('completion')) return { id: m.name, label: m.name, vision: 'no' }
    let vision: LocalVision
    if (capabilities) vision = capabilities.includes('vision') ? 'yes' : 'no'
    else if (families.some((f) => /^(clip|mllama)$/i.test(f)) || VISION_NAME.test(m.name)) vision = 'yes'
    else vision = 'unknown'
    return { id: m.name, label: m.name, vision }
  }))
}

async function detectLmStudio(base: string, timeoutMs: number): Promise<LocalModel[]> {
  // LM Studio's own API says which models are vision models ("vlm").
  const root = base.replace(/\/v1\/?$/, '')
  let typed: Awaited<ReturnType<typeof getJson>> | null = null
  try { typed = await getJson(`${root}/api/v0/models`, timeoutMs) } catch { typed = null }
  const typedData = (typed?.json as { data?: Array<{ id?: unknown; type?: unknown }> } | null)?.data
  if (typed?.ok && Array.isArray(typedData)) {
    return typedData
      .filter((m) => typeof m?.id === 'string' && m.id && m.type !== 'embeddings' && !EMBEDDING_NAME.test(m.id as string))
      .map((m) => ({ id: m.id as string, label: m.id as string, vision: m.type === 'vlm' ? 'yes' : m.type === 'llm' ? 'no' : VISION_NAME.test(m.id as string) ? 'yes' : 'unknown' }))
  }
  // Older LM Studio: the OpenAI-compatible list (no types).
  const plain = await getJson(`${base}/models`, timeoutMs)
  if (!plain.ok) throw new Error(`HTTP ${plain.status}`)
  const data = (plain.json as { data?: Array<{ id?: unknown }> } | null)?.data
  if (!Array.isArray(data)) return []
  return data
    .map((m) => (typeof m?.id === 'string' ? m.id : ''))
    .filter((id) => id && !EMBEDDING_NAME.test(id))
    .map((id) => ({ id, label: id, vision: VISION_NAME.test(id) ? 'yes' : 'unknown' }))
}

/**
 * Try each address in turn; the first that answers its model list is the
 * server. `baseUrl` is '' when that is the default address (Settings then shows
 * the default), otherwise the address that answered.
 */
export async function detectLocalServer(
  provider: LocalProvider,
  addresses: string[] = LOCAL_DEFAULT_ADDRESSES[provider],
  opts: DetectOptions = {},
): Promise<LocalServerStatus> {
  const timeoutMs = opts.timeoutMs ?? DETECT_TIMEOUT_MS
  const defaultAddress = (opts.defaultAddress ?? LOCAL_DEFAULT_ADDRESSES[provider][0]).replace(/\/$/, '')
  for (const raw of addresses) {
    const base = raw.replace(/\/$/, '')
    try {
      const models = provider === 'ollama' ? await detectOllama(base, timeoutMs) : await detectLmStudio(base, timeoutMs)
      return { provider, running: true, baseUrl: base === defaultAddress ? '' : base, models: sortLocalModels(models) }
    } catch {
      // Nothing answered here; try the next address.
    }
  }
  return { provider, running: false, baseUrl: '', models: [] }
}
