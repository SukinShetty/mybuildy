// GuidancePanel.tsx
// The guidance content, rendered in its OWN floating window (see
// main/guidance-window.ts) so it can never overflow or push the mascot.
//
// Renders one of two payloads pushed from the main process:
//   - kind 'analysis' — alignment pill + note + best next move + prompt-to-paste
//   - kind 'answer'   — the user's spoken question + MyBuildy's answer
//
// Self-managing behaviour:
//   - Reports its content height to main so the window resizes to fit (capped at
//     80% screen; scrolls internally beyond that).
//   - Auto-hides 60s after the user last interacted with it.
//   - Dismiss (X) hides the window immediately.

import React, { useEffect, useRef, useState, useCallback } from 'react'
import type {
  GuidancePayload, GoalAlignment, AnalysisResult, QuestionAnswer, AnswerSuggestion, VerificationStatus,
  SendEligibility, MacPermission,
} from '../types'
import {
  MAC_PERMISSION_MESSAGES, permissionForSendFailure, PASTE_BUTTON_LABEL, PASTE_SUCCESS_MESSAGE, pasteFailureMessage,
} from '../types'
import { HandoffCard } from './HandoffCard'
import { handoffRef } from '../handoff'
import { suggestionCopyText, doneWhenLine } from '../answer-suggestion'

const AUTO_HIDE_MS = 60_000

// Analyses whose hand-off card was dismissed (Skip for now / decision saved):
// main re-sends the same analysis when a background pass patches it, and the
// card must not reappear for it.
const dismissedHandoffs = new Set<string>()

// Until main pushes real eligibility, the send button stays safely disabled.
const DEFAULT_SEND_ELIGIBILITY: SendEligibility = {
  canSend: false,
  sendBlockedReason: 'Waiting for the next analysis',
}

export function GuidancePanel(): React.ReactElement | null {
  const [payload, setPayload] = useState<GuidancePayload | null>(null)
  const [renderKey, setRenderKey] = useState(0)
  const [speakingChunk, setSpeakingChunk] = useState<string | null>(null)
  const [sendEligibility, setSendEligibility] = useState<SendEligibility>(DEFAULT_SEND_ELIGIBILITY)
  const panelRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Which sentence is currently being spoken (Invariant 6 — keep voice + text in sync).
  useEffect(() => {
    const unsub = window.mybuildy.onSpeechProgress((_: unknown, chunkText: string | null) => {
      setSpeakingChunk(chunkText)
    })
    return () => unsub()
  }, [])

  // Send eligibility — main decides, we only render (disabled button + tooltip).
  useEffect(() => {
    const unsub = window.mybuildy.onSendEligibility((_: unknown, state: SendEligibility) => {
      setSendEligibility(state)
    })
    return () => unsub()
  }, [])

  // Project switched: drop whatever guidance was showing for the old project.
  useEffect(() => window.mybuildy.onProjectSwitched(() => setPayload(null)), [])

  // ─── Auto-hide timer (resets on every interaction / new payload) ────────────

  const resetHideTimer = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => {
      window.mybuildy.hideGuidance()
    }, AUTO_HIDE_MS)
  }, [])

  // ─── Receive payloads from main ─────────────────────────────────────────────

  useEffect(() => {
    const unsub = window.mybuildy.onGuidanceData((_: unknown, p: GuidancePayload) => {
      setPayload(p)
      setRenderKey((k) => k + 1) // re-trigger the entrance animation
      resetHideTimer()
    })
    return () => {
      unsub()
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
  }, [resetHideTimer])

  // ─── Report content height to main so the window fits the panel ─────────────

  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const report = (): void => {
      // scrollHeight includes padding and full content even when scrolling.
      window.mybuildy.resizeGuidance(el.scrollHeight + 16)
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [payload, renderKey])

  if (!payload) return null

  function onInteract(): void {
    resetHideTimer()
  }

  return (
    <div style={S.root} onMouseMove={onInteract} onClick={onInteract} onKeyDown={onInteract}>
      <div ref={panelRef} style={S.panel} key={renderKey} className="guidance-appear">
        <button
          onClick={() => window.mybuildy.hideGuidance()}
          style={S.close}
          title="Dismiss"
          aria-label="Dismiss"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="5" y1="5" x2="19" y2="19" />
            <line x1="19" y1="5" x2="5" y2="19" />
          </svg>
        </button>

        {payload.kind === 'analysis' && (
          <AnalysisBody analysis={payload.analysis} sendEligibility={sendEligibility} />
        )}
        {payload.kind === 'answer' && <AnswerBody answer={payload.answer} />}
        {payload.kind === 'message' && <div style={S.message}>{payload.message}</div>}
        {payload.kind === 'permission' && <PermissionNotice permission={payload.permission} />}

        {speakingChunk && (
          <div style={S.speaking}>
            <span style={S.speakingDot} /> {speakingChunk}
          </div>
        )}
      </div>

      <PanelStyle />
    </div>
  )
}

