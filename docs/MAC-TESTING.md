# Testing MyBuildy on a Mac

This is the first time MyBuildy runs on a real Mac. Everything below was built and unit-tested on macOS in CI, but **nobody has clicked through it on a Mac yet** — that is what this checklist is for. It takes about 20 minutes.

You will need: a Mac (Apple Silicon or Intel), a terminal app (Terminal, iTerm2, …) running an AI coding agent — [Claude Code](https://docs.anthropic.com/en/docs/claude-code) is the one tested so far, but any terminal agent or a plain shell works for this checklist — and an API key for Anthropic, OpenAI, Google Gemini or OpenRouter.

---

## 1. Install

1. From the release page, download the DMG for your Mac:
   - **Apple Silicon** (Apple menu > About This Mac says "Chip: Apple M…"): `MyBuildy-0.1.0-arm64.dmg`
   - **Intel** ("Processor: Intel…"): `MyBuildy-0.1.0-x64.dmg`
2. Open the DMG and drag **MyBuildy** into **Applications**.
3. Open **MyBuildy** from Applications. The app is signed with an Apple Developer ID and notarized by Apple, so it opens normally — macOS only asks once whether you want to open an app downloaded from the internet; click **Open**.

*If macOS blocks it instead* (for example "MyBuildy cannot be opened" or "is damaged"), that is a bug in the build: don't work around it — send a screenshot (see [section 3](#3-if-something-fails-what-to-send)).

---

## 2. The three macOS permissions

macOS will ask for these. If one is missing, MyBuildy shows a message on the mascot and in its guidance panel saying exactly what to turn on, with an **Open System Settings** button that goes straight to the right place.

| Permission | Where | Needed for | Restart needed? |
|---|---|---|---|
| **Screen Recording** (**Screen & System Audio Recording** on newer macOS) | System Settings > Privacy & Security > Screen Recording | Watching a window (without it macOS hands MyBuildy blank pictures) | **Yes — quit MyBuildy (right-click the Dock icon > Quit, or the menu bar icon > Quit MyBuildy) and open it again.** macOS ignores the permission until the app restarts. |
| **Accessibility** | System Settings > Privacy & Security > Accessibility | **Paste into terminal** (typing Cmd+V into your terminal) | No |
| **Automation → System Events** | System Settings > Privacy & Security > Automation > MyBuildy > System Events | **Paste into terminal** (same reason — macOS asks "MyBuildy wants to control System Events" the first time; click **OK**) | No |

macOS may also ask whether MyBuildy can use the **"MyBuildy Safe Storage"** keychain item when you save your API key. That is where your key is encrypted — choose **Always Allow**.

**To quit** (needed after granting Screen Recording): press **Cmd+Q** while MyBuildy is the active app, or right-click the Dock icon > **Quit**, or use the menu bar icon > **Quit MyBuildy**. Check the Dock: the icon's dot should disappear.

**If you install a newer build later:** the permissions should carry over, because every build is signed with the same Developer ID. If MyBuildy says one is missing while the switch in System Settings still looks **on**, select MyBuildy in that list, click **−**, then add it again with **+** — and tell us, because that shouldn't happen.

---

## 3. If something fails: what to send

For any step that doesn't match what it says you should see, send:

1. **Which step**, and what you saw instead.
2. **A screenshot** (Cmd+Shift+4, then drag over the area; it lands on your Desktop).
3. **Your Mac**: Apple menu > About This Mac — the chip (Apple M… or Intel) and the macOS version.
4. **The log**, captured like this:
   1. Quit MyBuildy (menu bar icon > Quit MyBuildy).
   2. In Terminal, run:

      ```bash
      /Applications/MyBuildy.app/Contents/MacOS/MyBuildy 2>&1 | tee ~/Desktop/mybuildy-log.txt
      ```

   3. Repeat the failing step, then quit MyBuildy and send **`mybuildy-log.txt`** from your Desktop. It contains lines like `[Send] …`, `[Watch] …`, `[Companion] …` and never contains your API key. (Keep this Terminal window out of the way — don't pick it as the window to watch.)

---

## 4. Checklist

Tick each one. "You should see" is what passing looks like.

**1. The app opens on the guided setup.**
Open MyBuildy from Applications.
*You should see:* the orange robot mascot floating on screen, the **setup** window open on **Welcome** ("Step 1 of 9"), a MyBuildy icon in the Dock and a small orange icon in the menu bar. Click **Let's set up (2 minutes)**.
*If not:* send the log (step 3 above).

**2. The mascot floats above a terminal.**
Click your terminal window, then make it full screen (green button, or Ctrl+Cmd+F).
*You should see:* the mascot stays on top of the terminal in both cases, including in full screen. Drag the mascot around by its body; drag it almost off the edge of the screen and let go.
*You should see:* it moves smoothly, and when dropped mostly off-screen it slides back fully on screen. New guidance appearing later never takes keyboard focus away from your terminal.
*If not:* screenshot + which terminal app + whether it was full screen.

**3. Your AI key and model (setup steps 2 and 3).**
Pick a provider, paste your API key (the **Where do I get a key?** link opens the provider's page), click **Next**. If macOS asks about the "MyBuildy Safe Storage" keychain item, choose **Always Allow**.
*You should see:* the model list with a **Suggested** model highlighted, checked automatically, then a green tick and "This model can see your screen".
*If not:* the exact message shown + the log.

**4. Let MyBuildy see your screen (setup step 4).**
*You should see:* one sentence on why, a grey status line, and an **Open System Settings** button. macOS may also show its own Screen Recording prompt here — that's expected. Click the button, turn on **MyBuildy** (Screen Recording, or **Screen & System Audio Recording** on newer macOS).
*You should see:* either the status turns green by itself, or — after you've opened System Settings — a **Restart MyBuildy** button. Click it: MyBuildy quits, reopens by itself, and setup continues **on this same step**, now green.
*If not:* screenshot of the step + screenshot of the Screen Recording list in System Settings + the log.

**5. Let MyBuildy paste for you (setup step 5), then the rest of setup.**
Click **Allow pasting**. macOS asks **"MyBuildy wants to control System Events"** — click **OK** — and shows its Accessibility prompt: click **Open System Settings** and turn on MyBuildy under Accessibility.
*You should see:* both status lines turn green by themselves. (Try **Skip — I'll paste myself** on a second run: setup moves on and pasting stays copy-only.) Then pick one of the four ready-made goals, follow **Open your coding agent** (Terminal: `mkdir my-project && cd my-project`, then `claude`), and on **Show MyBuildy your coding agent** click **Choose the window** and pick your terminal.
*You should see:* "MyBuildy is watching: <your terminal's title>", then **Finish**. The mascot's label says what to do next (for example **"Your prompt is ready — click Paste into terminal"**). No microphone prompt appears at any point during setup — only when you first click the mic.
*If not:* which step, what you saw instead + the log.

**6. The guidance panel shows an analysis.**
Wait up to ~30 seconds (or type something in the terminal).
*You should see:* a panel appears next to the mascot with an ON TRACK / DRIFTING / BLOCKED pill, a plain-English explanation of what's on screen, and usually a **Prompt to paste** with a **Paste into terminal** button.
*If not:* screenshot + the log.

**7. Paste into terminal pastes (and never submits).**
With your agent (or a shell) waiting for input in the watched terminal, click **Paste into terminal** in the panel.
- If you allowed pasting during setup, no macOS prompt should appear now.
- If you skipped it: the panel says what to turn on, with **Open System Settings**, and macOS asks **"MyBuildy wants to control System Events"** the first time — click **OK**.

*You should see:* the terminal comes to the front and the prompt is pasted but **not** run: MyBuildy never presses Return. The panel says **"Pasted into your terminal. Read it, then press Enter to run it."** and the mascot briefly says **Pasted**. Press Return yourself to run it.
*If not:* what happened in the terminal (nothing / pasted into another window / it ran without you pressing Return) + the log. If you had several windows of the same terminal app open, say so.

**8. A turn-end report arrives.**
After pasting, press Enter yourself, then let your agent (or your shell command) finish its work.
*You should see:* within about 10 seconds of it finishing, a fresh analysis in the guidance panel (and a spoken summary if voice is on). While it is still working, MyBuildy stays quiet.
*If not:* roughly how long it took (or never) + the log.

**9. Voice plays.**
Make sure quiet mode is off on the mascot (speaker icon).
*You should see / hear:* the guidance is read aloud — by the macOS system voice, or by ElevenLabs if you added that key in Settings.
*If not:* your Mac's output volume/device + the log.

**10. Delete all data returns to first run.**
Settings > **Delete all MyBuildy data** > confirm.
*You should see:* MyBuildy restarts to first run: the guided setup opens on **Welcome**, no key saved, no model selected, and the Memory tab is empty. (Settings also has **Run setup again**, which starts setup over without deleting anything.)
*If not:* screenshot + the log.

---

## Known limitation to watch for

Paste should only ever land in the **exact window you picked**, even when your terminal app has **several windows open with the same title**. MyBuildy brings the app forward, raises windows until the picked one is in front, and checks the front window's number right before Cmd+V; if it can't, nothing is pasted and the prompt stays on your clipboard. Please try it with two Terminal windows open, and report it with the log if the paste ever lands in the other one.

Thank you — every "it did something odd" report is useful.
