"""Play every face the robot has, in order, so you can watch them live.

Each mood is forced for a few seconds. The speaking mouth is driven from a
locally generated clip, so nothing is played aloud.

Usage: python3 scripts/parade_moods.py [seconds_per_face]
"""
import json
import pathlib
import subprocess
import sys
import time
import wave

HERE = pathlib.Path(__file__).parent
HOLD = float(sys.argv[1]) if len(sys.argv) > 1 else 3.0
STATE = '/tmp/claude-face-state'

MOODS = [
    ('calm', 'standing by — eyes drift and blink, mouth opens and closes'),
    ('working', 'a tool is running — pulsing dots'),
    ('loading', 'reading or searching — the filling bar'),
    ('waiting', 'a question is waiting on you — the rocking ?'),
    ('done', 'the spoken sentence said done / fixed / works — green, and a hop'),
    ('error', 'the spoken sentence said error / failed / broken — red'),
    ('sleepy', '90 seconds idle — droopy eyes and z z z'),
    ('battery', 'your Mac is under 20 percent'),
    ('wink', 'you clicked the face — first reaction'),
    ('love', 'you clicked the face — second reaction'),
    ('shocked', 'you clicked the face — third reaction'),
    ('dizzy', 'you clicked it six times in a minute — spirals, five seconds'),
    ('annoyed', 'poking it again before the minute is up'),
]


def hold(state, seconds):
    end = time.time() + seconds
    while time.time() < end:
        open(STATE, 'w').write(json.dumps({'state': state}))
        time.sleep(0.15)


for mood, why in MOODS:
    print(f'{mood:9s}  {why}', flush=True)
    hold(f'force:{mood}', HOLD)

# speaking, driven from a silent local clip
clip = '/tmp/robot-parade-speech.wav'
subprocess.run(['say', '-o', clip, '--data-format=LEI16@22050',
                'This is the talking mouth, shaped by the vowels.'], check=True)
with wave.open(clip) as w:
    dur = w.getnframes() / w.getframerate()
print(f'{"speaking":9s}  a voice clip is playing — mouth driven by the audio', flush=True)
open(STATE, 'w').write(json.dumps({'state': 'idle'}))
open('/tmp/voice-face-event', 'w').write(json.dumps(
    {'path': clip, 't0': time.time() + 0.3, 'text': 'showing you the mouth'}))
time.sleep(dur + 0.8)

open(STATE, 'w').write(json.dumps({'state': 'idle'}))
print('back to normal', flush=True)