// ─── macOS permission notice ───────────────────────────────────────────────────

/** Exactly what to turn on, plus a button that opens that System Settings pane. */
function PermissionNotice({ permission }: { permission: MacPermission }): React.ReactElement {
  return (
    <div style={S.permission}>
      <div style={S.permissionText}>{MAC_PERMISSION_MESSAGES[permission]}</div>
      <button
        style={S.permissionBtn}
        onClick={() => { void window.mybuildy.openPermissionSettings(permission) }}
      >
        Open System Settings
      </button>
    </div>
  )
}

// ─── Analysis body ─────────────────────────────────────────────────────────────

/** Display name for the model-reported agent; null means "unknown agent". */
function agentDisplayName(agentName: AnalysisResult['agentName']): string | null {
  if (agentName === 'claude_code') return 'Claude Code'
  if (agentName === 'codex') return 'Codex'
  return null
}

function AnalysisBody({
  analysis,
  sendEligibility,
}: {
  analysis: AnalysisResult
  sendEligibility: SendEligibility
}): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [sendError, setSendError] = useState<string | null>(null)
  // After a successful paste: remind the user to read the prompt and press Enter themselves.
  const [pastedNote, setPastedNote] = useState(false)
  // Destructive-prompt guard (speed bump, not a sandbox — main computed the
  // verdict): the first click only ARMS the send and shows the reason in red;
  // a second deliberate click actually sends.
  const [guardArmed, setGuardArmed] = useState(false)
  // macOS: a send that failed for a missing permission shows the fix inline.
  const [permissionNeeded, setPermissionNeeded] = useState<MacPermission | null>(null)

  const isMac = window.mybuildy.platform === 'darwin'
  // Windows and macOS paste into the terminal; other platforms only copy.
  const canKeySend = window.mybuildy.platform === 'win32' || isMac
  const agentLabel = agentDisplayName(analysis.agentName)
  const guard = analysis.sendGuard ?? null

  // A different displayed prompt (fresh promptId) resets the armed state and notes.
  useEffect(() => {
    setGuardArmed(false)
    setPastedNote(false)
  }, [analysis.promptId])

  async function copyPrompt(): Promise<void> {
    if (!analysis.nextPrompt) return
    try {
      // Route through main — this window is non-focusable, so navigator.clipboard
      // would reject with "Document is not focused".
      await window.mybuildy.copyText(analysis.nextPrompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch (e) {
      console.warn('[GuidancePanel] Copy failed:', e)
    }
  }

  // Windows + macOS: send ONLY the prompt id — main resolves the text, pastes it
  // (never presses Enter) and decides. Main leaves the prompt on the clipboard
  // itself when a paste could not complete, so nothing is copied from here.
  async function sendPrompt(): Promise<void> {
    if (!analysis.nextPrompt || !analysis.promptId || sendState === 'sending') return
    setSendState('sending')
    setSendError(null)
    setPastedNote(false)
    setPermissionNeeded(null)
    try {
      const result = await window.mybuildy.sendPromptToWindow(analysis.promptId)
      if (result.sent) {
        setSendState('sent')
        setPastedNote(true)
        setTimeout(() => setSendState('idle'), 2000)
        return
      }
      console.warn('[GuidancePanel] Paste did not happen:', result.reason)
      setSendState('idle')
      const permission = permissionForSendFailure(result.reason)
      if (permission) {
        setPermissionNeeded(permission) // stays until the next attempt
        return
      }
      setSendError(pasteFailureMessage(result, isMac))
      setTimeout(() => setSendError(null), 9000)
    } catch (e) {
      console.warn('[GuidancePanel] Paste failed:', e)
      try { await window.mybuildy.copyText(analysis.nextPrompt) } catch { /* clipboard best-effort */ }
      setSendState('idle')
      setSendError(pasteFailureMessage({ sent: false, reason: 'unknown' }, isMac))
      setTimeout(() => setSendError(null), 9000)
    }
  }

  // Windows + macOS: the guard demands a second, deliberate click when it matched.
  function handleSendClick(): void {
    if (guard && !guardArmed) {
      setGuardArmed(true) // first click: arm + show the reason — never send
      return
    }
    void sendPrompt()
  }

  // Other platforms (Linux): the primary button only copies.
  async function copyForAgent(): Promise<void> {
    if (!analysis.nextPrompt) return
    try {
      await window.mybuildy.copyText(analysis.nextPrompt)
      setSendState('sent')
      setTimeout(() => setSendState('idle'), 2000)
    } catch (e) {
      console.warn('[GuidancePanel] Copy failed:', e)
    }
  }

  const sendActionLabel = PASTE_BUTTON_LABEL
  const sendLabel = !canKeySend
    ? (sendState === 'sent' ? 'Copied!' : agentLabel ? `Copy for ${agentLabel}` : 'Copy prompt')
    : sendState === 'sending' ? 'Pasting…'
    : sendState === 'sent' ? 'Pasted'
    : guard && !guardArmed ? 'Review first'
    : sendActionLabel
  const sendDisabled = canKeySend
    ? (!sendEligibility.canSend || sendState === 'sending')
    : false

  return (
    <>
      {analysis.verification && (
        <VerificationBadge status={analysis.verification.status} note={analysis.verification.note} />
      )}

      {analysis.needsHumanJudgment && !dismissedHandoffs.has(analysis.analyzedAt) && (
        // Keyed by reason: dismissing one hand-off must not hide a DIFFERENT
        // later hand-off (the key remounts the card, resetting its state).
        <HandoffCard
          key={analysis.humanJudgmentReason || 'handoff'}
          reason={analysis.humanJudgmentReason}
          // Either button means the user has seen and handled the alert.
          onResolved={() => {
            const ref = handoffRef(analysis)
            if (ref) window.mybuildy.resolveHandoff(ref)
          }}
          onDismissed={() => dismissedHandoffs.add(analysis.analyzedAt)}
        />
      )}

      {analysis.goalAlignment && (
        <AlignmentPill alignment={analysis.goalAlignment} note={analysis.alignmentNote} />
      )}

      {analysis.projectUnderstandingNote && (
        <div style={S.understanding}>
          MyBuildy thinks you're building: {analysis.projectUnderstandingNote}
        </div>
      )}

      {analysis.whatIsHappening && (
        <div style={S.context}>{analysis.whatIsHappening}</div>
      )}

      {analysis.bestNextMove && (
        <div style={S.guidance}>{analysis.bestNextMove}</div>
      )}

      {analysis.nextPrompt && (
        <div style={S.promptCard}>
          <div style={S.promptHeader}>
            <span style={S.promptLabel}>Prompt to paste</span>
            <div style={S.promptActions}>
              <button onClick={copyPrompt} style={S.copyBtn} title="Copy prompt">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                {copied ? 'Copied!' : 'Copy'}
              </button>
              <button
                onClick={canKeySend ? handleSendClick : copyForAgent}
                disabled={sendDisabled}
                style={{ ...S.sendBtn, ...(sendDisabled ? S.sendBtnDisabled : {}) }}
                title={sendDisabled && sendEligibility.sendBlockedReason ? sendEligibility.sendBlockedReason : sendLabel}
              >
                {sendLabel}
              </button>
            </div>
          </div>
          <div style={S.promptText} data-selectable>{analysis.nextPrompt}</div>
          {canKeySend && guard && guardArmed && (
            <div style={S.guardWarning}>
              {guard.reason} Click {sendActionLabel} again to paste it anyway.
            </div>
          )}
          {/* Paste is off right now: say why where people look, not only in a tooltip. */}
          {sendDisabled && sendState !== 'sending' && sendEligibility.sendBlockedReason && (
            <div style={S.sendError} data-testid="paste-blocked">
              Paste is off: {sendEligibility.sendBlockedReason.replace(/\.$/, '')}. Use Copy instead.
            </div>
          )}
          {pastedNote && <div style={S.pastedNote} role="status">{PASTE_SUCCESS_MESSAGE}</div>}
          {sendError && <div style={S.sendError}>{sendError}</div>}
          {permissionNeeded && <PermissionNotice permission={permissionNeeded} />}
        </div>
      )}

      {/* Cost-guard footer: provider calls in the current rolling hour. */}
      {typeof analysis.callsThisHour === 'number' && (
        <div style={S.callsFooter}>
          {analysis.callsThisHour} {analysis.callsThisHour === 1 ? 'call' : 'calls'} this hour
        </div>
      )}
    </>
  )
}

// ─── Verification badge (Block 4 — did the last prompt work?) ────────────────────

const VERIFICATION: Record<VerificationStatus, { icon: string; label: string; color: string; gradient: string }> = {
  success: {
    icon: '✓',
    label: 'Previous step verified',
    color: '#10B981',
    gradient: 'linear-gradient(135deg, rgba(16,185,129,0.18), rgba(16,185,129,0.08))',
  },
  failed: {
    icon: '⚠',
    label: "Previous prompt didn't fully work",
    color: '#EF4444',
    gradient: 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(239,68,68,0.08))',
  },
  partial: {
    icon: '↻',
    label: 'Partial progress',
    color: '#FBBF24',
    gradient: 'linear-gradient(135deg, rgba(251,191,36,0.18), rgba(251,191,36,0.08))',
  },
}

