// SetupWizard.tsx — the guided first-run setup, one step per screen.
//
// Shown by MainPanel (App.tsx) on first launch, until finished; Settings has
// "Run setup again". Every step change is saved in main (setup-state.ts), so a
// restart — the macOS Screen Recording step needs one — resumes right here.
// The steps, ready-made goals and commands are plain data in setup-model.ts.
//
// Deliberately NOT here: the microphone. It is asked for only the first time
// the user clicks the mic button.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LocalProvider, LocalServerStatus, ModelChoice, NonSecretSettings, ProviderType, RedactedSettings, SecretName, SetupPermissionStatus, WindowSource,
} from '../types'
import { API_CREDITS_NOTE, CAPTURE_NOTICE_MESSAGE, PROVIDER_BILLING_URLS, dataDestinationNote, suggestsNextModel } from '../types'
import { useAppStore } from '../store/useAppStore'
import { WindowPicker } from '../components/WindowPicker'
import { useRefreshWhileOpen } from '../components/useRefreshWhileOpen'
import {
  type SetupStepId, type KeyProvider, KEY_PROVIDERS, ADVANCED_KEY_PROVIDERS, NOT_YET_TESTED_LABEL, READY_GOALS, OWN_GOAL_EXAMPLE, CLAUDE_CODE_INSTALL_URL,
  setupSteps, progressLabel, resumeStep, nextStep, previousStep, doneWhenText, agentInstructions,
  LOCAL_SETUP_PROVIDERS, localServerGuidance, localModelGuidance, LOCAL_CHECKING_NOTE,
} from './setup-model'

const isLocalSetupProvider = (p: string): p is LocalProvider => p === 'ollama' || p === 'lmstudio'

const SECRET_FOR: Record<string, SecretName> = {
  anthropic: 'anthropicApiKey', openai: 'openaiApiKey', gemini: 'geminiApiKey', openrouter: 'openrouterApiKey',
}

function nonSecretFrom(s: RedactedSettings, overrides: Partial<NonSecretSettings> = {}): NonSecretSettings {
  return {
    provider: s.provider,
    modelId: s.modelId,
    baseUrl: s.baseUrl,
    autoAnalysisIntervalSeconds: s.autoAnalysisIntervalSeconds,
    elevenLabsVoiceId: s.elevenLabsVoiceId,
    buildyVoice: s.buildyVoice,
    hourlyCallCap: s.hourlyCallCap,
    captureNoticeAccepted: s.captureNoticeAccepted,
    ...overrides,
  }
}

export function SetupWizard({
  platform,
  savedStep,
  onFinished,
}: {
  platform: string
  savedStep: string | null
  onFinished: () => void
}): React.ReactElement {
  const steps = setupSteps(platform)
  const [step, setStep] = useState<SetupStepId>(() => resumeStep(steps, savedStep))
  const [canContinue, setCanContinue] = useState(false)
  const beforeNext = useRef<(() => Promise<boolean>) | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [watching, setWatching] = useState<string | null>(null)

  // Remember the step in main, so a restart resumes here. Each step sets its
  // own Next state and save action on mount (child effects run first, so the
  // wizard must not reset them here).
  useEffect(() => {
    void window.mybuildy.setup.saveStep(step)
    setError(null)
  }, [step])

  const allow = useCallback((ok: boolean) => setCanContinue(ok), [])
  const onBeforeNext = useCallback((fn: (() => Promise<boolean>) | null) => { beforeNext.current = fn }, [])

  async function goNext(): Promise<void> {
    setError(null)
    if (beforeNext.current) {
      setBusy(true)
      try {
        if (!(await beforeNext.current())) return
      } catch (e) {
        setError(String(e).replace(/^Error:\s*/, ''))
        return
      } finally {
        setBusy(false)
      }
    }
    setStep(nextStep(steps, step))
  }

  async function finish(): Promise<void> {
    await window.mybuildy.setup.finish()
    onFinished()
  }

  const shared = { allow, onBeforeNext, platform, skip: () => setStep(nextStep(steps, step)), onWatching: setWatching }

  return (
    <div style={S.root} data-testid="setup-wizard" data-step={step}>
      <div style={S.header} className="setup-header">
        <div style={S.progressText}>{progressLabel(steps, step)}</div>
        <div style={S.progressTrack}>
          <div style={{ ...S.progressFill, width: `${((steps.indexOf(step) + 1) / steps.length) * 100}%` }} />
        </div>
      </div>

      <div style={S.body}>
        {step === 'welcome' && <WelcomeStep onStart={() => setStep(nextStep(steps, step))} />}
        {step === 'key' && <KeyStep {...shared} />}
        {step === 'model' && <ModelStep {...shared} />}
        {step === 'screen' && <ScreenStep {...shared} />}
        {step === 'paste' && <PasteStep {...shared} />}
        {step === 'goal' && <GoalStep {...shared} />}
        {step === 'agent' && <AgentStep {...shared} />}
        {step === 'window' && <WindowStep {...shared} />}
        {step === 'done' && <DoneStep watching={watching} onFinish={() => void finish()} />}
        {error && <div style={S.error} role="alert">{error}</div>}
      </div>

      {step !== 'welcome' && step !== 'done' && (
        <div style={S.footer}>
          <button type="button" className="btn-secondary" style={S.bigBtn} onClick={() => setStep(previousStep(steps, step))}>
            Back
          </button>
          <button
            type="button"
            className="btn-primary"
            style={S.bigBtn}
            disabled={!canContinue || busy}
            onClick={() => void goNext()}
          >
            {busy ? 'One moment…' : 'Next'}
          </button>
        </div>
      )}
    </div>
  )
}

