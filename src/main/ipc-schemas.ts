// ipc-schemas.ts — main process
// Strict input validation for IPC handlers. The renderer is treated as untrusted:
// every handler validates its payload against a zod schema before acting, and
// provider base URLs are checked against an allowlist so a compromised renderer
// can't redirect cloud API calls (with the user's key) to an attacker host.

import { z } from 'zod'
import { isAllowedProviderUrl } from './provider-origins'
import type { IpcMainInvokeEvent, IpcMainEvent } from 'electron'

// ─── Validation helper ──────────────────────────────────────────────────────────

/** Parse `value` with `schema`; on failure log + throw (rejecting the handler). */
export function parseInput<T>(schema: z.ZodType<T>, channel: string, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    console.warn(`[IPC] rejected invalid input on channel ${channel}: ${result.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`)
    throw new Error(`Invalid input on ${channel}`)
  }
  return result.data
}

/** Sender check: only the main app window may mutate secrets/settings. */
export function assertFromMainWindow(
  event: IpcMainInvokeEvent | IpcMainEvent,
  mainWindowWebContentsId: number,
  channel: string
): void {
  if (event.sender.id !== mainWindowWebContentsId) {
    console.warn(`[IPC] rejected ${channel}: sender is not the main window`)
    throw new Error(`Unauthorized sender on ${channel}`)
  }
}

/** Sender check: the sender must be one of the given windows (null ids are
 *  ignored — e.g. a window that doesn't exist right now). */
export function assertFromWindowIds(
  event: IpcMainInvokeEvent | IpcMainEvent,
  allowedWebContentsIds: Array<number | null>,
  channel: string
): void {
  if (!allowedWebContentsIds.some((id) => id !== null && event.sender.id === id)) {
    console.warn(`[IPC] rejected ${channel}: sender is not an allowed window`)
    throw new Error(`Unauthorized sender on ${channel}`)
  }
}

/** Sender check: only the guidance window (Send button host) may request a send. */
export function assertFromGuidanceWindow(
  event: IpcMainInvokeEvent | IpcMainEvent,
  guidanceWebContentsId: number | null,
  channel: string
): void {
  if (guidanceWebContentsId === null || event.sender.id !== guidanceWebContentsId) {
    console.warn(`[IPC] rejected ${channel}: sender is not the guidance window`)
    throw new Error(`Unauthorized sender on ${channel}`)
  }
}

// ─── Provider URL allowlist ───────────────────────────────────────────────────────

/**
 * Validate a provider base URL (see provider-origins.ts). Empty → provider
 * default. Cloud providers: exactly their own HTTPS origin. Local providers:
 * this computer. Custom: any http(s) endpoint.
 */
export function isAllowedBaseUrl(provider: string, baseUrl: string): boolean {
  return isAllowedProviderUrl(provider, baseUrl)
}

// ─── Schemas ──────────────────────────────────────────────────────────────────────

export const providerEnum = z.enum([
  'anthropic', 'openai', 'gemini', 'openrouter', 'ollama', 'lmstudio', 'custom',
])

export const secretNameEnum = z.enum([
  'anthropicApiKey', 'openaiApiKey', 'geminiApiKey', 'openrouterApiKey', 'customApiKey', 'elevenLabsApiKey',
])

// macOS privacy permission kinds — the renderer names a kind, main owns the URL.
export const macPermissionEnum = z.enum(['screen', 'accessibility', 'automation'])

// Unknown keys are STRIPPED by zod's default object parse — so a renderer that tries
// to sneak an `apiKey` field into a settings save has it silently dropped.
// modelId may be EMPTY: there is no default model — the user must pick one
// (handlers that need a model refuse with "Choose a model in Settings").
export const nonSecretSettingsSchema = z.object({
  provider: providerEnum,
  modelId: z.string().max(200),
  baseUrl: z.string().max(2000),
  autoAnalysisIntervalSeconds: z.number().int().min(5).max(3600),
  elevenLabsVoiceId: z.string().max(200),
  hourlyCallCap: z.number().int().min(20).max(600),
  // One-time privacy-disclosure flag. Defaulted so callers built before the
  // flag existed still validate; missing means "not accepted yet".
  captureNoticeAccepted: z.boolean().default(false),
})

// Live model list request — main fetches with the STORED key, never a renderer key.
export const listModelsSchema = z.object({
  provider: providerEnum,
  baseUrl: z.string().max(2000),
})

// Vision-gate status query for the Settings UI.
export const visionStatusSchema = z.object({
  provider: providerEnum,
  modelId: z.string().min(1).max(200),
})

export const setSecretSchema = z.object({
  name: secretNameEnum,
  value: z.string().max(2000),
})

export const projectMemorySchema = z.object({}).passthrough() // shape validated elsewhere; just ensure it's an object

export const goalPartialSchema = z.object({
  purpose: z.string().max(5000).optional(),
  audience: z.string().max(2000).optional(),
  mostImportant: z.string().max(2000).optional(),
  successCriteria: z.string().max(2000).optional(),
  createdAt: z.string().max(64).optional(),
  lastReviewedAt: z.string().max(64).optional(),
}).passthrough()

// ─── Projects (project-scoped memory) ────────────────────────────────────────
export const projectIdSchema = z.string().min(1).max(100)
export const projectCreateSchema = z.object({
  name: z.string().max(120).optional(),
  goalText: z.string().max(5000).optional(),
})
export const projectRenameSchema = z.object({
  id: projectIdSchema,
  name: z.string().min(1).max(120),
})

export const shortText = z.string().max(10_000)
// Displayed-prompt identity for send-to-terminal (main-generated, opaque).
export const promptIdSchema = z.string().min(1).max(200)
export const sourceId = z.string().max(2000)
export const windowName = z.string().max(2000)
export const confidenceEnum = z.enum(['low', 'medium', 'high'])
export const chatHistorySchema = z.array(
  z.object({ role: z.string().max(32), content: z.string().max(100_000), timestamp: z.string().max(64).optional() })
).max(200)
