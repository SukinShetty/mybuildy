# Extra accents for the wake-word eval (Indian, Australian, Nigerian, South African,
# Singapore, US English) at three speaking rates, via edge-tts (a cloud TTS: these are
# SYNTHETIC test clips, generated on a developer machine, never part of the app).
# Usage: python3 scripts/eval-wake-word-voices.py OUT_DIR   (needs: pip install edge-tts; ffmpeg)
import asyncio, json, os, subprocess, sys
import edge_tts

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
data = json.load(open(os.path.join(os.path.dirname(__file__), 'eval-wake-word-data.json')))
VOICES = ['en-IN-NeerjaNeural', 'en-IN-PrabhatNeural', 'en-AU-NatashaNeural', 'en-NG-AbeoNeural',
          'en-ZA-LeahNeural', 'en-SG-WayneNeural', 'en-US-GuyNeural']
RATES = ['-15%', '+0%', '+20%']
items = [('wake', t, c) for t, c in data['wake']] + [('other', t, None) for t in data['other']]
manifest = []

async def one(voice, rate, kind, text, command, n):
    name = f'{voice}_{rate.replace("%", "")}_{n}'
    mp3, raw = os.path.join(out, name + '.mp3'), os.path.join(out, name + '.f32')
    if not os.path.exists(raw):
        for attempt in range(3):
            try:
                await edge_tts.Communicate(text, voice, rate=rate).save(mp3); break
            except Exception as e:
                if attempt == 2: print('skip', name, e); return
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', mp3, '-ac', '1', '-ar', '16000', '-f', 'f32le', raw], check=True)
        os.remove(mp3)
    manifest.append({'kind': kind, 'text': text, 'command': command, 'voice': voice, 'rate': rate, 'file': name + '.f32'})

async def main():
    sem = asyncio.Semaphore(8)
    async def run(*a):
        async with sem: await one(*a)
    jobs = [run(v, r, k, t, c, i) for v in VOICES for r in RATES for i, (k, t, c) in enumerate(items)]
    for kind, t in [('chat', t) for t in data['chat']]:
        jobs += [run(v, '+0%', kind, t, None, 1000 + data['chat'].index(t)) for v in VOICES]
    await asyncio.gather(*jobs)
    json.dump(manifest, open(os.path.join(out, 'manifest.json'), 'w'))
    print(len(manifest), 'clips')

asyncio.run(main())