interface StepProps {
  allow: (ok: boolean) => void
  onBeforeNext: (fn: (() => Promise<boolean>) | null) => void
  platform: string
  skip: () => void
  onWatching: (windowName: string | null) => void
}

// ─── Welcome ──────────────────────────────────────────────────────────────────

function WelcomeStep({ onStart }: { onStart: () => void }): React.ReactElement {
  return (
    <div style={S.centered}>
      <h1 style={S.title}>Welcome to MyBuildy</h1>
      <p style={S.lead}>
        MyBuildy watches your AI coding agent and tells you, in plain English, what happened and what to type next.
      </p>
      <button type="button" className="btn-primary" style={S.heroBtn} onClick={onStart}>
        Let&apos;s set up (2 minutes)
      </button>
    </div>
  )
}

// ─── Your AI key ─────────────────────────────────────────────────────────────

// Two ways through this step: an AI key (cloud), or "Use a local model instead"
// (Ollama / LM Studio on this computer, no key). Each registers its own Next.
function KeyStep(props: StepProps): React.ReactElement {
  const provider = useAppStore((s) => s.settings.provider)
  const [local, setLocal] = useState(isLocalSetupProvider(provider))
  return local
    ? <LocalServerStep {...props} onUseKey={() => setLocal(false)} />
    : <CloudKeyStep {...props} onUseLocal={() => setLocal(true)} />
}

function CloudKeyStep({ allow, onBeforeNext, onUseLocal }: StepProps & { onUseLocal: () => void }): React.ReactElement {
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const allProviders = [...KEY_PROVIDERS, ...ADVANCED_KEY_PROVIDERS]
  const current = allProviders.find((p) => p.id === settings.provider) ?? null
  const [provider, setProvider] = useState<ProviderType | null>(current ? current.id : null)
  const [key, setKey] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(!!current?.notYetTested)
  const saved = !!provider && !!settings.secretFlags?.[SECRET_FOR[provider]]
  const meta = allProviders.find((p) => p.id === provider) ?? null

  useEffect(() => {
    allow(!!provider && (saved || key.trim().length >= 8))
    onBeforeNext(async () => {
      if (!provider) return false
      const changed = provider !== settings.provider
      await window.mybuildy.saveSettings(nonSecretFrom(settings, { provider, baseUrl: '', modelId: changed ? '' : settings.modelId }))
      if (key.trim()) await window.mybuildy.setSecret(SECRET_FOR[provider], key.trim())
      setSettings(await window.mybuildy.loadSettings())
      return true
    })
  }, [provider, key, saved, settings, allow, onBeforeNext, setSettings])

  const card = (p: KeyProvider): React.ReactElement => (
    <button
      key={p.id}
      type="button"
      onClick={() => { setProvider(p.id); setKey('') }}
      className={`setup-choice${provider === p.id ? ' is-on' : ''}`}
      aria-pressed={provider === p.id}
    >
      <div style={S.choiceTitle}>{p.label}</div>
      <div style={S.choiceSub}>{p.blurb}</div>
      {p.notYetTested && <div style={S.untested}>{NOT_YET_TESTED_LABEL}</div>}
    </button>
  )

  return (
    <div>
      <h2 style={S.stepTitle}>Your AI key</h2>
      <p style={S.text}>
        MyBuildy uses an AI service to understand your screen. Pick one and paste your key. It is saved encrypted on
        this computer and only ever sent to that service.
      </p>
      <p style={S.note} data-testid="credits-note">{API_CREDITS_NOTE}</p>
      <div style={S.cardGrid}>{KEY_PROVIDERS.map(card)}</div>
      <button type="button" className="btn-ghost" onClick={() => setShowAdvanced(!showAdvanced)} aria-expanded={showAdvanced}>
        {showAdvanced ? 'Hide more providers' : 'Advanced: more providers'}
      </button>
      {showAdvanced && <div style={S.cardGrid}>{ADVANCED_KEY_PROVIDERS.map(card)}</div>}
      {meta && (
        <div style={S.panel}>
          {saved && !key ? (
            <div style={S.okLine}>✓ Your {meta.label} key is saved. Paste a new one below only to replace it.</div>
          ) : null}
          <label style={S.label} htmlFor="setup-key">Your {meta.label} key</label>
          <input
            id="setup-key"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={meta.placeholder}
            style={S.input}
            autoComplete="off"
          />
          <a href={meta.keyUrl} target="_blank" rel="noreferrer" style={S.link}>
            Where do I get a key?
          </a>
        </div>
      )}
      <div style={S.localLink}>
        <button type="button" className="btn-ghost" onClick={onUseLocal} data-testid="use-local">
          Use a local model instead (Ollama or LM Studio)
        </button>
        <div style={S.small}>No key needed: the model runs on your computer.</div>
      </div>
    </div>
  )
}

