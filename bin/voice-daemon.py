#!/usr/bin/env python3
"""
Voice TTS Daemon — keeps Kokoro model loaded in memory.
Listens on a Unix socket for text, synthesizes and streams playback
sentence-by-sentence for minimal latency.
"""

import os
import sys
import json
import time
import socket
import tempfile
import subprocess
import warnings
import signal
import threading

warnings.filterwarnings('ignore')
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['TRANSFORMERS_NO_ADVISORY_WARNINGS'] = '1'

SOCKET_PATH = '/tmp/voice-daemon.sock'
CANCEL_FLAG = '/tmp/voice-cancel'
FACE_EVENT = '/tmp/voice-face-event'
# When speech last FINISHED. One daemon serves every terminal, so this is a single
# machine-wide clock: the "Still working." check-in timer reads it to avoid talking
# over a reply that another session is in the middle of speaking.
LAST_SPOKEN = '/tmp/voice-last-spoken'
WARMUP_CLIP = '/tmp/voice-warmup.wav'


def make_warmup_clip():
    """A fifth of a second of silence, used to wake the speakers up.

    macOS powers the audio device down when nothing has played for a while, and
    the next clip is held for roughly half a second while it comes back. Only
    the FIRST sentence of a reply pays that — by the second one the device is
    awake — which is why the robot's mouth ran ahead of the voice on the opening
    line and matched it after that. Playing silence while the first sentence is
    still being synthesised absorbs the whole delay, so no timing fudge is
    needed anywhere.
    """
    import struct
    import wave
    try:
        with wave.open(WARMUP_CLIP, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(24000)
            w.writeframes(struct.pack('<h', 0) * int(24000 * 0.2))
    except (OSError, ValueError):
        pass


def wake_audio_device():
    if not os.path.exists(WARMUP_CLIP):
        return
    try:
        subprocess.Popen(['afplay', WARMUP_CLIP],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass


def cleanup(signum=None, frame=None):
    try:
        os.unlink(SOCKET_PATH)
    except OSError:
        pass
    sys.exit(0)


signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGINT, cleanup)


def play_audio(path, text=''):
    """Play audio and clean up."""
    # Announce the clip so the robot face (Personal/robot-face) can sync its
    # mouth to it. t0 is stamped here, at launch — sound does not start until
    # the audio device opens, and the face subtracts that gap itself with its
    # own "Voice lag" setting. The text rides along so the face can pick a mood
    # from what is being said. Best-effort: never block playback.
    try:
        with open(FACE_EVENT, 'w') as fh:
            json.dump({'path': path, 't0': time.time(), 'text': text}, fh)
    except OSError:
        pass

    subprocess.run(['afplay', path], check=False)
    try:
        with open(LAST_SPOKEN, 'w') as fh:
            fh.write(str(time.time()))
    except OSError:
        pass
    try:
        os.unlink(path)
    except OSError:
        pass


def main():
    # Remove stale socket
    try:
        os.unlink(SOCKET_PATH)
    except OSError:
        pass

    make_warmup_clip()

    print("Loading Kokoro model...", flush=True)
    from kokoro import KPipeline
    import soundfile as sf

    pipe = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M')

    # Warm up with a short phrase
    for _, _, audio in pipe("Ready.", voice='af_heart', speed=1.1):
        break
    print("Model loaded and warm. Listening on", SOCKET_PATH, flush=True)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET_PATH)
    os.chmod(SOCKET_PATH, 0o600)
    server.listen(1)

    while True:
        try:
            conn, _ = server.accept()
            data = b''
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
            conn.close()

            text = data.decode('utf-8').strip()
            if not text:
                continue

            if text == '__QUIT__':
                print("Shutdown requested.", flush=True)
                break

            print(f"Speaking: {text[:60]}...", flush=True)

            # Wake the speakers NOW, so they are ready by the time the first
            # sentence has been synthesised a second or so from here.
            wake_audio_device()

            # Clear any stale cancel flag
            try:
                os.unlink(CANCEL_FLAG)
            except OSError:
                pass

            # Stream: generate each sentence chunk and play immediately
            play_thread = None
            cancelled = False
            for _, _, audio in pipe(text, voice='af_heart', speed=1.1):
                # Check cancel flag before each sentence
                if os.path.exists(CANCEL_FLAG):
                    print("Cancelled mid-stream.", flush=True)
                    cancelled = True
                    try:
                        os.unlink(CANCEL_FLAG)
                    except OSError:
                        pass
                    break

                # Wait for previous sentence to finish playing
                if play_thread and play_thread.is_alive():
                    play_thread.join()

                # Write this chunk to a temp file
                fd, tmp = tempfile.mkstemp(suffix='.wav')
                os.close(fd)
                sf.write(tmp, audio, 24000)

                # Play in a thread so we can generate the next chunk in parallel
                play_thread = threading.Thread(target=play_audio, args=(tmp, text))
                play_thread.start()

            # Wait for the last chunk to finish (unless cancelled)
            if not cancelled and play_thread and play_thread.is_alive():
                play_thread.join()

        except Exception as e:
            print(f"Error: {e}", flush=True)
            continue

    cleanup()


if __name__ == '__main__':
    main()
