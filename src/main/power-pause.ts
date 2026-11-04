// power-pause.ts — when the wake word must pause for the computer's state.
// Sleep and screen lock are tracked SEPARATELY: listening resumes only when the
// computer is awake AND unlocked (resuming from sleep onto a lock screen keeps it
// paused). Pure; index.ts wires it to Electron's powerMonitor.

export interface PowerEvents {
  on(event: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen', fn: () => void): unknown
}

export class PowerPause {
  private asleep = false
  private locked: boolean
  private last: boolean | null = null

  constructor(private readonly send: (paused: boolean) => void, startLocked = false) {
    this.locked = startLocked
  }

  get paused(): boolean {
    return this.asleep || this.locked
  }

  attach(events: PowerEvents): this {
    events.on('suspend', () => this.update({ asleep: true }))
    events.on('resume', () => this.update({ asleep: false }))
    events.on('lock-screen', () => this.update({ locked: true }))
    events.on('unlock-screen', () => this.update({ locked: false }))
    if (this.paused) this.emit()
    return this
  }

  private update(change: { asleep?: boolean; locked?: boolean }): void {
    if (change.asleep !== undefined) this.asleep = change.asleep
    if (change.locked !== undefined) this.locked = change.locked
    this.emit()
  }

  private emit(): void {
    if (this.last === this.paused) return
    this.last = this.paused
    this.send(this.paused)
  }
}