function VerificationBadge({
  status,
  note,
}: {
  status: VerificationStatus
  note: string
}): React.ReactElement {
  const cfg = VERIFICATION[status]
  return (
    <div style={S.verifyRow}>
      <span
        style={{
          ...S.pill,
          color: cfg.color,
          background: cfg.gradient,
          border: `1px solid ${cfg.color}55`,
        }}
      >
        <span style={{ fontWeight: 700 }}>{cfg.icon}</span>
        {cfg.label}
      </span>
      {note && <div style={{ ...S.alignmentNote, marginTop: 8 }}>{note}</div>}
    </div>
  )
}

// ─── Answer body (spoken Q&A) ───────────────────────────────────────────────────

function AnswerBody({ answer }: { answer: QuestionAnswer }): React.ReactElement {
  const [copied, setCopied] = useState(false)

  async function copyAnswer(): Promise<void> {
    try {
      await window.mybuildy.copyText(answer.answer)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch (e) {
      console.warn('[GuidancePanel] Copy failed:', e)
    }
  }

  // All answer text is selectable, so any part of it can be highlighted and copied.
  return (
    <>
      <div style={S.questionLabel}>You asked</div>
      <div style={S.questionText} data-selectable>{answer.question}</div>
      <div style={S.guidance} data-selectable>{answer.answer}</div>
      {answer.suggestion && <SuggestionBox suggestion={answer.suggestion} />}
      <div style={S.answerFooter}>
        <button onClick={copyAnswer} style={S.copyBtn} title="Copy answer">
          <CopyIcon />
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </>
  )
}

function CopyIcon(): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
  )
}