// ─── Use a local model instead: which server ─────────────────────────────────

function useLocalDetection(): {
  statuses: Partial<Record<LocalProvider, LocalServerStatus>>
  checking: Partial<Record<LocalProvider, boolean>>
  detect: (p: LocalProvider) => Promise<LocalServerStatus | null>
} {
  const [statuses, setStatuses] = useState<Partial<Record<LocalProvider, LocalServerStatus>>>({})
  const [checking, setChecking] = useState<Partial<Record<LocalProvider, boolean>>>({})
  const detect = useCallback(async (p: LocalProvider): Promise<LocalServerStatus | null> => {
    setChecking((c) => ({ ...c, [p]: true }))
    try {
      const st = await window.mybuildy.setup.detectLocal(p)
      setStatuses((s) => ({ ...s, [p]: st }))
      return st
    } catch {
      const st: LocalServerStatus = { provider: p, running: false, baseUrl: '', models: [] }
      setStatuses((s) => ({ ...s, [p]: st }))
      return st
    } finally {
      setChecking((c) => ({ ...c, [p]: false }))
    }
  }, [])
  return { statuses, checking, detect }
}

function LocalServerStep({ allow, onBeforeNext, onUseKey }: StepProps & { onUseKey: () => void }): React.ReactElement {
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const [provider, setProvider] = useState<LocalProvider | null>(isLocalSetupProvider(settings.provider) ? settings.provider : null)
  const { statuses, checking, detect } = useLocalDetection()
  const started = useRef(false)

  // Look for both servers straight away, so each card says whether it is running.
  useEffect(() => {
    if (started.current) return
    started.current = true
    void detect('ollama')
    void detect('lmstudio')
  }, [detect])

  const status = provider ? statuses[provider] : undefined
  const busy = provider ? !!checking[provider] : false

  useEffect(() => {
    allow(!!provider && !!status?.running && !busy)
    onBeforeNext(async () => {
      if (!provider || !status?.running) return false
      const same = provider === settings.provider && status.baseUrl === settings.baseUrl
      await window.mybuildy.saveSettings(nonSecretFrom(settings, { provider, baseUrl: status.baseUrl, modelId: same ? settings.modelId : '' }))
      setSettings(await window.mybuildy.loadSettings())
      return true
    })
  }, [provider, status, busy, settings, allow, onBeforeNext, setSettings])

  const meta = LOCAL_SETUP_PROVIDERS.find((p) => p.id === provider) ?? null
  const guidance = status ? localServerGuidance(status) : null

  return (
    <div>
      <h2 style={S.stepTitle}>Use a model on this computer</h2>
      <p style={S.text}>
        No key needed. The model runs on your computer, so your screenshots and project memory stay on it. Your
        computer needs to be powerful enough to run a model that can read images.
      </p>
      <div style={S.cardGrid}>
        {LOCAL_SETUP_PROVIDERS.map((p) => {
          const st = statuses[p.id]
          const isChecking = !!checking[p.id] || !st
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => { setProvider(p.id); void detect(p.id) }}
              className={`setup-choice${provider === p.id ? ' is-on' : ''}`}
              aria-pressed={provider === p.id}
            >
              <div style={S.choiceTitle}>{p.label}</div>
              <div style={S.choiceSub}>{p.blurb}</div>
              <div
                style={st?.running && !isChecking ? S.localOk : S.untested}
                data-testid={`local-status-${p.id}`}
                data-running={isChecking ? 'checking' : String(!!st?.running)}
              >
                {isChecking ? 'Checking…' : st?.running ? '● Running' : 'Not running'}
              </div>
            </button>
          )
        })}
      </div>
      {meta && guidance && !busy && <div style={S.error} role="status" data-testid="local-guidance">{guidance}</div>}
      {meta && (
        <div style={S.actionRow}>
          <button type="button" className="btn-secondary" onClick={() => void detect(meta.id)} disabled={busy}>
            {busy ? 'Checking…' : 'Check again'}
          </button>
          {status && !status.running && (
            <a href={meta.site} target="_blank" rel="noreferrer" className="btn-ghost" style={S.actionLink}>
              Get {meta.label}
            </a>
          )}
        </div>
      )}
      <button type="button" className="btn-ghost" onClick={onUseKey} style={S.skipLink}>
        Use an AI key instead
      </button>
    </div>
  )
}

// ─── Your model ──────────────────────────────────────────────────────────────

const CHECK_FAILED_MESSAGE = 'Something went wrong. Try again, or try the next recommended model.'

function ModelStep(props: StepProps): React.ReactElement {
  const provider = useAppStore((s) => s.settings.provider)
  return isLocalSetupProvider(provider) ? <LocalModelStep {...props} provider={provider} /> : <CloudModelStep {...props} />
}

// ─── Use a local model instead: which model ──────────────────────────────────

