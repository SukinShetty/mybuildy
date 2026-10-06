// connection-test.ts — main process
// "Test connection" IS the vision check: a tiny solid-red test image is sent
// to the selected provider+model and the model must answer "red". A pass is
// persisted (vision-approvals.ts) and unlocks watching for that exact
// provider+model until the API key changes. Failures map to the same
// plain-English strings used at runtime (provider-errors.ts).
//
// Runs automatically when a model is selected, and on demand via the
// Test connection button in Settings.

import type { AppSettings } from '../../renderer/src/types'
import { CHOOSE_MODEL_MESSAGE } from '../../renderer/src/types'
import { callTextCompletion } from './text-completion'
import { mapProviderError, PROVIDER_ERROR_MESSAGES, type ProviderErrorKind } from './provider-errors'
import { recordVisionPass, recordVisionFail } from '../vision-approvals'

// 32x32 solid red PNG, constructed programmatically (scripts/one-off zlib PNG
// encoder) and inlined as base64 — no fixture file needed at runtime.
export const RED_TEST_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC'

const VISION_QUESTION = 'What single colour is this image? Answer in one word.'

const PROVIDERS_REQUIRING_KEY = new Set(['anthropic', 'openai', 'gemini', 'openrouter'])

export interface ConnectionTestResult {
  success: boolean
  message: string
  latencyMs: number | null
  /** True only when the model actually answered "red" for the test image. */
  visionPassed: boolean
  /** Why the check failed (drives the billing / next-model buttons); null on a pass. */
  errorKind: ProviderErrorKind | null
}

export async function testProviderConnection(
  settings: AppSettings
): Promise<ConnectionTestResult> {
  const startTime = Date.now()

  if (!settings.modelId.trim()) {
    return { success: false, message: CHOOSE_MODEL_MESSAGE, latencyMs: null, visionPassed: false, errorKind: null }
  }
  if (PROVIDERS_REQUIRING_KEY.has(settings.provider) && !settings.apiKey) {
    return { success: false, message: CHOOSE_MODEL_MESSAGE, latencyMs: null, visionPassed: false, errorKind: null }
  }

  try {
    const answer = await callTextCompletion({
      system: 'You answer in one word.',
      user: VISION_QUESTION,
      settings,
      maxTokens: 10,
      imageBase64: RED_TEST_IMAGE_BASE64,
      imageMime: 'image/png',
    })
    const latency = Date.now() - startTime

    if (answer.toLowerCase().includes('red')) {
      recordVisionPass(settings.provider, settings.modelId, settings.apiKey)
      return {
        success: true,
        message: `Vision check passed — this model can see your screen. (${latency}ms)`,
        latencyMs: latency,
        visionPassed: true,
        errorKind: null,
      }
    }

    // No text at all is not proof the model is blind (a reasoning model can
    // spend its budget thinking) — report it without recording a vision fail.
    if (!answer.trim()) {
      return {
        success: false,
        message: PROVIDER_ERROR_MESSAGES.emptyAnswer,
        latencyMs: latency,
        visionPassed: false,
        errorKind: 'empty-answer',
      }
    }

    // The model responded but couldn't (or wouldn't) read the image.
    recordVisionFail(settings.provider, settings.modelId)
    return {
      success: false,
      message: PROVIDER_ERROR_MESSAGES.cannotReadImages,
      latencyMs: latency,
      visionPassed: false,
      errorKind: 'cannot-read-images',
    }
  } catch (error) {
    const latency = Date.now() - startTime
    const mapped = mapProviderError(String(error))
    // An image-rejection error is a definitive vision fail for this model.
    if (mapped.kind === 'cannot-read-images') {
      recordVisionFail(settings.provider, settings.modelId)
    }
    return { success: false, message: mapped.message, latencyMs: latency, visionPassed: false, errorKind: mapped.kind }
  }
}
