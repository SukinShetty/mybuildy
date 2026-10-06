// ollama.ts — Ollama provider
// Uses the Ollama REST API (OpenAI-compatible chat/completions endpoint).
// Ollama runs locally — no API key needed, free, private.

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

export const ollamaProviderInfo: ProviderInfo = {
  type: 'ollama',
  displayName: 'Ollama',
  description: 'Run open-source models locally via Ollama. Free and private — no API key needed.',
  requiresApiKey: false,
  requiresBaseUrl: true,
  defaultBaseUrl: 'http://localhost:11434',
  supportsStreaming: true,
}

export class OllamaProvider implements AIProvider {
  readonly info = ollamaProviderInfo

  async analyzeScreen(
    capture: CaptureResult,
    project: ProjectMemory,
    settings: AppSettings
  ): Promise<AnalysisResult> {
    const startTime = Date.now()
    const systemPrompt = buildAnalysisSystemPrompt(project, capture.windowTitle)
    const userPrompt = buildAnalysisUserPrompt(project, capture.windowTitle)

    // ALWAYS send the screenshot (Ollama /api/chat takes images as a base64
    // array). Vision capability is proven up front by the vision check — a
    // model that can't read images fails the gate before watching starts.
    const userContent = `Screenshot of: ${capture.windowTitle}\n\n${userPrompt}`

    const requestBody: Record<string, unknown> = {
      model: settings.modelId,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: userContent,
          images: [capture.imageBase64],
        },
      ],
    }

    const baseUrl = this.resolveBaseUrl(settings)
    const response = await fetchWithTimeout(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    }, true)

    if (!response.ok) {
      throw await providerHttpError(`Ollama`, response)
    }

    const responseJson = await readJson<{ message?: { content?: string } }>(response, 'Ollama')
    const text = responseJson.message?.content
    if (!text) throw new Error('Ollama returned no text content')

    return parseAnalysisResponse(text, startTime)
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
      stream: true,
      messages,
    }

    const baseUrl = this.resolveBaseUrl(settings)

    try {
      const response = await providerFetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      })

      if (!response.ok) {
        throw await providerHttpError(`Ollama`, response)
      }

      if (!response.body) throw new Error('Ollama returned no response body')

      // Ollama streams newline-delimited JSON (not SSE)
      const reader = response.body.getReader()
      const textDecoder = new TextDecoder()
      let accumulatedText = ''
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += textDecoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? '' // Keep incomplete last line in buffer

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            const content = event.message?.content
            if (content) {
              accumulatedText += content
              if (!senderWebContents.isDestroyed()) {
                senderWebContents.send(IPC.BRAINSTORM_CHUNK, content)
              }
            }
          } catch {
            // Malformed JSON line — skip
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer)
          const content = event.message?.content
          if (content) {
            accumulatedText += content
            if (!senderWebContents.isDestroyed()) {
              senderWebContents.send(IPC.BRAINSTORM_CHUNK, content)
            }
          }
        } catch {
          // ignore
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

  private resolveBaseUrl(settings: AppSettings): string {
    const url = settings.baseUrl || this.info.defaultBaseUrl
    return url.replace(/\/$/, '')
  }
}
