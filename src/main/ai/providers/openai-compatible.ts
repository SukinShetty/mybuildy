// openai-compatible.ts — Shared provider for all OpenAI Chat Completions-compatible APIs.
// Used by: OpenAI, OpenRouter, LM Studio, and custom endpoints.
// Each gets its own ProviderInfo but shares the same request/response logic.

import type { WebContents } from 'electron'
import { redactKnownSecrets } from '../../secure-store'
import { providerFetch } from '../fetch-with-timeout'
import { providerHttpError, readJson, mapProviderError } from '../provider-errors'
import type {
  ProjectMemory,
  CaptureResult,
  AnalysisResult,
  AppSettings,
  ChatMessage,
} from '../../../renderer/src/types'
import { IPC } from '../../../renderer/src/types'
import type { AIProvider, ProviderInfo } from '../provider-interface'
import { buildAnalysisSystemPrompt, buildAnalysisUserPrompt, buildBrainstormSystemPrompt } from '../prompt-builder'
import { parseAnalysisResponse, tryExtractProjectData } from '../response-parser'
import { fetchWithTimeout } from '../fetch-with-timeout'
import { chatCompletionLimits, ANALYSIS_MAX_OUTPUT_TOKENS } from '../request-shape'

// ─── Provider info definitions ───────────────────────────────────────────────

export const openaiProviderInfo: ProviderInfo = {
  type: 'openai',
  displayName: 'OpenAI',
  description: 'GPT models via the OpenAI API. Strong vision and reasoning.',
  requiresApiKey: true,
  requiresBaseUrl: false,
  defaultBaseUrl: 'https://api.openai.com/v1',
  supportsStreaming: true,
}

export const openrouterProviderInfo: ProviderInfo = {
  type: 'openrouter',
  displayName: 'OpenRouter',
  description: 'Open-source and other models, one key.',
  requiresApiKey: true,
  requiresBaseUrl: false,
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  supportsStreaming: true,
}

export const lmstudioProviderInfo: ProviderInfo = {
  type: 'lmstudio',
  displayName: 'LM Studio',
  description: 'Run local models via LM Studio. Free, private, no API key needed.',
  requiresApiKey: false,
  requiresBaseUrl: true,
  defaultBaseUrl: 'http://localhost:1234/v1',
  supportsStreaming: true,
}

export const customProviderInfo: ProviderInfo = {
  type: 'custom',
  displayName: 'Custom Endpoint',
  description: 'Any OpenAI-compatible API endpoint. Specify your own URL and model.',
  requiresApiKey: false,
  requiresBaseUrl: true,
  defaultBaseUrl: 'http://localhost:8080/v1',
  supportsStreaming: true,
}

// ─── Shared implementation ───────────────────────────────────────────────────

export class OpenAICompatibleProvider implements AIProvider {
  readonly info: ProviderInfo

  constructor(providerInfo: ProviderInfo) {
    this.info = providerInfo
  }

  async analyzeScreen(
    capture: CaptureResult,
    project: ProjectMemory,
    settings: AppSettings
  ): Promise<AnalysisResult> {
    const startTime = Date.now()
    const systemPrompt = buildAnalysisSystemPrompt(project, capture.windowTitle)
    const userPrompt = buildAnalysisUserPrompt(project, capture.windowTitle)

    // ALWAYS send the screenshot. Vision capability is proven up front by the
    // vision check — a model that can't read images fails the gate before
    // watching starts, so there is no text-only fallback here.
    const userContent: Array<Record<string, unknown>> = [
      {
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${capture.imageBase64}`,
          detail: 'high',
        },
      },
      { type: 'text', text: `Screenshot of: ${capture.windowTitle}` },
      { type: 'text', text: userPrompt },
    ]

    const requestBody = {
      model: settings.modelId,
      ...chatCompletionLimits(this.info.type, settings.modelId, ANALYSIS_MAX_OUTPUT_TOKENS),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }

    const responseText = await this.callAPI(requestBody, settings)
    return parseAnalysisResponse(responseText, startTime)
  }

  async streamBrainstorm(
    senderWebContents: WebContents,
    userMessage: string,
    conversationHistory: ChatMessage[],
    settings: AppSettings
  ): Promise<void> {
    const systemPrompt = buildBrainstormSystemPrompt()
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.map((msg) => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: userMessage },
    ]

    const requestBody = {
      model: settings.modelId,
      ...chatCompletionLimits(this.info.type, settings.modelId, 1000),
      stream: true,
      messages,
    }

    const baseUrl = this.resolveBaseUrl(settings)
    const headers = this.buildHeaders(settings)

    try {
      const isLocal = this.info.type === 'lmstudio' || this.info.type === 'custom'
      const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      }, isLocal)

      if (!response.ok) {
        throw await providerHttpError(`${this.info.displayName}`, response)
      }

      if (!response.body) throw new Error(`${this.info.displayName} returned no response body`)

      const reader = response.body.getReader()
      const textDecoder = new TextDecoder()
      let accumulatedText = ''
      let sseBuffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        sseBuffer += textDecoder.decode(value, { stream: true })
        const lines = sseBuffer.split('\n')
        sseBuffer = lines.pop() ?? '' // keep incomplete last line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const jsonString = line.slice(6).trim()
          if (jsonString === '[DONE]') continue

          try {
            const event = JSON.parse(jsonString)
            const delta = event.choices?.[0]?.delta?.content
            if (delta) {
              accumulatedText += delta
              if (!senderWebContents.isDestroyed()) {
                senderWebContents.send(IPC.BRAINSTORM_CHUNK, delta)
              }
            }
          } catch {
            // Non-JSON SSE lines — ignore
          }
        }
      }

      const extractedProjectData = tryExtractProjectData(accumulatedText)
      if (!senderWebContents.isDestroyed()) {
        senderWebContents.send(IPC.BRAINSTORM_DONE, { fullText: accumulatedText, extractedProjectData })
      }
    } catch (error) {
      if (!senderWebContents.isDestroyed()) {
        senderWebContents.send(IPC.BRAINSTORM_ERROR, mapProviderError(redactKnownSecrets(String(error))).message)
      }
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private async callAPI(
    requestBody: Record<string, unknown>,
    settings: AppSettings
  ): Promise<string> {
    const baseUrl = this.resolveBaseUrl(settings)
    const headers = this.buildHeaders(settings)

    const response = await providerFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      throw await providerHttpError(`${this.info.displayName}`, response)
    }

    const responseJson = await readJson<{
      choices?: Array<{ message?: { content?: string } }>
    }>(response, this.info.displayName)

    const content = responseJson.choices?.[0]?.message?.content
    if (!content) throw new Error(`${this.info.displayName} returned no text content`)

    return content
  }

  private resolveBaseUrl(settings: AppSettings): string {
    if (settings.baseUrl) return settings.baseUrl.replace(/\/$/, '')
    return this.info.defaultBaseUrl
  }

  private buildHeaders(settings: AppSettings): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }

    if (settings.apiKey) {
      headers['Authorization'] = `Bearer ${settings.apiKey}`
    }

    // OpenRouter requires extra headers
    if (this.info.type === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/SukinShetty/mybuildy'
      headers['X-Title'] = 'MyBuildy'
    }

    return headers
  }
}