function LocalModelStep({ allow, onBeforeNext, provider }: StepProps & { provider: LocalProvider }): React.ReactElement {
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const { statuses, checking: detecting, detect } = useLocalDetection()
  const status = statuses[provider] ?? null
  const [chosen, setChosen] = useState<string>(settings.modelId)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const started = useRef(false)
  const label = LOCAL_SETUP_PROVIDERS.find((p) => p.id === provider)?.label ?? provider

  const check = useCallback(async (modelId: string): Promise<void> => {
    setChosen(modelId)
    setChecking(true)
    setResult(null)
    try {
      const s = useAppStore.getState().settings
      await window.mybuildy.saveSettings(nonSecretFrom(s, { modelId }))
      const r = await window.mybuildy.testConnection(nonSecretFrom(s, { modelId }))
      setResult({ ok: r.visionPassed, message: r.visionPassed ? 'This model can see your screen.' : r.message })
      setSettings(await window.mybuildy.loadSettings())
    } catch {
      setResult({ ok: false, message: CHECK_FAILED_MESSAGE })
    } finally {
      setChecking(false)
    }
  }, [setSettings])

  // Look again (on arrival and on Check again); the server may have moved.
  const look = useCallback(async (autoCheck: boolean): Promise<void> => {
    const st = await detect(provider)
    if (!st) return
    const s = useAppStore.getState().settings
    if (st.running && st.baseUrl !== s.baseUrl) {
      await window.mybuildy.saveSettings(nonSecretFrom(s, { baseUrl: st.baseUrl }))
      setSettings(await window.mybuildy.loadSettings())
    }
    if (!autoCheck || !st.running) return
    const current = useAppStore.getState().settings.modelId
    if (current && st.models.some((m) => m.id === current) && (await window.mybuildy.getVisionStatus(provider, current)).passed) {
      setResult({ ok: true, message: 'This model can see your screen.' })
      return
    }
    const first = st.models.find((m) => m.vision === 'yes')
    if (first) await check(first.id)
  }, [detect, provider, check, setSettings])

  useEffect(() => {
    if (started.current) return
    started.current = true
    void look(true)
  }, [look])

  useEffect(() => {
    allow(!!result?.ok && !checking)
    onBeforeNext(null)
  }, [result, checking, allow, onBeforeNext])

  const serverGuidance = status ? localServerGuidance(status) : null
  const modelGuidance = status ? localModelGuidance(status) : null
  const busy = !!detecting[provider]

  return (
    <div>
      <h2 style={S.stepTitle}>Your model</h2>
      <p style={S.text}>
        Pick a model from {label}. MyBuildy needs one that can read images, and checks that it can see your screen.
      </p>
      {!status && <div style={S.small}>Looking for models in {label}…</div>}
      {serverGuidance && !busy && <div style={S.error} role="status" data-testid="local-guidance">{serverGuidance}</div>}
      {modelGuidance && !busy && (
        <div style={modelGuidance.tone === 'problem' ? S.error : S.note} role="status" data-testid="local-model-guidance">
          {modelGuidance.message}
        </div>
      )}
      <div style={S.list} data-testid="local-models">
        {(status?.models ?? []).map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => void check(m.id)}
            disabled={checking}
            className={`setup-choice setup-model-row${chosen === m.id ? ' is-on' : ''}`}
            aria-pressed={chosen === m.id}
          >
            <span>{m.label}</span>
            {m.vision === 'yes' && <span style={S.badge}>Can read images</span>}
            {chosen === m.id && result?.ok && <span style={S.tick} aria-label="Check passed">✓</span>}
          </button>
        ))}
      </div>
      <div style={S.actionRow}>
        <button type="button" className="btn-secondary" onClick={() => void look(false)} disabled={busy || checking}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
      </div>
      {checking && <div style={S.small}>{LOCAL_CHECKING_NOTE}</div>}
      {result && (
        <div style={result.ok ? S.okLine : S.error} data-testid="model-check">
          {result.ok ? '✓ ' : ''}{result.message}
        </div>
      )}
    </div>
  )
}

// ─── Your model (cloud) ──────────────────────────────────────────────────────