/**
 * A goal or prompt the user asked for, in its own box beneath the reply. Its
 * Copy button copies only the suggestion (answer-suggestion.ts), never the reply.
 */
export function SuggestionBox({ suggestion }: { suggestion: AnswerSuggestion }): React.ReactElement {
  const [copied, setCopied] = useState(false)

  async function copySuggestion(): Promise<void> {
    try {
      await window.mybuildy.copyText(suggestionCopyText(suggestion))
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch (e) {
      console.warn('[GuidancePanel] Copy failed:', e)
    }
  }

  const label = suggestion.kind === 'goal' ? 'Suggested goal' : 'Prompt for your agent'
  return (
    <div style={S.promptCard} data-testid="answer-suggestion">
      <div style={S.promptHeader}>
        <span style={S.promptLabel}>{label}</span>
        <div style={S.promptActions}>
          <button onClick={copySuggestion} style={S.copyBtn} title={`Copy ${suggestion.kind === 'goal' ? 'goal' : 'prompt'}`}>
            <CopyIcon />
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
      <div style={S.promptText} data-selectable>{suggestion.text}</div>
      {suggestion.kind === 'goal' && suggestion.doneWhen && (
        <div style={{ ...S.promptText, marginTop: 6 }} data-selectable>{doneWhenLine(suggestion.doneWhen)}</div>
      )}
    </div>
  )
}

// ─── Alignment pill ─────────────────────────────────────────────────────────────

const ALIGNMENT: Record<GoalAlignment, { label: string; color: string; gradient: string }> = {
  'on-track': {
    label: 'ON TRACK',
    color: '#10B981',
    gradient: 'linear-gradient(135deg, rgba(16,185,129,0.18), rgba(16,185,129,0.08))',
  },
  drift: {
    label: 'DRIFTING',
    color: '#FBBF24',
    gradient: 'linear-gradient(135deg, rgba(251,191,36,0.18), rgba(251,191,36,0.08))',
  },
  blocked: {
    label: 'BLOCKED',
    color: '#EF4444',
    gradient: 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(239,68,68,0.08))',
  },
}

