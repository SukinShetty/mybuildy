// CompanionApp.tsx
// Live companion UI — orb + controls + speech bubble + push-to-talk.
// Flow: click orb → show MyBuildy your coding agent → live watching → speak/bubble on changes → ask questions.

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { StopGeneration, transcribeAndAsk } from './voice-question'
import { useCompanionStore } from '../store/useCompanionStore'
import { Mascot } from '../components/Mascot'
import { deriveMascotSignals, type MascotAlignment } from './mascot-signals'
import { currentAnimation, reactionSeconds, robotGlow, type RobotReaction, type RobotSituation } from './robot-animation'
import { nextStepLabel } from './next-step'
import { ResolvedHandoffs } from '../handoff'
import { robotSizeText } from '../robot-size'
import { robotHiddenMessage, hideButtonTitle } from '../robot-hidden'
import { useRefreshWhileOpen } from '../components/useRefreshWhileOpen'
import { BAR_BACKGROUND_CSS, ICON_COLOR, ICON_HOVER_COLOR, ICON_HOVER_BACKGROUND_CSS } from './robot-theme'
import type { AnalysisResult, WatchStatus, VoiceFallback } from '../types'
import { isModelConfigured, CAPTURE_NOTICE_MESSAGE, VOICE_FALLBACK_HEADLINE } from '../types'
import type { CompanionState, MicState } from '../store/useCompanionStore'

interface WindowItem { id: string; name: string; thumbnailBase64: string }

