// REAL Windows: two windows with the SAME title, and MyBuildy's real paste
// sequence (performSend with the real PowerShell send script, the real
// clipboard and real keystrokes). The paste must land only in the window that
// was picked — identified by its handle and owning process — or be refused;
// never in the other window with the same title. Runs only on Windows (the
// e2e-windows CI job runs it); skipped elsewhere.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { performSend, type SendCommand, type SendExit, type SendTarget } from './prompt-sender-core'

const isWindows = process.platform === 'win32'
const SAME_TITLE = 'MyBuildy paste test - Windows PowerShell'

// A WinForms window with one text box that has focus. It reports its handle
// and process id, writes the text box's contents to a file every 100 ms, and
// takes commands (activate / retitle / close) from a command file.
const FORM_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = $env:FORM_TITLE
$f.Width = 500; $f.Height = 300
$f.StartPosition = 'Manual'; $f.Left = [int]$env:FORM_LEFT; $f.Top = 100
$tb = New-Object System.Windows.Forms.TextBox
$tb.Multiline = $true; $tb.Dock = 'Fill'
$f.Controls.Add($tb)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
  [IO.File]::WriteAllText($env:FORM_OUT, $tb.Text)
  if (Test-Path $env:FORM_CMD) {
    $c = [IO.File]::ReadAllText($env:FORM_CMD); Remove-Item $env:FORM_CMD
    if ($c.StartsWith('retitle:')) { $f.Text = $c.Substring(8) }
    elseif ($c -eq 'close') { $f.Close() }
    elseif ($c -eq 'activate') { $f.Activate(); $tb.Focus() }
  }
})
$f.Add_Shown({ [Console]::Out.WriteLine('hwnd=' + $f.Handle.ToInt64() + ' pid=' + $PID); [Console]::Out.Flush(); $f.Activate(); [void]$tb.Focus() })
$timer.Start()
[void]$f.ShowDialog()
`

interface TestWindow { hwnd: string; pid: number; text(): string; command(c: string): Promise<void>; proc: ChildProcess }

let dir = ''
const windows: TestWindow[] = []

async function openWindow(name: string, left: number, title = SAME_TITLE): Promise<TestWindow> {
  const out = join(dir, `${name}.txt`)
  const cmd = join(dir, `${name}.cmd`)
  const proc = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', FORM_SCRIPT], {
    env: { ...process.env, FORM_TITLE: title, FORM_OUT: out, FORM_CMD: cmd, FORM_LEFT: String(left) },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const ids = await new Promise<{ hwnd: string; pid: number }>((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error(`window ${name} did not open`)), 30_000)
    proc.stdout!.on('data', (d) => {
      buf += String(d)
      const m = /hwnd=(\d+) pid=(\d+)/.exec(buf)
      if (m) { clearTimeout(timer); resolve({ hwnd: m[1], pid: Number(m[2]) }) }
    })
  })
  const w: TestWindow = {
    ...ids,
    proc,
    text: () => (existsSync(out) ? readFileSync(out, 'utf8') : ''),
    command: async (c) => { writeFileSync(cmd, c); await delay(400) },
  }
  windows.push(w)
  await delay(500)
  return w
}

function setClipboard(text: string): void {
  spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', 'Set-Clipboard -Value $env:MYBUILDY_TEST_CLIP'], { env: { ...process.env, MYBUILDY_TEST_CLIP: text } })
}

function runScript(command: SendCommand): Promise<SendExit> {
  return new Promise((resolve) => {
    const child = spawn(command.exe, command.args, { env: { ...process.env, ...command.env }, windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill(); resolve(null) }, 15_000)
    child.on('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
}

/** MyBuildy's real paste of `marker` into `picked`, with the window's pick-time title. */
async function paste(marker: string, picked: TestWindow, title = SAME_TITLE): Promise<{ sent: boolean; reason?: string }> {
  const target = { title, sourceId: `window:${picked.hwnd}:0`, ownerPid: picked.pid } as SendTarget
  const result = await performSend(marker, target, {
    platform: 'win32',
    writeClipboard: setClipboard,
    isAccessibilityTrusted: () => true,
    requestAccessibilityPrompt: () => {},
    runScript,
    log: (m) => console.log(m),
  })
  await delay(800) // let the forms write their text out
  return result
}

describe.skipIf(!isWindows)('Paste into terminal, two windows with the same title (real Windows)', () => {
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'mybuildy-paste-')) })
  afterEach(() => { for (const w of windows.splice(0)) { try { w.proc.kill() } catch { /* gone */ } } })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  it('the OTHER same-title window is in front: the paste goes to the picked window, or nowhere — never to the other one', async () => {
    const picked = await openWindow('picked', 50)
    const other = await openWindow('other', 600)
    await other.command('activate') // the other one is in front, as when the user just used it
    const result = await paste('PASTE-ONE', picked)
    console.log('[test] result', JSON.stringify(result), 'picked:', JSON.stringify(picked.text()), 'other:', JSON.stringify(other.text()))
    expect(other.text()).not.toContain('PASTE-ONE')
    if (result.sent) expect(picked.text()).toContain('PASTE-ONE')
  }, 90_000)

  it('the picked window was closed: nothing is pasted into the other same-title window, and the reason says it is gone', async () => {
    const picked = await openWindow('picked', 50)
    const other = await openWindow('other', 600)
    await picked.command('close')
    await delay(500)
    const result = await paste('PASTE-TWO', picked)
    expect(other.text()).not.toContain('PASTE-TWO')
    expect(result).toMatchObject({ sent: false, reason: 'window_gone' })
  }, 90_000)

  it('the picked window was retitled and another window now has its old title: the paste still goes only to the picked window', async () => {
    const picked = await openWindow('picked', 50)
    const other = await openWindow('other', 600)
    await picked.command('retitle:✳ Claude Code is working')
    await other.command('activate')
    const result = await paste('PASTE-THREE', picked) // pick-time title = the other window's title now
    expect(other.text()).not.toContain('PASTE-THREE')
    expect(result.sent).toBe(true)
    expect(picked.text()).toContain('PASTE-THREE')
  }, 90_000)

  it('the window handle now belongs to a different process than at pick time: refused, nothing pasted anywhere', async () => {
    const picked = await openWindow('picked', 50)
    const other = await openWindow('other', 600)
    const result = await paste('PASTE-FOUR', { ...picked, pid: other.pid })
    expect(result).toMatchObject({ sent: false, reason: 'window_changed' })
    expect(picked.text()).not.toContain('PASTE-FOUR')
    expect(other.text()).not.toContain('PASTE-FOUR')
  }, 90_000)

  it('happy path: the picked window gets the prompt — and Enter is never pressed', async () => {
    const picked = await openWindow('picked', 50)
    const result = await paste('PASTE-FIVE', picked)
    expect(result.sent).toBe(true)
    expect(picked.text()).toBe('PASTE-FIVE') // exactly the prompt: no newline (Enter) after it
  }, 90_000)
})
