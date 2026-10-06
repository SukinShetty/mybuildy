// anthropic.ts — Anthropic Messages API provider
// Supports vision, streaming, and Cloudflare Worker proxy mode.

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
import { ANALYSIS_MAX_OUTPUT_TOKENS } from '../request-shape'

export const anthropicProviderInfo: ProviderInfo = {
  type: 'anthropic',
  displayName: 'Anthropic',
  description: 'Claude models via the Anthropic API. Best quality for screen analysis.',
  requiresApiKey: true,
  requiresBaseUrl: false,
  defaultBaseUrl: 'https://api.anthropic.com',
  supportsStreaming: true,
}

export class AnthropicProvider implements AIProvider {
  readonly info = anthropicProviderInfo

  async analyzeScreen(
    capture: CaptureResult,
    project: ProjectMemory,
    settings: AppSettings
  ): Promise<AnalysisResult> {
    const startTime = Date.now()
    const systemPrompt = buildAnalysisSystemPrompt(project, capture.windowTitle)
    const userPrompt = buildAnalysisUserPrompt(project, capture.windowTitle)

    const requestBody = {
      model: settings.modelId,
      max_tokens: ANALYSIS_MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: capture.imageBase64,
              },
            },
            { type: 'text', text: `Screenshot of: ${capture.windowTitle}` },
            { type: 'text', text: userPrompt },
          ],
        },
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
      ...conversationHistory.map((msg) => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: userMessage },
    ]

    const requestBody = {
      model: settings.modelId,
      max_tokens: 1000,
      stream: true,
      system: systemPrompt,
      messages,
    }

    const apiUrl = this.resolveUrl(settings, '/v1/messages')
    const headers = this.buildHeaders(settings)

    try {
      const response = await fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      })

      if (!response.ok) {
        throw await providerHttpError(`Anthropic`, response)
      }

      if (!response.body) throw new Error('Anthropic API returned no response body')

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
            if (
              event.type === 'content_block_delta' &&
              event.delta?.type === 'text_delta' &&
              event.delta?.text
            ) {
              accumulatedText += event.delta.text
              if (!senderWebContents.isDestroyed()) {
                senderWebContents.send(IPC.BRAINSTORM_CHUNK, event.delta.text)
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
    const apiUrl = this.resolveUrl(settings, '/v1/messages')
    const headers = this.buildHeaders(settings)

    const response = await providerFetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      throw await providerHttpError(`Anthropic`, response)
    }

    const responseJson = await readJson<{
      content?: Array<{ type: string; text?: string }>
    }>(response, 'Anthropic')

    const textBlock = responseJson.content?.find((block) => block.type === 'text')
    if (!textBlock?.text) throw new Error('Anthropic API returned no text content')

    return textBlock.text
  }

  // Always direct to the Anthropic API (the Worker proxy is disabled in v1).
  private resolveUrl(_settings: AppSettings, path: string): string {
    return `https://api.anthropic.com${path}`
  }

  private buildHeaders(settings: AppSettings): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    }
  }
}