export function CompanionApp(): React.ReactElement {
  const {
    avatarState, latestAnalysis, isMuted, isPaused, isQuietMode,
    watchedWindowName, watchedSourceMessage, analyzing, pastedPromptId, showWindowPicker,
    micState, micError, lastAnswer,
    setAvatarState, setLatestAnalysis, setMuted, setQuietMode,
    setWatchStatus, setPastedPromptId, setShowWindowPicker,
    setMicState, setMicError, setLastAnswer,
    clearAnalysis,
  } = useCompanionStore()

  const [windowList, setWindowList] = useState<WindowItem[]>([])
  const [needsSetup, setNeedsSetup] = useState(false)
  const [hasElevenKey, setHasElevenKey] = useState(false)
  const [sentFlash, setSentFlash] = useState(false)
  // One-time privacy disclosure (first window pick). The accepted flag is
  // persisted in main; while it's false the chosen window is parked in
  // pendingPick until the user hits Continue (Cancel aborts the pick).
  const [captureNoticeAccepted, setCaptureNoticeAccepted] = useState(true)
  const [pendingPick, setPendingPick] = useState<{ id: string; name: string } | null>(null)
  const [confirmQuit, setConfirmQuit] = useState(false)
  const [sizeToast, setSizeToast] = useState<string | null>(null)
  const [hiding, setHiding] = useState(false)
  // ElevenLabs failed, so the computer's voice is speaking — said plainly, with why.
  const [voiceFallback, setVoiceFallback] = useState<VoiceFallback | null>(null)
  const [voiceNoticeDismissed, setVoiceNoticeDismissed] = useState<string | null>(null)
  const mascotWrapRef = useRef<HTMLDivElement | null>(null)
  const isMutedRef = useRef(isMuted)
  isMutedRef.current = isMuted
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const stopGenRef = useRef(new StopGeneration())
  const streamRef = useRef<MediaStream | null>(null)

  // ─── Robot animation signals ────────────────────────────────────────
  // Alignment glow, one-off reactions, "!" badge and the drag direction.
  // Derived from existing IPC events via deriveMascotSignals and
  // robot-animation.ts (both pure, unit-tested).
  const [alignment, setAlignment] = useState<MascotAlignment | null>(null)
  const [reaction, setReaction] = useState<{ type: RobotReaction; startedAt: number } | null>(null)
  const [showAlertBadge, setShowAlertBadge] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [dragDirection, setDragDirection] = useState<'left' | 'right' | null>(null)
  // Previously seen analysis — reactions fire on transitions, not repeats.
  const prevAnalysisRef = useRef<AnalysisResult | null>(null)
  // Hand-offs the user answered or dismissed in the guidance window: their "!"
  // badge clears at once and never comes back for them (handoff.ts).
  const resolvedHandoffsRef = useRef(new ResolvedHandoffs())

  // A one-off reaction plays from now; afterwards the ongoing state returns.
  const fireReaction = useCallback((type: RobotReaction) => {
    setReaction({ type, startedAt: Date.now() })
  }, [])
  useEffect(() => {
    if (!reaction) return
    const timer = setTimeout(() => setReaction(null), reactionSeconds(reaction.type) * 1000 + 50)
    return () => clearTimeout(timer)
  }, [reaction])

  // New watching session (or none): forget analysis-derived mascot signals.
  const resetMascotSignals = useCallback(() => {
    prevAnalysisRef.current = null
    resolvedHandoffsRef.current.clear()
    setAlignment(null)
    setShowAlertBadge(false)
  }, [])

  // ─── Check if a provider key + model are configured ─────────────────
  // Re-checked periodically so saving Settings updates the mascot label and
  // the mic button without restarting the companion.

  useEffect(() => {
    let alive = true
    const check = (): void => {
      window.mybuildy.loadSettings().then((s) => {
        if (!alive) return
        setNeedsSetup(!isModelConfigured(s))
        setHasElevenKey(!!s.hasElevenLabsKey)
        setCaptureNoticeAccepted(s.captureNoticeAccepted)
      }).catch(() => {})
    }
    check()
    const timer = setInterval(check, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  // ─── IPC listeners (once) ───────────────────────────────────────────

  useEffect(() => {
    // The one watch (main owns it; the Guidance tab shows the same). Nothing
    // watched any more: the old analysis, glow, badge and panel go with it.
    const applyWatchStatus = (s: WatchStatus): void => {
      setWatchStatus(s)
      if (!s.windowName) { clearAnalysis(); resetMascotSignals(); window.mybuildy.hideGuidance() }
    }
    void window.mybuildy.getWatchStatus().then(({ status }) => applyWatchStatus(status))
    void window.mybuildy.getVoiceFallback().then(setVoiceFallback)
    const unsubs = [
      window.mybuildy.onVoiceFallback(setVoiceFallback),
      window.mybuildy.onWatchStatus(applyWatchStatus),
      // Stop, from here or the Guidance tab: drop a recording in progress (main
      // has already ended the watch and silenced the voice).
      window.mybuildy.onStopped(() => {
        discardRecording()
        setMicState('idle'); setAvatarState('idle')
        setShowAlertBadge(false)
      }),
      window.mybuildy.onCompanionAnalysis((_: unknown, a: AnalysisResult) => {
        setLastAnswer(null)
        setLatestAnalysis(a)
        // Mascot signals: alignment glow + transition reactions + "!" badge.
        // The badge is only CLEARED when the user opens the panel themselves
        // (orb click / show-last) — the auto-show below doesn't count as seen.
        const resolved = resolvedHandoffsRef.current
        const signals = deriveMascotSignals(a, prevAnalysisRef.current, (x) => resolved.isResolved(x))
        prevAnalysisRef.current = a
        setAlignment(signals.alignment)
        if (signals.reaction) fireReaction(signals.reaction)
        if (signals.raiseAlertBadge) setShowAlertBadge(true)
        // Render guidance in its OWN window so it never overflows the mascot.
        window.mybuildy.showGuidance(a)
      }),
      // "I'll decide" / "Skip for now" on the hand-off card: the alert is handled.
      window.mybuildy.onHandoffResolved((ref) => {
        resolvedHandoffsRef.current.resolve(ref)
        setShowAlertBadge(false)
      }),
      window.mybuildy.onCompanionState((_: unknown, s: string) => setAvatarState(s as CompanionState)),
      // NOTE: audio is no longer played here. Playback lives in the main-process
      // voice player (hidden window) so it survives this window being backgrounded.
      window.mybuildy.onCompanionAnswer((_: unknown, d: { question: string; answer: string }) => {
        setLastAnswer(d)
        setMicState('idle')
        // Show the spoken-question answer in the guidance window.
        window.mybuildy.showGuidanceAnswer(d)
      }),
      window.mybuildy.onCompanionShutdown(() => window.mybuildy.voice.stop()),
      // Project switched: nothing from the old project stays on the mascot.
      window.mybuildy.onProjectSwitched(() => { clearAnalysis(); setLastAnswer(null); resetMascotSignals() }),
      // Brief "Sent" status after a successful Send to Claude Code.
      window.mybuildy.onSendStatus((_: unknown, status: string) => {
        if (status === 'sent') {
          // That prompt is done: the line never offers to paste it again.
          setPastedPromptId(useCompanionStore.getState().latestAnalysis?.promptId ?? null)
          setSentFlash(true)
          setTimeout(() => setSentFlash(false), 2000)
        }
      }),
      // Window drag (from main's 'move' events) — the robot runs that way.
      window.mybuildy.onCompanionDrag((_: unknown, d: boolean, direction: 'left' | 'right' | null) => {
        setDragging(d)
        setDragDirection(direction)
      }),
    ]
    return () => { unsubs.forEach((u) => u()) }
  }, [])

  // ─── Window picker ──────────────────────────────────────────────────

  // A fresh list every time it opens, and again while it stays open.
  useRefreshWhileOpen(showWindowPicker, async () => {
    const wins = await window.mybuildy.listWindows()
    setWindowList(wins.map((w) => ({ id: w.id, name: w.name, thumbnailBase64: w.thumbnailBase64 })))
  })

  async function openPicker(): Promise<void> {
    const s = await window.mybuildy.loadSettings()
    setHasElevenKey(!!s.hasElevenLabsKey)
    // Refresh the disclosure flag from the FRESH settings too: the state
    // starts true (fail-open), so a failed mount-time load must not let a
    // pick silently skip the one-time privacy notice.
    setCaptureNoticeAccepted(s.captureNoticeAccepted)
    if (!isModelConfigured(s)) { setNeedsSetup(true); return }
    setNeedsSetup(false)
    const wins = await window.mybuildy.listWindows()
    setWindowList(wins.map((w) => ({ id: w.id, name: w.name, thumbnailBase64: w.thumbnailBase64 })))
    setShowWindowPicker(true)
  }

  async function pickWindow(id: string, name: string): Promise<void> {
    setShowWindowPicker(false)
    // First-ever pick: show the one-time privacy disclosure before anything
    // is captured. Continue proceeds with this pick; Cancel aborts it.
    if (!captureNoticeAccepted) {
      setPendingPick({ id, name })
      return
    }
    await startWatchingWindow(id, name)
  }

  async function startWatchingWindow(id: string, name: string): Promise<void> {
    clearAnalysis()
    resetMascotSignals()  // fresh session: no stale glow/badge from the old window
    window.mybuildy.hideGuidance()  // drop any stale guidance from the previous window
    window.mybuildy.voice.resetDedup()  // fresh watching session can speak anything
    await window.mybuildy.selectWatchSource(id, name)
  }

  async function onCaptureNoticeContinue(): Promise<void> {
    const pick = pendingPick
    setPendingPick(null)
    try {
      await window.mybuildy.acceptCaptureNotice()
      setCaptureNoticeAccepted(true)
    } catch (e) {
      console.warn('[Companion] could not persist capture-notice acceptance:', e)
      // Proceed anyway for this session — the notice will simply show again.
    }
    if (pick) await startWatchingWindow(pick.id, pick.name)
  }

  function onCaptureNoticeCancel(): void {
    setPendingPick(null) // abort the window pick entirely
  }

  // ─── Click-to-talk (MediaRecorder → ElevenLabs STT) ─────────────────

  const startRecording = useCallback(async () => {
    if (!watchedWindowName) return
    setMicError(null)

    try {
      // NOTE: deliberately does NOT stop audio (Invariant 2). Starting the mic
      // while MyBuildy is talking lets it finish; recording proceeds in parallel.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      // One Stop generation for the whole question: recording → transcription → question.
      const startedAt = stopGenRef.current.current()
      audioChunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null

        // Stop pressed at any point since recording started: throw it away.
        if (stopGenRef.current.current() !== startedAt) {
          audioChunksRef.current = []
          console.log('[Mic] Recording discarded (Stop) — not transcribed')
          setMicState('idle')
          return
        }

        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        console.log(`[Mic] Recording complete: ${blob.size} bytes`)

        if (blob.size < 500) {
          console.warn('[Mic] Recording too short')
          setMicState('idle')
          setMicError('Too short — click mic, speak, click again.')
          return
        }

        try {
          const arrayBuffer = await blob.arrayBuffer()
          const outcome = await transcribeAndAsk(arrayBuffer, startedAt, stopGenRef.current, {
            transcribe: (audio) => window.mybuildy.transcribeAudio(audio),
            // NOTE: never log the transcribed text itself (user speech content).
            ask: (question) => window.mybuildy.askQuestion(question),
            onStatus: (status, error) => {
              setMicState(status)
              setMicError(error ?? null)
            },
          })
          if (outcome === 'cancelled') {
            console.log('[Mic] Stopped — the question was not sent')
            setMicState('idle')
          }
        } catch (err) {
          console.error('[Mic] Error:', err)
          setMicState('idle')
          setMicError(`Error: ${String(err).slice(0, 80)}`)
        }
      }

      mediaRecorderRef.current = recorder
      recorder.start()
      setMicState('listening')
      console.log('[Mic] Recording started — click mic again to stop')
    } catch (err) {
      console.error('[Mic] getUserMedia failed:', err)
      setMicState('idle')
      setMicError('Microphone access denied. Allow mic in system settings.')
    }
  }, [watchedWindowName])

  // Stop: bump the generation (cancels a transcription or question already
  // under way) and end any recording — it is discarded, never transcribed.
  const discardRecording = useCallback(() => {
    stopGenRef.current.bump()
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop()
      mediaRecorderRef.current = null
    }
  }, [])

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop()
      mediaRecorderRef.current = null
      console.log('[Mic] Recording stopped — processing...')
    }
  }, [])

  // ─── Handlers ───────────────────────────────────────────────────────

  function onOrbClick(): void {
    if (needsSetup) { window.mybuildy.openPanel(); return }
    if (!watchedWindowName) { openPicker(); return }
    // The user is opening the guidance panel — the "!" alert is now seen.
    setShowAlertBadge(false)
    // Re-show the latest guidance/answer in the guidance window.
    if (latestAnalysis) window.mybuildy.showGuidance(latestAnalysis)
    else if (lastAnswer) window.mybuildy.showGuidanceAnswer(lastAnswer)
    else openPicker()
  }
  // Stop means stop: main ends the watch (cancelling any analysis in flight) and
  // silences the voice, then tells this window and the Guidance tab (onStopped
  // above discards an active recording without transcribing it).
  function onStop(): void {
    discardRecording()
    void window.mybuildy.stopCompanion()
  }
  function onMute(): void { const m = !isMuted; setMuted(m); window.mybuildy.voice.setMuted(m) }
  // Pause / Resume = Auto off / on in the Guidance tab. Main pauses (and
  // silences the voice) and sends the new status to both windows.
  function onPause(): void {
    if (isPaused) void window.mybuildy.resumeCompanion()
    else void window.mybuildy.pauseCompanion()
  }
  function onQuiet(): void { const q = !isQuietMode; setQuietMode(q); window.mybuildy.setQuietMode(q) }
  function onSettings(): void { window.mybuildy.openPanel() }
  // Hide: the robot and its guidance panel go away; watching carries on.
  // First say how to bring him back (taskbar / Dock), then go.
  function onHide(): void {
    if (hiding) return
    setHiding(true)
    setTimeout(() => {
      setHiding(false)
      window.mybuildy.robot.hide()
    }, HIDE_NOTICE_MS)
  }

  // Robot size: show it briefly whenever it changes (Settings or zooming).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.mybuildy.robot.onScaleChanged((scale) => {
      setSizeToast(robotSizeText(scale))
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setSizeToast(null), 1500)
    })
    return () => { off(); if (timer) clearTimeout(timer) }
  }, [])

  // Ctrl/Cmd + scroll wheel over the robot zooms it (one step per notch).
  useEffect(() => {
    const el = mascotWrapRef.current
    if (!el) return
    let last = 0
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault() // never the page's own zoom
      const now = Date.now()
      if (now - last < 120 || e.deltaY === 0) return
      last = now
      void window.mybuildy.robot.zoom(e.deltaY < 0 ? 'in' : 'out')
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  // Re-summon the most recent guidance even when no new analysis has arrived.
  // User-opened panel — clear the "!" alert badge.
  function onShowLast(): void { setShowAlertBadge(false); window.mybuildy.showLastGuidance() }

  function onMicToggle(): void {
    if (micState === 'listening') { stopRecording(); return }
    if (micState !== 'idle') return // don't interrupt transcribing/answering
    startRecording()
  }

  // ─── Render ─────────────────────────────────────────────────────────

  // Always the next action, in plain words (next-step.ts).
  const promptAlreadyPasted = !!latestAnalysis?.promptId && latestAnalysis.promptId === pastedPromptId
  const watchLabel = nextStepLabel({
    needsSetup,
    pastedJustNow: sentFlash,
    watchedSourceMessage,
    watchedWindowName,
    isPaused,
    thinking: analyzing || avatarState === 'thinking',
    promptAlreadyPasted,
    analysis: latestAnalysis,
  })

  const micLabel = micState === 'listening' ? 'listening...'
    : micState === 'transcribing' ? 'transcribing...'
    : micState === 'answering' ? 'thinking...'
    : micError ? micError
    : null

  // What is going on, for the robot's animation (robot-animation.ts maps it).
  const analysing = analyzing || avatarState === 'thinking' || micState === 'transcribing' || micState === 'answering'
  const robotSituation: RobotSituation = {
    dragging,
    dragDirection,
    analysing,
    handoffOpen: !!latestAnalysis?.needsHumanJudgment && !resolvedHandoffsRef.current.isResolved(latestAnalysis),
    agentWorking: !!watchedWindowName && latestAnalysis?.terminalState === 'working',
    promptReady: !!watchedWindowName && !sentFlash && !promptAlreadyPasted && !!latestAnalysis?.nextPrompt?.trim(),
    needsUser: needsSetup || !!watchedSourceMessage || latestAnalysis?.terminalState === 'permission_prompt',
    paused: isPaused,
  }
  const robot = currentAnimation(robotSituation, reaction, Date.now())
  const glow = robotGlow({
    listening: micState === 'listening',
    speaking: avatarState === 'speaking',
    thinking: analysing,
    watching: !!watchedWindowName,
    alignment,
  })

  return (
    <div style={S.root}>
      <div style={S.drag} />

      <div
        ref={mascotWrapRef}
        style={S.mascotWrap}
        onClick={onOrbClick}
        onContextMenu={(e) => { e.preventDefault(); openPicker() }}
        title="Click to interact — right-click to show MyBuildy your coding agent"
      >
        <Mascot
          animation={robot.animation}
          startedAt={robot.startedAt}
          effect={robot.effect}
          size={120}
          glow={glow}
          voice={micState === 'listening' ? 'listening' : avatarState === 'speaking' ? 'speaking' : null}
          showAlertBadge={showAlertBadge}
        />
      </div>

      <div
        style={S.watchLabel}
        title={watchedWindowName ? `${watchLabel}\nWatching: ${watchedWindowName}` : watchLabel}
        data-testid="robot-next-step"
        data-window={watchedWindowName ?? ''}
      >
        {watchLabel}
      </div>

      {/* Control pill */}
      <div style={S.pill} className="robot-bar">
        <Btn icon={stopIcon} onClick={onStop} active={false} title="Stop" />
        <Btn icon={isMuted ? muteOnIcon : muteOffIcon} onClick={onMute} active={isMuted} title={isMuted ? 'Unmute' : 'Mute'} />
        <Btn icon={isPaused ? playIcon : pauseIcon} onClick={onPause} active={isPaused} title={isPaused ? 'Resume' : 'Pause'} />
        <Btn icon={quietIcon} onClick={onQuiet} active={isQuietMode} title={isQuietMode ? 'Normal' : 'Quiet'} />
        <div style={S.pillDivider} />
        {/* Click-to-talk uses ElevenLabs STT — hidden unless a key is saved. */}
        {hasElevenKey && (
          <MicBtn
            micState={micState}
            onClick={onMicToggle}
            disabled={!watchedWindowName}
          />
        )}
        <Btn icon={showLastIcon} onClick={onShowLast} active={false} title="Show last guidance" />
        <Btn icon={monitorIcon} onClick={openPicker} active={false} title="Show MyBuildy your coding agent" />
        <Btn icon={gearIcon} onClick={onSettings} active={false} title="Settings" />
        {/* Get it off the screen: Hide first, then a gap, then Quit (hard to hit by accident). */}
        <div style={S.pillDivider} />
        <Btn icon={eyeOffIcon} onClick={onHide} active={false} title={hideButtonTitle(window.mybuildy.platform)} />
        <div style={S.quitGap} />
        <Btn icon={quitIcon} onClick={() => setConfirmQuit(true)} active={false} title="Quit MyBuildy" />
      </div>

      {/* Robot size, shown briefly while zooming (Ctrl/Cmd + scroll wheel) */}
      {sizeToast && <div style={S.sizeToast} role="status">{sizeToast}</div>}

      {/* The computer's voice is speaking because ElevenLabs failed: say so, and why */}
      {voiceFallback && voiceNoticeDismissed !== voiceFallback.code && (
        <div style={S.voiceNotice} role="alert" data-testid="voice-fallback">
          <div style={S.voiceNoticeTitle}>{VOICE_FALLBACK_HEADLINE}</div>
          <div style={S.voiceNoticeReason}>{voiceFallback.reason}</div>
          <div style={S.voiceNoticeButtons}>
            <button style={S.voiceNoticeButton} onClick={() => window.mybuildy.openSettings()}>Open Settings</button>
            <button style={S.voiceNoticeDismiss} onClick={() => setVoiceNoticeDismissed(voiceFallback.code)}>OK</button>
          </div>
        </div>
      )}

      {/* Hide: how to bring him back, before he goes */}
      {hiding && <div style={S.hideNotice} role="alert">{robotHiddenMessage(window.mybuildy.platform)}</div>}

      {/* Quit asks first */}
      {confirmQuit && (
        <div style={S.picker} role="dialog" aria-labelledby="quit-title">
          <div id="quit-title" style={S.noticeTitle}>Quit MyBuildy?</div>
          <div style={S.noticeText}>This stops watching and closes MyBuildy, including the robot and the guidance panel.</div>
          <div style={S.noticeButtons}>
            <button onClick={() => setConfirmQuit(false)} style={S.noticeCancel} autoFocus>Cancel</button>
            <button onClick={() => window.mybuildy.robot.quitApp()} style={S.noticeContinue}>Quit</button>
          </div>
        </div>
      )}

      {/* Mic state indicator */}
      {micLabel && (
        <div style={{
          ...S.micBadge,
          color: micError ? '#FF453A' : '#FF6B2B',
          animation: micState !== 'idle' && !micError ? 'pulse 1.2s ease-in-out infinite' : 'none',
        }}>
          {micLabel}
        </div>
      )}

      {/* Window picker — full-window overlay (guidance lives in its own window now) */}
      {showWindowPicker && (
        <div style={S.picker}>
          <div style={S.pickerHead}>Show MyBuildy your coding agent</div>
          <div style={S.pickerScroll}>
            {windowList.map((w) => (
              <button key={w.id} data-window-id={w.id} data-window-name={w.name} onClick={() => pickWindow(w.id, w.name)} style={S.pickerRow}>
                <img src={`data:image/jpeg;base64,${w.thumbnailBase64}`} style={S.pickerThumb} alt="" />
                <span style={S.pickerName}>{trunc(w.name, 28)}</span>
              </button>
            ))}
          </div>
          <button onClick={() => setShowWindowPicker(false)} style={S.pickerCancel}>Cancel</button>
        </div>
      )}

      {/* One-time privacy disclosure — shown before the FIRST watch ever starts */}
      {pendingPick && (
        <div style={S.picker}>
          <div style={S.noticeTitle}>Before MyBuildy starts watching</div>
          <div style={S.noticeText}>{CAPTURE_NOTICE_MESSAGE}</div>
          <div style={S.noticeButtons}>
            <button onClick={onCaptureNoticeCancel} style={S.noticeCancel}>Cancel</button>
            <button onClick={() => void onCaptureNoticeContinue()} style={S.noticeContinue}>Continue</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Small control button ────────────────────────────────────────────────────

function Btn({ icon, onClick, active, title }: { icon: string; onClick: () => void; active: boolean; title: string }) {
  return (
    <button
      onClick={onClick}
      className={`robot-btn${active ? ' is-active' : ''}`}
      style={S.btn}
      title={title}
      aria-label={title}
      dangerouslySetInnerHTML={{ __html: icon }}
    />
  )
}

// ─── Mic button (click to start, click to stop) ─────────────────────────────

function MicBtn({ micState, onClick, disabled }: { micState: MicState; onClick: () => void; disabled: boolean }) {
  const isActive = micState === 'listening'
  const isBusy = micState === 'transcribing' || micState === 'answering'

  return (
    <button
      onClick={disabled || isBusy ? undefined : onClick}
      className="robot-btn"
      style={{
        ...S.btn,
        ...(isActive ? S.micActive : isBusy ? S.micBusy : {}),
        opacity: disabled ? 0.3 : 1,
        cursor: disabled || isBusy ? 'not-allowed' : 'pointer',
      }}
      title={
        isActive ? 'Click to stop'
        : isBusy ? 'Processing...'
        : disabled ? 'Show MyBuildy your coding agent first'
        : 'Click to talk'
      }
      dangerouslySetInnerHTML={{ __html: micIcon }}
    />
  )
}

// ─── SVG icons ───────────────────────────────────────────────────────────────

const stopIcon = '<svg width="18" height="18" viewBox="0 0 8 8" fill="currentColor"><rect width="8" height="8" rx="1.5"/></svg>'
const muteOffIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19 4.9a10 10 0 010 14.1M15.5 8.5a5 5 0 010 7"/></svg>'
const muteOnIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>'
const pauseIcon = '<svg width="18" height="18" viewBox="0 0 8 8" fill="currentColor"><rect x="0" y="0" width="2.5" height="8" rx="0.5"/><rect x="5.5" y="0" width="2.5" height="8" rx="0.5"/></svg>'
const playIcon = '<svg width="18" height="18" viewBox="0 0 8 8" fill="currentColor"><polygon points="1,0 8,4 1,8"/></svg>'
const quietIcon = '<svg width="18" height="18" viewBox="0 0 10 10"><text x="5" y="8" text-anchor="middle" font-size="8" font-weight="700" fill="currentColor">Q</text></svg>'
const micIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="1" width="6" height="12" rx="3"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
const monitorIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
// Message-square (lucide-style) — re-show the last guidance panel.
const showLastIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
const eyeOffIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
const quitIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>'
// How long the "Buildy is hidden…" line shows before the robot goes.
const HIDE_NOTICE_MS = 2500
const gearIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>'

function trunc(t: string, n: number): string { return t.length > n ? t.slice(0, n - 1) + '\u2026' : t }

// ─── Styles ──────────────────────────────────────────────────────────────────

const S = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    padding: '0 10px 10px',
    gap: 0,
    background: 'transparent',
  },
  mascotWrap: {
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    // Drag the whole window from the mascot; the button pill opts out below.
    WebkitAppRegion: 'drag' as unknown as string,
  },
  drag: {
    width: '100%',
    height: 14,
    WebkitAppRegion: 'drag' as unknown as string,
    cursor: 'grab',
    flexShrink: 0,
  },
  watchLabel: {
    marginTop: 4,
    // The "Next:" line: bright, on a dark backing, readable at every robot size.
    fontSize: 13,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.95)',
    background: 'rgba(28,28,30,0.82)',
    padding: '3px 9px',
    borderRadius: 8,
    letterSpacing: '0.01em',
    textAlign: 'center' as const,
    maxWidth: 250,
    lineHeight: 1.3,
    flexShrink: 0,
    textShadow: '0 2px 10px rgba(0,0,0,0.9)',
    // Wrap long text, then truncate at 3 lines (no mid-word cutoff with "...")
    overflowWrap: 'break-word' as const,
    wordBreak: 'break-word' as const,
    display: '-webkit-box',
    WebkitLineClamp: 3,
    WebkitBoxOrient: 'vertical' as const,
    overflow: 'hidden',
  },
  pill: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    marginTop: 8,
    background: BAR_BACKGROUND_CSS, // near-solid dark bar (robot-theme.ts, contrast-tested)
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    borderRadius: 999,
    padding: '7px 9px',
    boxShadow: '0 2px 12px rgba(0,0,0,0.35)',
    flexShrink: 0,
    // Keep buttons clickable — exclude the pill from the window drag region.
    WebkitAppRegion: 'no-drag' as unknown as string,
    // Icon colours for .robot-btn (global.css), from the contrast-tested theme.
    ['--robot-icon' as string]: ICON_COLOR,
    ['--robot-icon-hover' as string]: ICON_HOVER_COLOR,
    ['--robot-icon-hover-bg' as string]: ICON_HOVER_BACKGROUND_CSS,
  },
  quitGap: {
    width: 6,
    flexShrink: 0,
  },
  voiceNotice: {
    marginTop: 6,
    maxWidth: 310,
    padding: '8px 12px',
    borderRadius: 12,
    background: 'rgba(28,28,30,0.95)',
    border: '1px solid rgba(255,159,10,0.6)',
    color: '#F2F2F7',
    fontSize: 12,
    lineHeight: 1.35,
  },
  voiceNoticeTitle: {
    fontWeight: 700,
  },
  voiceNoticeReason: {
    marginTop: 3,
    color: '#D1D1D6',
  },
  voiceNoticeButtons: {
    display: 'flex',
    gap: 8,
    marginTop: 6,
  },
  voiceNoticeButton: {
    background: '#FF9F0A',
    color: '#1C1C1E',
    border: 'none',
    borderRadius: 8,
    padding: '3px 10px',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
  },
  voiceNoticeDismiss: {
    background: 'transparent',
    color: '#F2F2F7',
    border: '1px solid rgba(255,255,255,0.3)',
    borderRadius: 8,
    padding: '3px 10px',
    fontSize: 12,
    cursor: 'pointer',
  },
  hideNotice: {
    marginTop: 6,
    maxWidth: 300,
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1.35,
    textAlign: 'center' as const,
    color: '#F2F2F7',
    background: 'rgba(28,28,30,0.95)',
    padding: '6px 12px',
    borderRadius: 12,
  },
  sizeToast: {
    marginTop: 6,
    fontSize: 12,
    fontWeight: 600,
    color: '#F2F2F7',
    background: 'rgba(28,28,30,0.92)',
    padding: '3px 10px',
    borderRadius: 999,
  },
  pillDivider: {
    width: 1,
    height: 14,
    background: 'rgba(255,255,255,0.22)',
    margin: '0 2px',
    flexShrink: 0,
  },
  btn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    // colour, hover and active looks: .robot-btn in global.css
  },
  micActive: {
    background: 'rgba(255,69,58,0.25)',
    color: '#FF453A',
  },
  micBusy: {
    background: 'rgba(255,159,10,0.15)',
    color: '#FF9F0A',
  },
  micBadge: {
    marginTop: 4,
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: '0.03em',
    textAlign: 'center' as const,
    maxWidth: 260,
  },
  picker: {
    // Full-window overlay — the compact mascot window has no room to stack it.
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(20,20,22,0.97)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 14,
    padding: 12,
    display: 'flex',
    flexDirection: 'column' as const,
    backdropFilter: 'blur(24px)',
    WebkitBackdropFilter: 'blur(24px)',
    boxShadow: '0 4px 24px rgba(0,0,0,0.45)',
    animation: 'bubbleIn 0.2s ease-out',
    zIndex: 50,
    WebkitAppRegion: 'no-drag' as unknown as string,
  },
  pickerHead: {
    fontSize: 10,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.5)',
    marginBottom: 6,
    letterSpacing: '0.02em',
  },
  pickerScroll: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    flex: 1,
    minHeight: 0,
    overflowY: 'auto' as const,
  },
  pickerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 6px',
    borderRadius: 8,
    cursor: 'pointer',
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.04)',
    textAlign: 'left' as const,
    width: '100%',
    transition: 'background 0.1s',
  },
  pickerThumb: {
    width: 44,
    height: 28,
    borderRadius: 4,
    objectFit: 'cover' as const,
    flexShrink: 0,
    border: '1px solid rgba(255,255,255,0.06)',
  },
  pickerName: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.6)',
    lineHeight: 1.3,
  },
  pickerCancel: {
    marginTop: 4,
    fontSize: 9,
    color: 'rgba(255,255,255,0.2)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    width: '100%',
    textAlign: 'center' as const,
    padding: 3,
  },
  noticeTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: 'rgba(255,255,255,0.9)',
    marginBottom: 6,
  },
  noticeText: {
    flex: 1,
    fontSize: 11,
    color: 'rgba(255,255,255,0.7)',
    lineHeight: 1.5,
    overflowY: 'auto' as const,
  },
  noticeButtons: {
    display: 'flex',
    gap: 6,
    marginTop: 8,
  },
  noticeCancel: {
    flex: 1,
    fontSize: 11,
    padding: '6px 8px',
    borderRadius: 8,
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.1)',
    color: 'rgba(255,255,255,0.7)',
    cursor: 'pointer',
  },
  noticeContinue: {
    flex: 1,
    fontSize: 11,
    fontWeight: 600,
    padding: '6px 8px',
    borderRadius: 8,
    background: '#FF6B2B',
    border: 'none',
    color: '#fff',
    cursor: 'pointer',
  },
}
