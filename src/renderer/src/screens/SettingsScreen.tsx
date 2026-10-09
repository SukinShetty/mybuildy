// SettingsScreen.tsx
// Provider + model configuration.
//   - Three "Recommended" providers (Anthropic, OpenAI, OpenRouter) and a
//     collapsed "Advanced" section: Google Gemini (labelled "Not yet tested")
//     and local models (Ollama, LM Studio, Custom endpoint).
//   - The model list shows the curated, live-tested models by default; the rest
//     of the account's list sits behind "Show all".
//   - NO hardcoded model catalog and NO default model: the model list is fetched
//     LIVE in the main process with the stored key; nothing is pre-selected.
//   - Key inputs are write-only: after save you see "Saved" + Replace/Remove —
//     a stored key is never displayed.
//   - Selecting a model automatically runs the vision check (Test connection):
//     a red test image the model must identify. Watching is only unlocked by a pass.

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useAppStore } from '../store/useAppStore'
import { RobotSizeSetting } from '../components/RobotSizeSetting'
import type { ProviderType, NonSecretSettings, SecretName, ModelChoice, VoiceFallback, BuildyVoice } from '../types'
import {
  BUILDY_VOICES, DEFAULT_BUILDY_VOICE,
  HOURLY_CALL_CAP_MIN, HOURLY_CALL_CAP_MAX, NO_SECURE_STORAGE_MESSAGE, API_CREDITS_NOTE, PROVIDER_BILLING_URLS,
  dataDestinationNote, suggestsNextModel,
} from '../types'
import { DEFAULT_VOICE_ID, ELEVENLABS_VOICES, voiceLabel } from '../voice-options'

// IPC errors arrive wrapped ("Error invoking remote method ...: Error: <msg>").
// Show the clean, user-facing message when we recognise it.
function friendlySaveError(error: unknown): string {
  const text = String(error)
  if (text.includes(NO_SECURE_STORAGE_MESSAGE)) return NO_SECURE_STORAGE_MESSAGE
  return "Couldn't save your settings. Try again, or restart MyBuildy."
}

const CHECK_FAILED_MESSAGE = 'Something went wrong. Try again, or try the next recommended model.'
const MODEL_LIST_FAILED_MESSAGE = "Couldn't load the model list. Check your key and internet connection, then Refresh."


// Which encrypted secret holds the API key for a provider (local providers: none).
function secretNameForProvider(p: ProviderType): SecretName | null {
  switch (p) {
    case 'anthropic': return 'anthropicApiKey'
    case 'openai': return 'openaiApiKey'
    case 'gemini': return 'geminiApiKey'
    case 'openrouter': return 'openrouterApiKey'
    case 'custom': return 'customApiKey'
    default: return null
  }
}

// ─── Provider metadata (no models, no default model — lists are live) ────────

interface ProviderMeta {
  type: ProviderType
  displayName: string
  description: string
  needsApiKey: boolean       // cloud providers: key required
  optionalApiKey?: boolean   // custom endpoint: key optional
  needsBaseUrl: boolean
  defaultBaseUrl: string
  keyHint?: string
  notYetTested?: boolean     // works in code, not yet tested against the live API
}

const RECOMMENDED_PROVIDERS: ProviderMeta[] = [
  {
    type: 'anthropic', displayName: 'Anthropic',
    description: 'Claude models via the Anthropic API.',
    needsApiKey: true, needsBaseUrl: false, defaultBaseUrl: '',
    keyHint: 'Get yours at console.anthropic.com.',
  },
  {
    type: 'openai', displayName: 'OpenAI',
    description: 'GPT models via the OpenAI API.',
    needsApiKey: true, needsBaseUrl: false, defaultBaseUrl: '',
    keyHint: 'Get yours at platform.openai.com.',
  },
  {
    type: 'openrouter', displayName: 'OpenRouter',
    description: 'Open-source and other models, one key.',
    needsApiKey: true, needsBaseUrl: false, defaultBaseUrl: '',
    keyHint: 'Get yours at openrouter.ai/keys.',
  },
]

const ADVANCED_PROVIDERS: ProviderMeta[] = [
  {
    type: 'gemini', displayName: 'Google Gemini',
    description: 'Gemini models via the Google AI API.',
    needsApiKey: true, needsBaseUrl: false, defaultBaseUrl: '',
    keyHint: 'Get yours at aistudio.google.com.',
    notYetTested: true,
  },
  {
    type: 'ollama', displayName: 'Ollama',
    description: 'Local models via Ollama. Free, runs on this computer.',
    needsApiKey: false, needsBaseUrl: true, defaultBaseUrl: 'http://localhost:11434',
  },
  {
    type: 'lmstudio', displayName: 'LM Studio',
    description: 'Local models via LM Studio. Free, runs on this computer.',
    needsApiKey: false, needsBaseUrl: true, defaultBaseUrl: 'http://localhost:1234/v1',
  },
  {
    type: 'custom', displayName: 'Custom Endpoint',
    description: 'Any OpenAI-compatible API. Bring your own URL.',
    needsApiKey: false, optionalApiKey: true, needsBaseUrl: true, defaultBaseUrl: 'http://localhost:8080/v1',
  },
]