function CloudModelStep({ allow, onBeforeNext }: StepProps): React.ReactElement {
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const [models, setModels] = useState<ModelChoice[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string>(settings.modelId)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string; errorKind: string | null } | null>(null)
  const [tried, setTried] = useState<string[]>([])
  const [showAll, setShowAll] = useState(false)
  const started = useRef(false)

  const check = useCallback(async (modelId: string): Promise<void> => {
    setChosen(modelId)
    setTried((t) => (t.includes(modelId) ? t : [...t, modelId]))
    setChecking(true)
    setResult(null)
    try {
      const s = useAppStore.getState().settings
      await window.mybuildy.saveSettings(nonSecretFrom(s, { modelId }))
      const r = await window.mybuildy.testConnection(nonSecretFrom(s, { modelId }))
      setResult({ ok: r.visionPassed, message: r.visionPassed ? 'This model can see your screen.' : r.message, errorKind: r.errorKind })
      setSettings(await window.mybuildy.loadSettings())
    } catch {
      setResult({ ok: false, message: CHECK_FAILED_MESSAGE, errorKind: 'unknown' })
    } finally {
      setChecking(false)
    }
  }, [setSettings])

  // Load the list; highlight the Suggested model and check it straight away.
  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      const r = await window.mybuildy.listModels(settings.provider, settings.baseUrl)
      setModels(r.models)
      setListError(r.error)
      const already = settings.modelId && (await window.mybuildy.getVisionStatus(settings.provider, settings.modelId)).passed
      if (already) { setResult({ ok: true, message: 'This model can see your screen.', errorKind: null }); return }
      const suggested = r.models.find((m) => m.suggested)
      if (suggested) await check(suggested.id)
    })()
  }, [settings.provider, settings.baseUrl, settings.modelId, check])

  useEffect(() => {
    allow(!!result?.ok && !checking)
    onBeforeNext(null)
  }, [result, checking, allow, onBeforeNext])

  // Curated models by default (3 to 6); everything else behind "Show all".
  const curated = models?.filter((m) => m.curated) ?? []
  const visible = curated.length === 0 || showAll ? (models ?? []) : curated
  const nextRecommended = curated.find((m) => !tried.includes(m.id)) ?? null
  const billingUrl = PROVIDER_BILLING_URLS[settings.provider]
  const failed = !!result && !result.ok && !checking

  return (
    <div>
      <h2 style={S.stepTitle}>Your model</h2>
      <p style={S.text}>
        A model is the AI brain MyBuildy uses. The <strong>Suggested</strong> one works well and costs little. MyBuildy
        checks that it can see your screen.
      </p>
      {!models && !listError && <div style={S.small}>Loading the models your key can use…</div>}
      {listError && <div style={S.error}>{listError}</div>}
      <div style={S.list}>
        {visible.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => void check(m.id)}
            disabled={checking}
            className={`setup-choice setup-model-row${chosen === m.id ? ' is-on' : ''}`}
            aria-pressed={chosen === m.id}
          >
            <span>{m.label}</span>
            {m.suggested && <span style={S.badge}>Suggested</span>}
            {chosen === m.id && result?.ok && <span style={S.tick} aria-label="Check passed">✓</span>}
          </button>
        ))}
      </div>
      {curated.length > 0 && (models?.length ?? 0) > curated.length && (
        <button type="button" className="btn-ghost" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show recommended only' : `Show all ${models?.length ?? 0} models`}
        </button>
      )}
      {checking && <div style={S.small}>Checking that this model can see your screen…</div>}
      {result && (
        <div style={result.ok ? S.okLine : S.error} data-testid="model-check">
          {result.ok ? '✓ ' : ''}{result.message}
        </div>
      )}
      {failed && (
        <div style={S.actionRow}>
          {result?.errorKind === 'billing' && billingUrl && (
            <a href={billingUrl} target="_blank" rel="noreferrer" className="btn-primary" style={S.actionLink}>
              Open the billing page
            </a>
          )}
          {suggestsNextModel(result?.errorKind ?? null) && nextRecommended && (
            <button type="button" className="btn-primary" onClick={() => void check(nextRecommended.id)}>
              Try the next recommended model
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Mac: Let MyBuildy see your screen ───────────────────────────────────────

function usePermissions(): SetupPermissionStatus | null {
  const [status, setStatus] = useState<SetupPermissionStatus | null>(null)
  useEffect(() => {
    let alive = true
    const read = (): void => { void window.mybuildy.setup.permissions().then((s) => { if (alive) setStatus(s) }) }
    read()
    const timer = setInterval(read, 1500) // turns green by itself
    return () => { alive = false; clearInterval(timer) }
  }, [])
  return status
}

function ScreenStep({ allow, onBeforeNext, skip }: StepProps): React.ReactElement {
  const status = usePermissions()
  const [opened, setOpened] = useState(false)
  const granted = status?.screen === 'granted' || status?.screen === 'unknown'

  useEffect(() => { void window.mybuildy.setup.registerScreen() }, [])
  useEffect(() => { allow(granted); onBeforeNext(null) }, [granted, allow, onBeforeNext])

  return (
    <div>
      <h2 style={S.stepTitle}>Let MyBuildy see your screen</h2>
      <p style={S.text}>
        MyBuildy needs to see your coding agent&apos;s window to explain it. macOS asks you to allow this once.
      </p>
      <StatusLine ok={granted} okText="MyBuildy can see your screen" waitingText="Not allowed yet" testId="screen-status" />
      {!granted && (
        <>
          <ol style={S.steps}>
            <li>Click <strong>Open System Settings</strong>.</li>
            <li>Find <strong>MyBuildy</strong> in the list and turn it on.</li>
            <li>Come back here — this turns green by itself.</li>
          </ol>
          <button
            type="button"
            className="btn-primary"
            style={S.bigBtn}
            onClick={() => { setOpened(true); void window.mybuildy.setup.openPane('screen') }}
          >
            Open System Settings
          </button>
          {opened && (
            <div style={S.panel}>
              <p style={S.text}>
                Turned it on, but it&apos;s still not green? macOS only applies this after MyBuildy restarts. Setup
                continues right here afterwards.
              </p>
              <button type="button" className="btn-secondary" style={S.bigBtn} onClick={() => void window.mybuildy.setup.restart()}>
                Restart MyBuildy
              </button>
            </div>
          )}
          <button type="button" className="btn-ghost" onClick={skip} style={S.skipLink}>
            Skip for now (MyBuildy can&apos;t watch until this is on)
          </button>
        </>
      )}
    </div>
  )
}

// ─── Mac: Let MyBuildy paste for you ─────────────────────────────────────────

function PasteStep({ allow, onBeforeNext, skip }: StepProps): React.ReactElement {
  const status = usePermissions()
  const [asking, setAsking] = useState(false)
  const typeOk = !!status?.accessibility
  const frontOk = status?.automation === 'granted'

  useEffect(() => { allow(typeOk && frontOk); onBeforeNext(null) }, [typeOk, frontOk, allow, onBeforeNext])

  async function ask(): Promise<void> {
    setAsking(true)
    try {
      await window.mybuildy.setup.requestPaste()
    } finally {
      setAsking(false)
    }
  }

  return (
    <div>
      <h2 style={S.stepTitle}>Let MyBuildy paste for you</h2>
      <p style={S.text}>
        Optional. With this on, <strong>Paste into terminal</strong> puts the suggested prompt into your terminal for
        you. MyBuildy never presses Return — you always do that yourself.
      </p>
      <StatusLine ok={frontOk} okText="Can bring your terminal to the front" waitingText="Bring your terminal to the front" testId="automation-status" />
      <StatusLine ok={typeOk} okText="Can paste into your terminal" waitingText="Paste into your terminal" testId="accessibility-status" />
      {!(typeOk && frontOk) && (
        <>
          <p style={S.small}>
            macOS will show two questions. Click <strong>OK</strong> on the one about System Events. On the other, click{' '}
            <strong>Open System Settings</strong> and turn on MyBuildy.
          </p>
          <div style={S.row}>
            <button type="button" className="btn-primary" style={S.bigBtn} disabled={asking} onClick={() => void ask()}>
              {asking ? 'Waiting for macOS…' : 'Allow pasting'}
            </button>
            <button type="button" className="btn-secondary" style={S.bigBtn} onClick={skip}>
              Skip — I&apos;ll paste myself
            </button>
          </div>
          {status && status.automation === 'denied' && (
            <button type="button" className="btn-ghost" onClick={() => void window.mybuildy.setup.openPane('automation')}>
              Changed your mind? Open System Settings → Automation
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ─── What do you want to build? ──────────────────────────────────────────────

function GoalStep({ allow, onBeforeNext }: StepProps): React.ReactElement {
  const setProject = useAppStore((s) => s.setProject)
  const [choice, setChoice] = useState<string | null>(null)
  const [ownPurpose, setOwnPurpose] = useState('')
  const [ownDone, setOwnDone] = useState('')
  const ready = READY_GOALS.find((g) => g.id === choice) ?? null

  useEffect(() => {
    const ok = !!ready || (choice === 'own' && ownPurpose.trim().length > 0)
    allow(ok)
    onBeforeNext(async () => {
      const goal = ready
        ? { purpose: ready.purpose, successCriteria: ready.doneWhen }
        : { purpose: ownPurpose.trim(), successCriteria: ownDone.trim() || undefined }
      await window.mybuildy.goal.set(goal)
      setProject(await window.mybuildy.loadProject())
      return true
    })
  }, [choice, ready, ownPurpose, ownDone, allow, onBeforeNext, setProject])

  return (
    <div>
      <h2 style={S.stepTitle}>What do you want to build?</h2>
      <p style={S.text}>Pick one to try MyBuildy out, or write your own. You can change it any time.</p>
      <div style={S.list}>
        {READY_GOALS.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => setChoice(g.id)}
            className={`setup-choice${choice === g.id ? ' is-on' : ''}`}
            aria-pressed={choice === g.id}
            data-testid={`goal-${g.id}`}
          >
            <div style={S.choiceTitle}>{g.title}</div>
            <div style={S.choiceSub}>{doneWhenText(g.doneWhen)}</div>
          </button>
        ))}
        <button
          type="button"
          onClick={() => setChoice('own')}
          className={`setup-choice${choice === 'own' ? ' is-on' : ''}`}
          aria-pressed={choice === 'own'}
          data-testid="goal-own"
        >
          <div style={S.choiceTitle}>Write my own</div>
          <div style={S.choiceSub}>For example: {OWN_GOAL_EXAMPLE.purpose}</div>
        </button>
      </div>
      {choice === 'own' && (
        <div style={S.panel}>
          <label style={S.label} htmlFor="own-goal">What do you want to build?</label>
          <textarea
            id="own-goal"
            value={ownPurpose}
            onChange={(e) => setOwnPurpose(e.target.value)}
            placeholder={OWN_GOAL_EXAMPLE.purpose}
            rows={2}
            style={S.input}
          />
          <label style={S.label} htmlFor="own-done">Done when… (how you&apos;ll know it works)</label>
          <input
            id="own-done"
            value={ownDone}
            onChange={(e) => setOwnDone(e.target.value)}
            placeholder={OWN_GOAL_EXAMPLE.doneWhen}
            style={S.input}
          />
        </div>
      )}
    </div>
  )
}

// ─── Open your coding agent ──────────────────────────────────────────────────

function AgentStep({ platform, allow, onBeforeNext }: StepProps): React.ReactElement {
  const info = agentInstructions(platform)
  useEffect(() => { allow(true); onBeforeNext(null) }, [allow, onBeforeNext])
  return (
    <div>
      <h2 style={S.stepTitle}>Open your coding agent</h2>
      <p style={S.text}>
        Your coding agent (like Claude Code) does the building. Start it now, so MyBuildy has something to watch.
      </p>
      <ol style={S.steps}>
        <li>
          Open <strong>{info.terminal}</strong>. {info.howToOpen}
        </li>
        {info.commands.map((c) => (
          <li key={c.command}>
            {c.label}: type this, then press <kbd style={S.kbd}>Enter</kbd>
            <CopyBox text={c.command} />
          </li>
        ))}
      </ol>
      <p style={S.small}>
        Don&apos;t have Claude Code yet?{' '}
        <a href={CLAUDE_CODE_INSTALL_URL} target="_blank" rel="noreferrer" style={S.link}>
          How to install it
        </a>
        . Using another agent (Codex, Gemini CLI, Aider…)? Start that instead — MyBuildy watches it too.
      </p>
    </div>
  )
}

function CopyBox({ text }: { text: string }): React.ReactElement {
  const [copied, setCopied] = useState(false)
  return (
    <div style={S.copyBox}>
      <code style={S.code} data-selectable>{text}</code>
      <button
        type="button"
        className="btn-secondary"
        onClick={() => { void window.mybuildy.copyText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600) }) }}
        aria-label={`Copy ${text}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

// ─── Show MyBuildy your coding agent ─────────────────────────────────────────

function WindowStep({ allow, onBeforeNext, skip, onWatching }: StepProps): React.ReactElement {
  const settings = useAppStore((s) => s.settings)
  const [windows, setWindows] = useState<WindowSource[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [chosenName, setChosenName] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => { allow(!!chosenName); onBeforeNext(null) }, [chosenName, allow, onBeforeNext])

  // A window closed while the picker is open disappears from it.
  useRefreshWhileOpen(windows !== null, async () => {
    const fresh = await window.mybuildy.listWindows()
    setWindows((open) => (open === null ? null : fresh))
  })

  async function openPicker(): Promise<void> {
    setMessage(null)
    // This screen is the one-time notice: what MyBuildy captures and where it goes.
    if (!settings.captureNoticeAccepted) await window.mybuildy.acceptCaptureNotice()
    setWindows(await window.mybuildy.listWindows())
  }

  async function confirm(): Promise<void> {
    const win = windows?.find((w) => w.id === selected)
    if (!win) return
    const result = await window.mybuildy.selectWatchSource(win.id, win.name)
    setWindows(null)
    if (result.started) { setChosenName(win.name); onWatching(win.name) }
    else setMessage(result.message || 'MyBuildy could not start watching that window. Try again.')
  }

  return (
    <div>
      <h2 style={S.stepTitle}>Show MyBuildy your coding agent</h2>
      <p style={S.text}>
        This is how MyBuildy sees your screen. It only looks at the one window you choose — never the rest of your
        screen. Choose the window your coding agent is running in.
      </p>
      <p style={S.small}>
        {CAPTURE_NOTICE_MESSAGE}{' '}
        {dataDestinationNote({ provider: settings.provider, baseUrl: settings.baseUrl, hasElevenLabsKey: settings.hasElevenLabsKey }).split('. ')[0].replace(/\.$/, '')}.
      </p>
      {chosenName ? (
        <StatusLine ok okText={`MyBuildy is watching: ${chosenName}`} waitingText="" testId="window-chosen" />
      ) : (
        <button type="button" className="btn-primary" style={S.bigBtn} onClick={() => void openPicker()}>
          Choose the window
        </button>
      )}
      {chosenName && (
        <button type="button" className="btn-ghost" onClick={() => void openPicker()}>
          Choose a different window
        </button>
      )}
      {message && <div style={S.error} role="alert">{message}</div>}
      {windows && (
        <div style={S.pickerWrap}>
          <WindowPicker
            windows={windows}
            selectedId={selected}
            onSelect={setSelected}
            onConfirm={() => void confirm()}
            onCancel={() => setWindows(null)}
            confirmLabel="Watch this window"
          />
        </div>
      )}
      {!chosenName && (
        <button type="button" className="btn-ghost" onClick={skip} style={S.skipLink}>
          Skip for now — I&apos;ll do this from the mascot later
        </button>
      )}
    </div>
  )
}

// ─── Done ──────────────────────────────────────────────────────────────────────

function DoneStep({ watching, onFinish }: { watching: string | null; onFinish: () => void }): React.ReactElement {
  return (
    <div style={S.centered}>
      <div style={S.bigTick}>✓</div>
      <h2 style={S.title}>You&apos;re all set</h2>
      {watching ? (
        <p style={S.lead}>
          MyBuildy is watching. When it suggests a prompt, click <strong>Paste into terminal</strong>, then press Enter
          yourself.
        </p>
      ) : (
        <p style={S.lead}>
          When your coding agent is running, click the robot and show MyBuildy your coding agent. When it suggests a
          prompt, click <strong>Paste into terminal</strong>, then press Enter yourself.
        </p>
      )}
      <button type="button" className="btn-primary" style={S.heroBtn} onClick={onFinish}>
        Finish
      </button>
    </div>
  )
}

function StatusLine({ ok, okText, waitingText, testId }: { ok: boolean; okText: string; waitingText: string; testId: string }): React.ReactElement {
  return (
    <div style={{ ...S.status, ...(ok ? S.statusOk : S.statusWaiting) }} data-testid={testId} data-ok={ok}>
      <span style={{ ...S.dot, background: ok ? 'var(--color-success)' : 'var(--color-text-dim)' }} />
      {ok ? okText : waitingText}
    </div>
  )
}

const S = {
  root: { display: 'flex', flexDirection: 'column' as const, height: '100%', background: 'var(--color-bg)' },
  header: { padding: '18px 28px 0' },
  progressText: { fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 },
  progressTrack: { height: 4, borderRadius: 2, background: 'var(--color-surface-2)', overflow: 'hidden' as const },
  progressFill: { height: '100%', background: 'var(--color-accent)', transition: 'width 0.25s ease' },
  body: { flex: 1, overflowY: 'auto' as const, padding: '20px 28px' },
  footer: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '14px 28px 20px', borderTop: '1px solid var(--color-border)' },
  centered: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', textAlign: 'center' as const, gap: 16, paddingTop: 60 },
  title: { fontSize: 24, fontWeight: 700, margin: 0 },
  lead: { fontSize: 16, lineHeight: 1.55, color: 'var(--color-text-muted)', maxWidth: 420, margin: 0 },
  stepTitle: { fontSize: 20, fontWeight: 700, margin: '0 0 8px' },
  text: { fontSize: 14, lineHeight: 1.6, color: 'var(--color-text-muted)', margin: '0 0 16px' },
  small: { fontSize: 12.5, lineHeight: 1.5, color: 'var(--color-text-dim)', margin: '12px 0' },
  heroBtn: { fontSize: 16, padding: '14px 28px', marginTop: 8, borderRadius: 10 },
  bigBtn: { fontSize: 15, padding: '11px 22px', borderRadius: 10, justifyContent: 'center' },
  cardGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 },
  choiceTitle: { fontSize: 14, fontWeight: 600 },
  choiceSub: { fontSize: 12, color: 'var(--color-text-muted)', marginTop: 3, lineHeight: 1.45 },
  list: { display: 'flex', flexDirection: 'column' as const, gap: 8, marginBottom: 12 },
  badge: { fontSize: 11, fontWeight: 600, color: 'var(--color-accent)', background: 'var(--color-accent-muted)', padding: '2px 8px', borderRadius: 9999 },
  tick: { marginLeft: 'auto', color: 'var(--color-success)', fontWeight: 700, fontSize: 16 },
  panel: { background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, padding: 14, marginTop: 12, display: 'flex', flexDirection: 'column' as const, gap: 8 },
  label: { fontSize: 12.5, fontWeight: 600, color: 'var(--color-text)' },
  input: {
    width: '100%', boxSizing: 'border-box' as const, fontSize: 14, padding: '10px 12px', borderRadius: 8, fontFamily: 'inherit',
    background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border-strong)', resize: 'none' as const,
  },
  link: { fontSize: 13, color: 'var(--color-accent)' },
  okLine: { fontSize: 13.5, color: 'var(--color-success)', margin: '8px 0' },
  error: { fontSize: 13, color: 'var(--color-danger)', margin: '10px 0', lineHeight: 1.5 },
  note: { fontSize: 13, lineHeight: 1.5, color: 'var(--color-text)', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '8px 12px', margin: '0 0 12px' },
  untested: { fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)', marginTop: 4 },
  actionRow: { display: 'flex', gap: 8, flexWrap: 'wrap' as const, marginTop: 4 },
  actionLink: { textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
  steps: { fontSize: 14, lineHeight: 1.8, color: 'var(--color-text)', paddingLeft: 20, margin: '0 0 16px' },
  kbd: { fontFamily: 'var(--font-mono)', fontSize: 12, padding: '1px 6px', borderRadius: 4, border: '1px solid var(--color-border-strong)', background: 'var(--color-surface-2)' },
  copyBox: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 10px' },
  code: {
    flex: 1, fontFamily: 'var(--font-mono)', fontSize: 13.5, padding: '9px 12px', borderRadius: 8,
    background: 'var(--color-prompt-bg)', border: '1px solid var(--color-prompt-border)', color: 'var(--color-text)',
  },
  row: { display: 'flex', gap: 10, flexWrap: 'wrap' as const, margin: '8px 0' },
  status: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, padding: '10px 14px', borderRadius: 10, margin: '8px 0' },
  statusOk: { background: 'var(--color-success-muted)', color: 'var(--color-success)' },
  statusWaiting: { background: 'var(--color-surface)', color: 'var(--color-text-muted)' },
  dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  skipLink: { marginTop: 14, fontSize: 12.5 },
  pickerWrap: { marginTop: 14, border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden' as const },
  bigTick: { fontSize: 48, color: 'var(--color-success)' },
  localLink: { marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--color-border)' },
  localOk: { fontSize: 11, fontWeight: 600, color: 'var(--color-success)', marginTop: 4 },
}
