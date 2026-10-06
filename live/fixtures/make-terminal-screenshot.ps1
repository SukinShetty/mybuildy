# make-terminal-screenshot.ps1 — renders live/fixtures/terminal.jpg, the sample
# coding-agent terminal the live provider tests analyse. Re-run only to change
# the fixture: powershell -ExecutionPolicy Bypass -File live/fixtures/make-terminal-screenshot.ps1
Add-Type -AssemblyName System.Drawing

$lines = @(
  @{ c = 'Gray';   t = 'PS C:\Users\builder\habit-tracker> claude' },
  @{ c = 'Orange'; t = '* Welcome to Claude Code' },
  @{ c = 'White';  t = '' },
  @{ c = 'White';  t = '> Build a habit tracker web app: add habits, tick them off each day, show a 7-day streak.' },
  @{ c = 'White';  t = '' },
  @{ c = 'Green';  t = '* Created index.html (layout, habit list, add-habit form)' },
  @{ c = 'Green';  t = '* Created app.js (add habit, toggle today, save to localStorage)' },
  @{ c = 'Green';  t = '* Created styles.css' },
  @{ c = 'White';  t = '* Ran: npx vitest run' },
  @{ c = 'Green';  t = '    PASS  app.test.js > adds a habit' },
  @{ c = 'Green';  t = '    PASS  app.test.js > ticks a habit off for today' },
  @{ c = 'Red';    t = '    FAIL  app.test.js > shows a 7-day streak' },
  @{ c = 'Red';    t = '      Expected streak 3, received 0 (streak is not calculated yet)' },
  @{ c = 'White';  t = '    Tests  2 passed | 1 failed' },
  @{ c = 'White';  t = '' },
  @{ c = 'Orange'; t = '* The habit list and daily check-off work. The 7-day streak is not implemented yet,' },
  @{ c = 'Orange'; t = '  so its test fails. Want me to add the streak calculation next?' },
  @{ c = 'White';  t = '' },
  @{ c = 'Gray';   t = '> _' }
)

$width = 1280; $height = 720
$bmp = New-Object System.Drawing.Bitmap $width, $height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$g.Clear([System.Drawing.Color]::FromArgb(24, 24, 27))
$title = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(45, 45, 50))
$g.FillRectangle($title, 0, 0, $width, 34)
$font = New-Object System.Drawing.Font 'Consolas', 15
$titleFont = New-Object System.Drawing.Font 'Segoe UI', 11
$g.DrawString('Windows PowerShell - claude', $titleFont, [System.Drawing.Brushes]::Gainsboro, 14, 8)
$colors = @{
  Gray = [System.Drawing.Color]::FromArgb(160, 160, 170); White = [System.Drawing.Color]::FromArgb(235, 235, 235)
  Green = [System.Drawing.Color]::FromArgb(110, 210, 130); Red = [System.Drawing.Color]::FromArgb(240, 110, 110)
  Orange = [System.Drawing.Color]::FromArgb(230, 150, 90)
}
$y = 50
foreach ($l in $lines) {
  $brush = New-Object System.Drawing.SolidBrush $colors[$l.c]
  $g.DrawString($l.t, $font, $brush, 18, $y)
  $y += 32
}
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 85L
$out = Join-Path $PSScriptRoot 'terminal.jpg'
$bmp.Save($out, $codec, $params)
$g.Dispose(); $bmp.Dispose()
Write-Output "wrote $out"
