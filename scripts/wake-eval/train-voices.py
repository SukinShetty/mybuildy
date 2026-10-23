# Synthetic TRAINING clips for the "MyBuildy" keyword model (edge-tts; dev machine only).
# Voices here are DISJOINT from the eval voices (eval: en-IN Neerja/Prabhat, en-AU Natasha, en-NG Abeo,
# en-ZA Leah, en-SG Wayne, en-US Guy + the bundled voices), and the sentences differ from the eval ones.
# Resumable. python train-voices.py OUT_DIR
import asyncio, json, os, random, subprocess, sys
import edge_tts
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
EVAL = {'en-IN-NeerjaNeural', 'en-IN-NeerjaExpressiveNeural', 'en-IN-PrabhatNeural', 'en-AU-NatashaNeural', 'en-NG-AbeoNeural', 'en-ZA-LeahNeural', 'en-SG-WayneNeural', 'en-US-GuyNeural'}
VOICES = [v for v in '''en-AU-WilliamMultilingualNeural en-CA-ClaraNeural en-CA-LiamNeural en-GB-LibbyNeural en-GB-MaisieNeural en-GB-RyanNeural en-GB-SoniaNeural en-GB-ThomasNeural en-HK-SamNeural en-HK-YanNeural en-IE-ConnorNeural en-IE-EmilyNeural en-KE-AsiliaNeural en-KE-ChilembaNeural en-NG-EzinneNeural en-NZ-MitchellNeural en-NZ-MollyNeural en-PH-JamesNeural en-PH-RosaNeural en-SG-LunaNeural en-TZ-ElimuNeural en-TZ-ImaniNeural en-US-AnaNeural en-US-AndrewNeural en-US-AriaNeural en-US-AvaNeural en-US-BrianNeural en-US-ChristopherNeural en-US-EmmaNeural en-US-EricNeural en-US-JennyNeural en-US-MichelleNeural en-US-RogerNeural en-US-SteffanNeural en-ZA-LukeNeural'''.split() if v not in EVAL]
POS = ['MyBuildy', 'MyBuildy.', 'Hey MyBuildy', 'MyBuildy?', 'My Buildy', 'OK MyBuildy', 'MyBuildy!']
NEAR = ['my building', 'my billy', 'my buddy', 'my body', 'my bill', 'my baby', 'my build', 'maybe', 'my belly', 'my bitty',
        'mobility', 'my ability', 'my beauty', 'my birdie', 'my bully', 'buildy', 'building', 'mighty', 'my bead', 'my buddies',
        'hey buddy', 'okay billy', 'my builder', 'my bilberry', 'mai bills', 'my bidding', 'my pity', 'my city', 'my kitty', 'my guilty']
GEN = '''Can you run the tests again
I think the build is broken
Let me check the logs first
What does this error mean
Push it to the main branch
The deploy finished an hour ago
We should refactor this function
Open the settings page please
Did the migration work
I'll grab a coffee and come back
My building has a new lift
My billy goat ate the fence
My buddy fixed the router yesterday
My body needs some sleep
I paid my bill this morning
My baby is finally asleep
Maybe we should build it tomorrow
Build the project and ship it
This building is really tall
Bill said the meeting moved
The buddy system works well
Mobility is important for older people
I love my city at night
Pity the server went down
Install the dependencies first
The model keeps timing out
Turn on dark mode
Why is the page so slow
Commit and push the changes
Write a unit test for the parser
Hello, can you hear me
Okay, that looks right to me
Hey, what time is the standup
So the API returned a four hundred
Copy the prompt into the terminal
My laptop battery is dying
We built the whole thing in a week
Let me think about it for a minute
Could you explain the stack trace
Restart the dev server'''.strip().split('\n')
jobs = []
for v in VOICES:
    for i, t in enumerate(POS):
        for rate in ['-10%', '+0%', '+15%']:
            for pitch in ['-8Hz', '+0Hz', '+8Hz']:
                if random.Random(v + t + rate + pitch).random() < 0.5: jobs.append(('pos', v, t, rate, pitch, f'pos_{v}_{i}_{rate}_{pitch}'))
    for i, t in enumerate(NEAR):
        for rate in ['-10%', '+15%']: jobs.append(('near', v, t, rate, '+0Hz', f'near_{v}_{i}_{rate}'))
    for i, t in enumerate(GEN): jobs.append(('gen', v, t, '+0%', '+0Hz', f'gen_{v}_{i}'))
async def one(kind, v, t, rate, pitch, name):
    raw = os.path.join(out, name.replace('%', '').replace('+', 'p').replace('-', 'm') + '.f32')
    if os.path.exists(raw): return
    mp3 = raw[:-4] + '.mp3'
    for a in range(3):
        try: await edge_tts.Communicate(t, v, rate=rate, pitch=pitch).save(mp3); break
        except Exception: await asyncio.sleep(2)
    else: return
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', mp3, '-ac', '1', '-ar', '16000', '-f', 'f32le', raw], check=False); os.remove(mp3)
async def main():
    sem = asyncio.Semaphore(10)
    async def run(j):
        async with sem: await one(*j)
    await asyncio.gather(*[run(j) for j in jobs])
    man = [{'kind': k, 'voice': v, 'text': t, 'file': n.replace('%', '').replace('+', 'p').replace('-', 'm') + '.f32'} for k, v, t, r, p, n in jobs]
    json.dump([m for m in man if os.path.exists(os.path.join(out, m['file']))], open(os.path.join(out, 'manifest.json'), 'w'))
    print(len(jobs), 'jobs')
asyncio.run(main())