function AlignmentPill({
  alignment,
  note,
}: {
  alignment: GoalAlignment
  note?: string
}): React.ReactElement {
  const cfg = ALIGNMENT[alignment]
  const showNote = alignment !== 'on-track' && !!note
  return (
    <>
      <div style={S.pillRow}>
        <span
          style={{
            ...S.pill,
            color: cfg.color,
            background: cfg.gradient,
            border: `1px solid ${cfg.color}55`,
          }}
        >
          <span style={{ ...S.pillDot, background: cfg.color }} />
          {cfg.label}
        </span>
      </div>
      {showNote && <div style={S.alignmentNote}>{note}</div>}
    </>
  )
}

// ─── Entrance + scrollbar styles ────────────────────────────────────────────────

function PanelStyle(): React.ReactElement {
  return (
    <style>{`
      .guidance-appear {
        animation: guidanceIn 0.25s ease-out;
      }
      @keyframes guidanceIn {
        from { opacity: 0; transform: translateX(-12px); }
        to   { opacity: 1; transform: translateX(0); }
      }
      @keyframes guidancePulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }
      .guidance-appear::-webkit-scrollbar { width: 6px; }
      .guidance-appear::-webkit-scrollbar-track { background: transparent; }
      .guidance-appear::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.15);
        border-radius: 3px;
      }
      .guidance-appear::-webkit-scrollbar-thumb:hover {
        background: rgba(255,255,255,0.25);
      }
    `}</style>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────────

const FONT = 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const MONO = '"JetBrains Mono", "SF Mono", "Cascadia Code", Consolas, monospace'

const S = {
  root: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: 0,
    background: 'transparent',
    fontFamily: FONT,
  },
  panel: {
    position: 'relative' as const,
    width: '100%',
    maxWidth: 380,
    maxHeight: '100vh',
    overflowY: 'auto' as const,
    boxSizing: 'border-box' as const,
    background: 'rgba(20, 20, 22, 0.92)',
    backdropFilter: 'blur(24px) saturate(180%)',
    WebkitBackdropFilter: 'blur(24px) saturate(180%)',
    borderRadius: 20,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05) inset',
    padding: 20,
    display: 'flex',
    flexDirection: 'column' as const,
  },
  close: {
    position: 'absolute' as const,
    top: 14,
    right: 14,
    width: 20,
    height: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    background: 'transparent',
    color: 'rgba(255,255,255,0.4)',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    transition: 'color 0.15s, background 0.15s',
  },
  pillRow: {
    display: 'flex',
    alignItems: 'center',
    paddingRight: 24, // leave room for the close button
  },
  verifyRow: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'flex-start',
    paddingRight: 24, // leave room for the close button
    marginBottom: 14,
  },
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    padding: '4px 10px',
    borderRadius: 999,
  },
  pillDot: {
    width: 5,
    height: 5,
    borderRadius: '50%',
    flexShrink: 0,
  },
  alignmentNote: {
    marginTop: 12,
    fontSize: 13,
    fontWeight: 400,
    fontStyle: 'italic' as const,
    color: 'rgba(255,255,255,0.65)',
    lineHeight: 1.55,
  },
  understanding: {
    marginTop: 12,
    fontSize: 12,
    fontWeight: 400,
    fontStyle: 'italic' as const,
    color: 'rgba(255,255,255,0.5)',
    lineHeight: 1.5,
  },
  context: {
    marginTop: 12,
    fontSize: 12,
    fontWeight: 400,
    color: 'rgba(255,255,255,0.45)',
    lineHeight: 1.5,
  },
  guidance: {
    marginTop: 16,
    fontSize: 15,
    fontWeight: 500,
    color: 'rgba(255,255,255,0.95)',
    lineHeight: 1.6,
  },
  promptCard: {
    marginTop: 16,
    background: 'rgba(16,185,129,0.06)',
    border: '1px solid rgba(16,185,129,0.2)',
    borderRadius: 12,
    padding: 14,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  },
  promptHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  promptLabel: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.1em',
    color: 'rgba(16,185,129,0.7)',
  },
  promptText: {
    fontSize: 13,
    color: '#10B981',
    lineHeight: 1.55,
    fontFamily: MONO,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    userSelect: 'text' as const,
  },
  copyBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10,
    fontWeight: 600,
    padding: '4px 9px',
    borderRadius: 7,
    background: 'rgba(16,185,129,0.12)',
    color: '#10B981',
    border: '1px solid rgba(16,185,129,0.3)',
    cursor: 'pointer',
    transition: 'background 0.15s',
    flexShrink: 0,
  },
  promptActions: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
  sendBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10,
    fontWeight: 700,
    padding: '4px 10px',
    borderRadius: 7,
    background: '#10B981',
    color: '#08110D',
    border: '1px solid rgba(16,185,129,0.9)',
    cursor: 'pointer',
    transition: 'background 0.15s, opacity 0.15s',
    flexShrink: 0,
  },
  sendBtnDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  sendError: {
    fontSize: 11,
    fontStyle: 'italic' as const,
    color: '#FBBF24',
    lineHeight: 1.5,
  },
  // After a successful paste: the user runs it themselves.
  pastedNote: {
    fontSize: 11,
    fontWeight: 600,
    color: '#34D399',
    lineHeight: 1.5,
  },
  // macOS permission notice (amber) with its Open System Settings button.
  permission: {
    marginTop: 8,
    padding: '10px 12px',
    borderRadius: 10,
    background: 'rgba(251,191,36,0.10)',
    border: '1px solid rgba(251,191,36,0.35)',
    paddingRight: 24, // clear the close button when shown on its own
  },
  permissionText: {
    fontSize: 12,
    color: '#FDE68A',
    lineHeight: 1.55,
  },
  permissionBtn: {
    marginTop: 8,
    fontSize: 11,
    fontWeight: 600,
    padding: '5px 10px',
    borderRadius: 7,
    background: 'rgba(251,191,36,0.18)',
    color: '#FBBF24',
    border: '1px solid rgba(251,191,36,0.45)',
    cursor: 'pointer',
  },
  // Destructive-prompt guard reason — red, shown once the first click armed it.
  guardWarning: {
    fontSize: 11,
    fontWeight: 600,
    color: '#EF4444',
    lineHeight: 1.5,
  },
  callsFooter: {
    marginTop: 12,
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: '0.04em',
    color: 'rgba(255,255,255,0.35)',
    textAlign: 'right' as const,
  },
  questionLabel: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    color: 'rgba(255,255,255,0.4)',
    paddingRight: 24,
  },
  questionText: {
    marginTop: 8,
    fontSize: 13,
    fontStyle: 'italic' as const,
    color: 'rgba(255,255,255,0.6)',
    lineHeight: 1.5,
  },
  answerFooter: {
    marginTop: 14,
    display: 'flex',
    justifyContent: 'flex-end',
  },
  message: {
    fontSize: 14,
    fontWeight: 400,
    color: 'rgba(255,255,255,0.7)',
    lineHeight: 1.6,
    paddingRight: 24, // clear the close button
  },
  speaking: {
    marginTop: 14,
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    fontSize: 12,
    fontStyle: 'italic' as const,
    color: '#10B981',
    lineHeight: 1.5,
    background: 'rgba(16,185,129,0.08)',
    border: '1px solid rgba(16,185,129,0.18)',
    borderRadius: 10,
    padding: '8px 10px',
  },
  speakingDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#10B981',
    marginTop: 5,
    flexShrink: 0,
    animation: 'guidancePulse 1s ease-in-out infinite',
  },
}