const ALL_PROVIDERS = [...RECOMMENDED_PROVIDERS, ...ADVANCED_PROVIDERS]

function getProviderMeta(type: ProviderType): ProviderMeta {
  return ALL_PROVIDERS.find((p) => p.type === type) ?? RECOMMENDED_PROVIDERS[0]
}

/** Host of a saved endpoint, or null when it isn't a usable URL. */
function endpointHost(url: string): string | null {
  try { return new URL(url).host || null } catch { return null }
}

function isLocalProvider(type: ProviderType): boolean {
  return type === 'ollama' || type === 'lmstudio' || type === 'custom'
}

function formatPrice(perM: number | null | undefined): string | null {
  if (perM == null || !Number.isFinite(perM)) return null
  const rounded = perM >= 10 ? perM.toFixed(0) : perM >= 1 ? perM.toFixed(2) : perM.toFixed(3)
  return `$${rounded}`
}

// ─── Component ───────────────────────────────────────────────────────────────

export function SettingsScreen(): React.ReactElement {
  const { settings, setSettings } = useAppStore()

  const [provider, setProvider] = useState<ProviderType>(settings.provider)
  const [modelId, setModelId] = useState(settings.modelId)
  // API keys are write-only from the renderer: a blank input keeps the stored key.
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [replacingKey, setReplacingKey] = useState(false)
  const [elevenKeyInput, setElevenKeyInput] = useState('')
  const [replacingElevenKey, setReplacingElevenKey] = useState(false)
  // Buildy's voice: Female voice (Bella) or Male voice (Puck), saved at once (used from the next sentence), and a sample of each.
  const [samplePlaying, setSamplePlaying] = useState<BuildyVoice | null>(null)
  const [sampleMessage, setSampleMessage] = useState<string | null>(null)
  async function chooseBuildyVoice(voice: BuildyVoice): Promise<void> {
    setSettings({ ...useAppStore.getState().settings, buildyVoice: voice }) // shown at once
    await window.mybuildy.setBuildyVoice(voice)
  }
  async function playBuildyVoiceSample(voice: BuildyVoice): Promise<void> {
    setSampleMessage(null)
    setSamplePlaying(voice)
    try {
      const played = await window.mybuildy.playVoiceSample(voice)
      if (!played) setSampleMessage("Buildy's voice can't play right now — see the message above.")
    } finally {
      setTimeout(() => setSamplePlaying(null), 1500)
    }
  }

  // ElevenLabs failed and the computer's voice is speaking: say so here too.
  const [voiceFallback, setVoiceFallback] = useState<VoiceFallback | null>(null)
  useEffect(() => {
    void window.mybuildy.getVoiceFallback().then(setVoiceFallback)
    return window.mybuildy.onVoiceFallback(setVoiceFallback)
  }, [])
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [typedModelId, setTypedModelId] = useState('')
  const [elevenLabsVoiceId, setElevenLabsVoiceId] = useState(settings.elevenLabsVoiceId ?? DEFAULT_VOICE_ID)
  const [hourlyCallCap, setHourlyCallCap] = useState(settings.hourlyCallCap)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(isLocalProvider(settings.provider) || getProviderMeta(settings.provider).notYetTested === true)
  const [showAllModels, setShowAllModels] = useState(false)
  const [triedModels, setTriedModels] = useState<string[]>([])
  const [models, setModels] = useState<ModelChoice[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [visionPassed, setVisionPassed] = useState<boolean | null>(null)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; errorKind: string | null } | null>(null)
  const [isTesting, setIsTesting] = useState(false)
  // Delete-all-data flow (privacy): confirm → wipe in main → app restarts.
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [isWiping, setIsWiping] = useState(false)
  const [wipeError, setWipeError] = useState<string | null>(null)

  const meta = getProviderMeta(provider)

  // Is a key already stored (encrypted in main) for the selected provider?
  const providerSecret = secretNameForProvider(provider)
  const keySaved = providerSecret ? !!settings.secretFlags[providerSecret] : false

  // Sync non-secret local state when store settings change (never the key inputs).
  useEffect(() => {
    setProvider(settings.provider)
    setModelId(settings.modelId)
    setBaseUrl(settings.baseUrl)
    setElevenLabsVoiceId(settings.elevenLabsVoiceId ?? DEFAULT_VOICE_ID)
    setHourlyCallCap(settings.hourlyCallCap)
  }, [settings])

  // ─── Live model list ─────────────────────────────────────────────────────

  const fetchSeq = useRef(0)
  const loadModels = useCallback(async (p: ProviderType, url: string) => {
    const seq = ++fetchSeq.current
    setModelsLoading(true)
    setModelsError(null)
    try {
      const result = await window.mybuildy.listModels(p, url.trim())
      if (seq !== fetchSeq.current) return // stale fetch
      setModels(result.models)
      setModelsError(result.error)
    } catch (error) {
      if (seq !== fetchSeq.current) return
      setModels([])
      setModelsError(MODEL_LIST_FAILED_MESSAGE)
    } finally {
      if (seq === fetchSeq.current) setModelsLoading(false)
    }
  }, [])

  // A keyed provider with no saved key would answer 401 — shown as "Your API
  // key was rejected" to someone who never entered one. Don't ask until a key
  // is saved; the empty-list hint says what to do instead.
  const refreshModels = useCallback((): void => {
    if (meta.needsApiKey && !keySaved) {
      fetchSeq.current++ // drop any in-flight fetch for the previous provider
      setModels([])
      setModelsError(null)
      setModelsLoading(false)
      return
    }
    void loadModels(provider, baseUrl)
  }, [meta.needsApiKey, keySaved, loadModels, provider, baseUrl])

  // Fetch on mount + whenever provider or stored-key state changes.
  useEffect(() => {
    refreshModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, keySaved])

  // Vision-gate status for the currently selected model.
  useEffect(() => {
    let cancelled = false
    setVisionPassed(null)
    const effective = typedModelId.trim() || modelId
    if (!effective) return
    window.mybuildy.getVisionStatus(provider, effective)
      .then((r) => { if (!cancelled) setVisionPassed(r.passed) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [provider, modelId, typedModelId, settings.secretFlags])

  // ─── Save / test ─────────────────────────────────────────────────────────

  function clampCap(value: number): number {
    if (!Number.isFinite(value)) return settings.hourlyCallCap
    return Math.min(HOURLY_CALL_CAP_MAX, Math.max(HOURLY_CALL_CAP_MIN, Math.round(value)))
  }

  function buildNonSecret(overrides?: Partial<NonSecretSettings>): NonSecretSettings {
    return {
      provider,
      modelId: typedModelId.trim() || modelId,
      baseUrl: baseUrl.trim(),
      autoAnalysisIntervalSeconds: settings.autoAnalysisIntervalSeconds,
      elevenLabsVoiceId: elevenLabsVoiceId.trim() || DEFAULT_VOICE_ID,
      // Saved on its own when chosen (voice:buildy-voice-set); this keeps it as it is.
      buildyVoice: useAppStore.getState().settings.buildyVoice,
      hourlyCallCap: clampCap(hourlyCallCap),
      captureNoticeAccepted: settings.captureNoticeAccepted,
      ...overrides,
    }
  }

  // Persist non-secret settings + any newly-typed keys (one-way to encrypted store).
  async function persistAll(overrides?: Partial<NonSecretSettings>): Promise<void> {
    await window.mybuildy.saveSettings(buildNonSecret(overrides))
    if (providerSecret && apiKeyInput.trim()) {
      await window.mybuildy.setSecret(providerSecret, apiKeyInput.trim())
    }
    if (elevenKeyInput.trim()) {
      await window.mybuildy.setSecret('elevenLabsApiKey', elevenKeyInput.trim())
    }
    // Refresh the redacted view into the store, and clear the transient key inputs.
    const redacted = await window.mybuildy.loadSettings()
    setSettings(redacted)
    setApiKeyInput('')
    setElevenKeyInput('')
    setReplacingKey(false)
    setReplacingElevenKey(false)
    setSavedAt(new Date().toLocaleTimeString())
  }

  async function handleSave(): Promise<void> {
    setSaveError(null)
    try {
      await persistAll()
    } catch (error) {
      setSaveError(friendlySaveError(error))
    }
  }

  async function confirmLegacyKey(): Promise<void> {
    await window.mybuildy.confirmCustomKeyEndpoint()
    setSettings(await window.mybuildy.loadSettings())
  }

  async function removeStoredKey(name: SecretName): Promise<void> {
    await window.mybuildy.setSecret(name, '') // empty value deletes the secret
    const redacted = await window.mybuildy.loadSettings()
    setSettings(redacted)
    setVisionPassed(null)
  }

  // The vision check IS the connection test: red image → the model must say "red".
  async function runVisionCheck(overrides?: Partial<NonSecretSettings>): Promise<void> {
    setIsTesting(true)
    setTestResult(null)
    setSaveError(null)
    try {
      await persistAll(overrides) // the check runs in main with the STORED key
      const result = await window.mybuildy.testConnection(buildNonSecret(overrides))
      setTestResult({ success: result.success, message: result.message, errorKind: result.errorKind })
      setVisionPassed(result.visionPassed)
    } catch (error) {
      const text = String(error)
      setTestResult({
        success: false,
        message: text.includes(NO_SECURE_STORAGE_MESSAGE) ? NO_SECURE_STORAGE_MESSAGE : CHECK_FAILED_MESSAGE,
        errorKind: 'unknown',
      })
    } finally {
      setIsTesting(false)
    }
  }

  // Delete all MyBuildy data: keys, settings, every project's memory — then the
  // app relaunches to first run. Main performs the wipe (main-window-only IPC).
  async function handleDeleteAllData(): Promise<void> {
    setIsWiping(true)
    setWipeError(null)
    try {
      await window.mybuildy.deleteAllData()
      // The app restarts here — nothing more to do on success.
    } catch (error) {
      setIsWiping(false)
      setConfirmWipe(false)
      setWipeError(String(error))
    }
  }

  // Selecting a model saves it and automatically runs the vision check.
  async function selectModel(id: string): Promise<void> {
    setTriedModels((t) => (t.includes(id) ? t : [...t, id]))
    setModelId(id)
    setTypedModelId('')
    await runVisionCheck({ modelId: id })
  }

  function handleProviderChange(newProvider: ProviderType): void {
    const newMeta = getProviderMeta(newProvider)
    setProvider(newProvider)
    setModelId('') // nothing pre-selected — the user picks from the live list
    setBaseUrl(newMeta.needsBaseUrl ? newMeta.defaultBaseUrl : '')
    setTypedModelId('')
    setApiKeyInput('')
    setReplacingKey(false)
    setTestResult(null)
    setVisionPassed(null)
    setModels([])
    setShowAllModels(false)
    setTriedModels([])
  }

  // ─── Validation ──────────────────────────────────────────────────────────

  const hasApiKey = !meta.needsApiKey || keySaved || apiKeyInput.trim().length > 0
  const hasBaseUrl = !meta.needsBaseUrl || baseUrl.trim().startsWith('http')
  const effectiveModelId = typedModelId.trim() || modelId
  const configuredCorrectly = hasApiKey && hasBaseUrl && effectiveModelId.length > 0

  const showKeyField = meta.needsApiKey || meta.optionalApiKey
  const showTypedModelInput = isLocalProvider(provider)

  // Curated (live-tested) models by default; the rest behind "Show all".
  const curatedModels = models.filter((m) => m.curated)
  const shownModels = curatedModels.length === 0 || showAllModels ? models : curatedModels
  const nextRecommended = curatedModels.find((m) => !triedModels.includes(m.id)) ?? null
  const billingUrl = PROVIDER_BILLING_URLS[provider]

  // Group the model list (OpenRouter groups; others come back ungrouped).
  const groupNames: string[] = []
  for (const m of shownModels) {
    const g = m.group ?? ''
    if (!groupNames.includes(g)) groupNames.push(g)
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.headerTitle}>Settings</div>
        <div style={styles.headerSub}>Choose your AI provider and model.</div>
      </div>

      <div style={styles.content}>
        {/* Recommended providers */}
        <div style={styles.section}>
          <div style={styles.sectionLabel}>Recommended providers</div>
          <div style={styles.providerGrid}>
            {RECOMMENDED_PROVIDERS.map((p) => (
              <ProviderCard key={p.type} meta={p} active={provider === p.type} onClick={() => handleProviderChange(p.type)} />
            ))}
          </div>
        </div>

        {/* Advanced: local providers (collapsed by default) */}
        <div style={styles.section}>
          <button style={styles.advancedToggle} onClick={() => setShowAdvanced(!showAdvanced)}>
            <span style={{ display: 'inline-block', transform: showAdvanced ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▸</span>
            {' '}Advanced: more providers and local models
          </button>
          {showAdvanced && (
            <div style={styles.providerGrid}>
              {ADVANCED_PROVIDERS.map((p) => (
                <ProviderCard key={p.type} meta={p} active={provider === p.type} onClick={() => handleProviderChange(p.type)} local={isLocalProvider(p.type)} />
              ))}
            </div>
          )}
        </div>

        {/* API key (cloud providers; optional for custom endpoints) */}
        {showKeyField && (
          <div style={styles.section}>
            <div style={styles.sectionLabel}>
              API Key{meta.optionalApiKey ? ' (optional)' : ''}
            </div>
            {meta.keyHint && <div style={styles.sectionHint}>{meta.keyHint}</div>}
            {meta.needsApiKey && <div style={styles.creditsNote} data-testid="credits-note">{API_CREDITS_NOTE}</div>}
            {keySaved && !replacingKey ? (
              <div style={styles.keySavedRow}>
                <span style={styles.keySavedBadge}>Saved</span>
                <span style={styles.sectionHint}>Key stored encrypted on this device — never shown.</span>
                <button className="btn-icon" onClick={() => { setReplacingKey(true); setApiKeyInput('') }}>Replace</button>
                <button className="btn-icon" onClick={() => { if (providerSecret) void removeStoredKey(providerSecret) }}>Remove</button>
              </div>
            ) : null}
            {provider === 'custom' && settings.customKeyNeedsEndpoint && !replacingKey && (
              // A key saved by an earlier version isn't linked to an endpoint, so
              // it is NOT used until the user says which endpoint it belongs to.
              <div style={styles.sectionHint}>
                This key was saved by an earlier version and isn't linked to an endpoint yet, so it isn't being used.
                {endpointHost(settings.baseUrl) ? ` Use it for ${endpointHost(settings.baseUrl)}?` : ' Save the endpoint below first.'}
                {endpointHost(settings.baseUrl) && (
                  <button className="btn-icon" onClick={() => { void confirmLegacyKey() }}>Use it for this endpoint</button>
                )}
              </div>
            )}
            {(!keySaved || replacingKey) && (
              <div style={styles.inputWrapper}>
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="Paste your API key here"
                  style={styles.textInput}
                />
                {keySaved && (
                  <button className="btn-icon" onClick={() => { setReplacingKey(false); setApiKeyInput('') }}>Cancel</button>
                )}
              </div>
            )}
            {window.mybuildy.platform === 'darwin' && (
              // Explain the Keychain prompt BEFORE it appears, so it never
              // looks like it came from nowhere.
              <div style={styles.sectionHint}>
                On a Mac your keys are encrypted with the macOS Keychain. macOS may ask
                whether MyBuildy can use the &quot;MyBuildy Safe Storage&quot; keychain item
                (on first save, or after reinstalling). Choose Always Allow.
              </div>
            )}
          </div>
        )}

        {/* Base URL (local providers + custom endpoints only) */}
        {meta.needsBaseUrl && (
          <div style={styles.section}>
            <div style={styles.sectionLabel}>Base URL</div>
            <div style={styles.sectionHint}>
              {provider === 'ollama' && 'Default: http://localhost:11434 — make sure Ollama is running.'}
              {provider === 'lmstudio' && 'Default: http://localhost:1234/v1 — make sure the LM Studio server is running.'}
              {provider === 'custom' && 'Enter the base URL of your OpenAI-compatible API endpoint.'}
            </div>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={() => void loadModels(provider, baseUrl)}
              placeholder={meta.defaultBaseUrl}
              style={styles.textInput}
            />
          </div>
        )}

        {/* Model (live list — nothing pre-selected) */}
        <div style={styles.section}>
          <div style={styles.modelHeaderRow}>
            <div style={styles.sectionLabel}>Model</div>
            <button className="btn-icon" onClick={refreshModels} disabled={modelsLoading}>
              {modelsLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
          {!modelsLoading && models.length === 0 && !modelsError && (
            <div style={styles.sectionHint}>
              {meta.needsApiKey && !keySaved
                ? 'Save your API key to load the live model list.'
                : 'No models found. Check your setup, then Refresh.'}
            </div>
          )}
          {modelsError && <div style={styles.modelsError}>{modelsError}</div>}
          {models.length > 0 && (
            <div style={styles.modelList}>
              {groupNames.map((group) => (
                <React.Fragment key={group || 'ungrouped'}>
                  {group && <div style={styles.groupLabel}>{group}</div>}
                  {shownModels.filter((m) => (m.group ?? '') === group).map((m) => {
                    const inPrice = formatPrice(m.promptPricePerM)
                    const outPrice = formatPrice(m.completionPricePerM)
                    const active = modelId === m.id && !typedModelId.trim()
                    return (
                      <button
                        key={m.id}
                        onClick={() => void selectModel(m.id)}
                        style={{
                          ...styles.modelRow,
                          ...(active ? styles.modelRowActive : styles.modelRowInactive),
                        }}
                      >
                        <div style={styles.modelTopRow}>
                          <div style={styles.modelRowLeft}>
                            <span style={styles.modelLabel}>{m.label}</span>
                            {m.suggested && (
                              <span style={{ ...styles.badge, borderColor: 'var(--color-success)', color: 'var(--color-success)' }}>
                                Suggested
                              </span>
                            )}
                            {active && visionPassed === true && (
                              <span style={{ ...styles.badge, borderColor: 'var(--color-success)', color: 'var(--color-success)' }}>
                                Vision check passed
                              </span>
                            )}
                          </div>
                          <span style={styles.modelId}>{m.id}</span>
                        </div>
                        {(inPrice || outPrice) && (
                          <div style={styles.modelPrice}>
                            {inPrice ? `${inPrice}/M in` : ''}{inPrice && outPrice ? ' · ' : ''}{outPrice ? `${outPrice}/M out` : ''}
                          </div>
                        )}
                      </button>
                    )
                  })}
                </React.Fragment>
              ))}
            </div>
          )}
          {curatedModels.length > 0 && models.length > curatedModels.length && (
            <button className="btn-icon" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAllModels(!showAllModels)}>
              {showAllModels ? 'Show recommended only' : `Show all ${models.length} models`}
            </button>
          )}
          {/* Free-typed model name for local/custom servers whose list may be incomplete */}
          {showTypedModelInput && (
            <div style={{ marginTop: 6 }}>
              <div style={styles.sectionHint}>Or type a model name (it still has to pass the vision check):</div>
              <input
                type="text"
                value={typedModelId}
                onChange={(e) => setTypedModelId(e.target.value)}
                placeholder="e.g. my-vision-model"
                style={styles.textInput}
              />
            </div>
          )}
        </div>

        {/* Vision-gate note */}
        {effectiveModelId && visionPassed === false && !isTesting && (
          <div style={styles.warningBox}>
            <div style={styles.warningTitle}>Vision check required</div>
            <div style={styles.warningText}>
              Watching your screen is only enabled after this model passes the vision check
              (it must correctly read a test image). Brainstorming (text-only) works either way.
            </div>
          </div>
        )}

        {/* Cost guard */}
        <div style={styles.section}>
          <div style={styles.sectionLabel}>Usage limit</div>
          <div style={styles.sectionHint}>
            The most AI requests MyBuildy will make in any one hour ({HOURLY_CALL_CAP_MIN}–{HOURLY_CALL_CAP_MAX}).
            Each one is billed to your key. Watching pauses when the limit is reached.
          </div>
          <input
            type="number"
            min={HOURLY_CALL_CAP_MIN}
            max={HOURLY_CALL_CAP_MAX}
            value={hourlyCallCap}
            onChange={(e) => setHourlyCallCap(Number(e.target.value))}
            onBlur={() => setHourlyCallCap(clampCap(hourlyCallCap))}
            style={{ ...styles.textInput, maxWidth: 120 }}
          />
        </div>

        {/* Voice: Buildy's own voice (Female voice by default, or Male voice); ElevenLabs optional */}
        <div style={styles.section}>
          <div style={styles.sectionLabel}>Voice</div>
          <div style={styles.voiceOptionLabel}>Buildy&apos;s voice</div>
          <div style={styles.voiceDefault} data-testid="voice-default">
            {settings.hasElevenLabsKey
              ? 'Free, on your computer. Speaks if ElevenLabs stops working.'
              : 'Free, on your computer. Nothing to set up.'}
          </div>
          <div role="radiogroup" aria-label="Buildy's voice" style={styles.voiceChoices}>
            {BUILDY_VOICES.map((v) => (
              <div key={v.id} style={styles.voiceChoiceRow}>
                <label style={styles.voiceChoiceLabel}>
                  <input
                    type="radio"
                    name="buildy-voice"
                    checked={(settings.buildyVoice ?? DEFAULT_BUILDY_VOICE) === v.id}
                    onChange={() => { void chooseBuildyVoice(v.id) }}
                  />
                  {v.label}{v.id === DEFAULT_BUILDY_VOICE ? ' — default' : ''}
                </label>
                <button
                  className="btn-ghost"
                  onClick={() => { void playBuildyVoiceSample(v.id) }}
                  disabled={samplePlaying !== null}
                  aria-label={`Play sample: ${v.name}`}
                >
                  {samplePlaying === v.id ? 'Playing…' : 'Play sample'}
                </button>
              </div>
            ))}
          </div>
          {sampleMessage && <div style={styles.sectionHint} role="status">{sampleMessage}</div>}
          {voiceFallback && (
            <div style={styles.voiceFallback} role="alert" data-testid="settings-voice-fallback">
              <strong>{voiceFallback.headline}.</strong> {voiceFallback.reason}
            </div>
          )}
          <div style={styles.voiceOptionLabel}>ElevenLabs (your own key) — optional</div>
          <div style={styles.sectionHint}>
            With a key, MyBuildy speaks with the ElevenLabs voice you choose here, and the mic button appears.
          </div>
          {settings.hasElevenLabsKey && !replacingElevenKey ? (
            <div style={styles.keySavedRow}>
              <span style={styles.keySavedBadge}>Saved</span>
              <span style={styles.sectionHint}>ElevenLabs key stored encrypted — never shown.</span>
              <button className="btn-icon" onClick={() => { setReplacingElevenKey(true); setElevenKeyInput('') }}>Replace</button>
              <button className="btn-icon" onClick={() => void removeStoredKey('elevenLabsApiKey')}>Remove</button>
            </div>
          ) : (
            <div style={styles.inputWrapper}>
              <input
                type="password"
                value={elevenKeyInput}
                onChange={(e) => setElevenKeyInput(e.target.value)}
                placeholder="ElevenLabs API key"
                style={styles.textInput}
              />
              {settings.hasElevenLabsKey && (
                <button className="btn-icon" onClick={() => { setReplacingElevenKey(false); setElevenKeyInput('') }}>Cancel</button>
              )}
            </div>
          )}
          {/* Chosen by name; the ElevenLabs voice ID itself is never shown. */}
          <select
            aria-label="Voice"
            value={elevenLabsVoiceId}
            onChange={(e) => setElevenLabsVoiceId(e.target.value)}
            style={styles.textInput}
          >
            {!ELEVENLABS_VOICES.some((v) => v.id === elevenLabsVoiceId) && (
              <option value={elevenLabsVoiceId}>{voiceLabel(elevenLabsVoiceId)}</option>
            )}
            {ELEVENLABS_VOICES.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>

        {/* Status */}
        <div style={styles.section}>
          <div style={styles.statusRow}>
            <span
              style={{
                ...styles.statusDot,
                background: configuredCorrectly ? 'var(--color-success)' : 'var(--color-danger)',
              }}
            />
            <span style={styles.statusText}>
              {configuredCorrectly
                ? `Ready — ${meta.displayName} / ${effectiveModelId}`
                : effectiveModelId
                  ? 'Fill in the required fields above to use MyBuildy'
                  : 'Choose a model in Settings — pick one from the list above'}
            </span>
          </div>
        </div>

        {/* Save + Test buttons */}
        <div style={styles.saveRow}>
          <button className="btn-primary" onClick={() => void handleSave()} style={{ flex: 1, justifyContent: 'center' }}>
            Save Settings
          </button>
          <button
            className="btn-primary"
            onClick={() => void runVisionCheck()}
            disabled={isTesting || !configuredCorrectly}
            style={{ flex: 1, justifyContent: 'center', opacity: isTesting ? 0.6 : 1 }}
          >
            {isTesting ? 'Checking vision…' : 'Test Connection'}
          </button>
        </div>
        {savedAt && !saveError && <span style={styles.savedAt}>Saved at {savedAt}</span>}
        {saveError && <div style={styles.modelsError}>{saveError}</div>}
        {testResult && (
          <div style={{
            ...styles.statusRow,
            borderLeft: `3px solid ${testResult.success ? 'var(--color-success)' : 'var(--color-danger)'}`,
          }}>
            <span style={{
              ...styles.statusDot,
              background: testResult.success ? 'var(--color-success)' : 'var(--color-danger)',
            }} />
            <span style={styles.statusText}>{testResult.message}</span>
          </div>
        )}
        {testResult && !testResult.success && !isTesting && (
          <div style={styles.saveRow}>
            {testResult.errorKind === 'billing' && billingUrl && (
              <a href={billingUrl} target="_blank" rel="noreferrer" className="btn-primary" style={{ flex: 1, justifyContent: 'center', textDecoration: 'none' }}>
                Open the billing page
              </a>
            )}
            {suggestsNextModel(testResult.errorKind) && nextRecommended && (
              <button className="btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => void selectModel(nextRecommended.id)}>
                Try the next recommended model
              </button>
            )}
          </div>
        )}

        {/* Info */}
        <div style={styles.infoSection}>
          <div style={styles.infoTitle}>About MyBuildy</div>
          <div style={styles.infoText}>
            MyBuildy — your AI coding agent, explained
          </div>
          <div style={styles.infoText}>
            {dataDestinationNote({
              provider,
              baseUrl,
              hasElevenLabsKey: !!settings.secretFlags?.elevenLabsApiKey,
            })}
          </div>
        </div>

        {/* Robot size: a 60%–200% slider and Reset (Ctrl or Cmd + scroll over the robot too) */}
        <div style={styles.section}>
          <div style={styles.sectionLabel}>Robot size</div>
          <div style={styles.sectionHint}>
            Makes the robot, its buttons and its text bigger or smaller together. You can also hold{" "}
            {window.mybuildy.platform === 'darwin' ? 'Cmd' : 'Ctrl'} and scroll over the robot.
          </div>
          <RobotSizeSetting />
        </div>

        {/* The guided first-run setup, again from the start */}
        <div style={styles.section}>
          <div style={styles.sectionLabel}>Setup</div>
          <div style={styles.sectionHint}>
            Walk through the guided setup again: your AI key, your model, what you want to build, and showing MyBuildy
            your coding agent.
          </div>
          <button
            className="btn-icon"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => {
              void (async () => {
                await window.mybuildy.setup.reset()
                const info = await window.mybuildy.setup.info()
                useAppStore.getState().setSetupWizard({ platform: info.platform, step: null })
              })()
            }}
          >
            Run setup again
          </button>
        </div>

        {/* Diagnostics: the local watch log a tester can send with a report */}
        <div style={styles.section}>
          <div style={styles.sectionLabel}>Diagnostics</div>
          <div style={styles.sectionHint}>
            MyBuildy keeps a small log of when watching starts, pauses or stops, and why, on this computer only.
            Window titles and screen text are left out. Send it along with a bug report.
          </div>
          <button className="btn-icon" style={{ alignSelf: 'flex-start' }} onClick={() => { void window.mybuildy.openLogFolder() }}>
            Open log folder
          </button>
        </div>

        {/* Danger zone: delete everything and restart to first run */}
        <div style={styles.section}>
          <div style={styles.sectionLabel}>Danger zone</div>
          <div style={styles.sectionHint}>
            Remove everything MyBuildy stores on this computer and start over.
          </div>
          <button
            onClick={() => { setWipeError(null); setConfirmWipe(true) }}
            style={styles.dangerOutlineBtn}
          >
            Delete all MyBuildy data
          </button>
          {wipeError && <div style={styles.modelsError}>{wipeError}</div>}
        </div>
      </div>

      {confirmWipe && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalCard}>
            <div style={styles.modalTitle}>Delete all MyBuildy data?</div>
            <div style={styles.modalText}>
              This deletes your keys — including your voice (ElevenLabs) key — your
              settings and all project memory from this computer. This cannot be
              undone. MyBuildy will restart as if freshly installed.
            </div>
            <div style={styles.modalButtons}>
              <button
                className="btn-ghost"
                onClick={() => setConfirmWipe(false)}
                disabled={isWiping}
                style={{ flex: 1, justifyContent: 'center' }}
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDeleteAllData()}
                disabled={isWiping}
                style={{ ...styles.dangerFillBtn, opacity: isWiping ? 0.6 : 1 }}
              >
                {isWiping ? 'Deleting…' : 'Delete everything'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Provider card ───────────────────────────────────────────────────────────

function ProviderCard({
  meta, active, onClick, local,
}: {
  meta: ProviderMeta
  active: boolean
  onClick: () => void
  local?: boolean
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      style={{
        ...styles.providerCard,
        ...(active ? styles.providerCardActive : styles.providerCardInactive),
      }}
    >
      <div style={styles.providerCardTitle}>{meta.displayName}</div>
      <div style={styles.providerCardDesc}>{meta.description}</div>
      {local && <div style={styles.localBadge}>Local</div>}
      {meta.notYetTested && <div style={styles.localBadge}>Not yet tested</div>}
    </button>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    overflow: 'hidden',
  },
  header: {
    padding: '12px 16px 8px',
    borderBottom: '1px solid var(--color-border)',
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--color-text)',
  },
  headerSub: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
    marginTop: 2,
  },
  content: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
  },
  section: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    color: 'var(--color-text-muted)',
  },
  sectionHint: {
    fontSize: 12,
    color: 'var(--color-text-dim)',
    lineHeight: 1.4,
  },
  creditsNote: {
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--color-text)',
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: 6,
    padding: '6px 10px',
  },
  advancedToggle: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left' as const,
    padding: '2px 0',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--color-text-muted)',
  },
  providerGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: 6,
  },
  providerCard: {
    padding: '10px 12px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid transparent',
    cursor: 'pointer',
    textAlign: 'left' as const,
    width: '100%',
    transition: 'background 0.1s, border-color 0.1s',
    position: 'relative' as const,
  },
  providerCardActive: {
    background: 'var(--color-accent-muted)',
    borderColor: 'var(--color-accent)',
    color: 'var(--color-text)',
  },
  providerCardInactive: {
    background: 'var(--color-surface)',
    borderColor: 'var(--color-border)',
    color: 'var(--color-text-muted)',
  },
  providerCardTitle: {
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 2,
  },
  providerCardDesc: {
    fontSize: 10,
    color: 'var(--color-text-dim)',
    lineHeight: 1.4,
  },
  localBadge: {
    position: 'absolute' as const,
    top: 6,
    right: 8,
    fontSize: 9,
    fontWeight: 600,
    color: 'var(--color-success)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  modelHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modelList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 3,
    maxHeight: 320,
    overflowY: 'auto' as const,
  },
  groupLabel: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: 'var(--color-text-muted)',
    padding: '6px 2px 2px',
  },
  modelsError: {
    fontSize: 12,
    color: 'var(--color-danger)',
    lineHeight: 1.4,
    padding: '6px 8px',
    background: 'rgba(255,69,58,0.08)',
    borderRadius: 'var(--radius-sm)',
  },
  modelRow: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 3,
    padding: '7px 10px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid transparent',
    cursor: 'pointer',
    textAlign: 'left' as const,
    width: '100%',
    transition: 'background 0.1s',
  },
  modelTopRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: 8,
  },
  modelPrice: {
    fontSize: 10.5,
    color: 'var(--color-text-muted)',
    lineHeight: 1.35,
  },
  modelRowActive: {
    background: 'var(--color-accent-muted)',
    borderColor: 'var(--color-accent)',
  },
  modelRowInactive: {
    background: 'var(--color-surface)',
    borderColor: 'var(--color-border)',
  },
  modelRowLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap' as const,
  },
  modelLabel: {
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--color-text)',
  },
  modelId: {
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-dim)',
    wordBreak: 'break-all' as const,
    textAlign: 'right' as const,
  },
  badge: {
    fontSize: 9,
    fontWeight: 600,
    padding: '1px 5px',
    borderRadius: 3,
    border: '1px solid',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.03em',
  },
  warningBox: {
    padding: '10px 12px',
    background: 'rgba(255, 170, 0, 0.08)',
    border: '1px solid var(--color-warning)',
    borderRadius: 'var(--radius-sm)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  warningTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--color-warning)',
  },
  warningText: {
    fontSize: 11,
    color: 'var(--color-text-dim)',
    lineHeight: 1.4,
  },
  textInput: {
    flex: 1,
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    width: '100%',
  } as React.CSSProperties,
  inputWrapper: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
  },
  keySavedRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap' as const,
  },
  voiceDefault: {
    fontSize: 13,
    lineHeight: 1.45,
    color: 'var(--color-text)',
    marginTop: 4,
    marginBottom: 8,
  },
  voiceChoices: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    marginBottom: 10,
  },
  voiceChoiceRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  voiceChoiceLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 13,
    color: 'var(--color-text)',
    cursor: 'pointer',
  },
  voiceOptionLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--color-text)',
    marginTop: 6,
  },
  voiceFallback: {
    marginTop: 6,
    marginBottom: 6,
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid var(--color-warning)',
    background: 'rgba(255, 159, 10, 0.08)',
    fontSize: 12,
    lineHeight: 1.45,
    color: 'var(--color-text)',
  },
  keySavedBadge: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    color: 'var(--color-success)',
    border: '1px solid var(--color-success)',
    borderRadius: 3,
    padding: '1px 6px',
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    background: 'var(--color-surface)',
    borderRadius: 'var(--radius-sm)',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  statusText: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
  },
  saveRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  savedAt: {
    fontSize: 11,
    color: 'var(--color-success)',
  },
  infoSection: {
    padding: '12px',
    background: 'var(--color-surface)',
    borderRadius: 'var(--radius-md)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  infoTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--color-text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: 2,
  },
  infoText: {
    fontSize: 11,
    color: 'var(--color-text-dim)',
    lineHeight: 1.5,
  },
  dangerOutlineBtn: {
    alignSelf: 'flex-start' as const,
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 12px',
    borderRadius: 'var(--radius-sm)',
    background: 'transparent',
    border: '1px solid var(--color-danger)',
    color: 'var(--color-danger)',
    cursor: 'pointer',
  },
  dangerFillBtn: {
    flex: 1,
    justifyContent: 'center',
    display: 'flex',
    alignItems: 'center',
    background: 'var(--color-danger)',
    color: '#fff',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  },
  modalOverlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 24,
  },
  modalCard: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-lg)',
    padding: 20,
    maxWidth: 360,
    width: '100%',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--color-text)',
    marginBottom: 8,
  },
  modalText: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
    lineHeight: 1.5,
    marginBottom: 16,
  },
  modalButtons: {
    display: 'flex',
    gap: 8,
  },
}
