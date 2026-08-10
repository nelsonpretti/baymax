#!/usr/bin/env python3
"""
Global Voice Input for Claude Code — works from any app.

Double-tap Fn to start recording, single-tap Fn to stop.
Transcribes via faster-whisper and sends to the active Claude session
via `claude --continue --message`.

Requires Accessibility permissions in System Settings.
"""

import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time

_anthropic = None
try:
    import anthropic as _anthropic
except ImportError:
    pass

import Quartz
from Quartz import (
    CGEventTapCreate,
    kCGSessionEventTap,
    kCGHeadInsertEventTap,
    kCGEventTapOptionListenOnly,
    CGEventMaskBit,
    CGEventGetFlags,
    CFMachPortCreateRunLoopSource,
    CFRunLoopGetCurrent,
    CFRunLoopAddSource,
    CFRunLoopRun,
    kCFRunLoopCommonModes,
    kCGEventFlagsChanged,
    kCGEventFlagMaskSecondaryFn,
)

# Everything installed lives under one root, so a clone works from any folder.
BAYMAX_DATA = os.environ.get("BAYMAX_DATA", os.path.expanduser("~/.baymax"))
VENV_PYTHON = os.path.join(BAYMAX_DATA, "venv", "bin", "python3")
SOCKET_PATH = "/tmp/voice-daemon.sock"
VOICE_ENABLED = os.path.expanduser("~/.claude/.voice-enabled")

# How loud you are right now, so the robot face (Personal/robot-face) can show
# a waveform while the microphone is open — the reassurance that it is actually
# hearing you. Best effort throughout: nothing here may delay or break a
# recording, so every step is wrapped and failure just means no waveform.
LISTEN_STATE = "/tmp/claude-face-listen"
LISTEN_BARS = 24
LISTEN_HZ = 25

# Which keys start and stop a recording. Fn+Shift is only the factory setting —
# the robot face's settings panel can rebind it, because Fn never reaches an
# ordinary application and this event tap is the only thing on the machine that
# can see it. The face asks by touching CAPTURE_REQUEST; we watch the next
# combination pressed, save it, and report back through HOTKEY_STATE.
HOTKEY_CONFIG = os.path.expanduser("~/.claude/voice-hotkey.json")
CAPTURE_REQUEST = "/tmp/voice-hotkey-capture"
HOTKEY_STATE = "/tmp/voice-hotkey-state"
CAPTURE_TIMEOUT = 10.0

DEFAULT_HOTKEY = {"mods": ["fn", "shift"], "keycode": None}

MOD_BITS = {}          # filled in once Quartz is imported
MOD_LABELS = {"fn": "Fn", "shift": "Shift", "ctrl": "Ctrl",
              "alt": "Option", "cmd": "Cmd"}
# Enough of the macOS virtual keycodes to name whatever anyone actually binds.
KEY_NAMES = {
    0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X", 8: "C",
    9: "V", 11: "B", 12: "Q", 13: "W", 14: "E", 15: "R", 16: "Y", 17: "T",
    18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 24: "=", 25: "9",
    26: "7", 27: "-", 28: "8", 29: "0", 30: "]", 31: "O", 32: "U", 33: "[",
    34: "I", 35: "P", 36: "Return", 37: "L", 38: "J", 39: "'", 40: "K",
    41: ";", 42: "\\", 43: ",", 44: "/", 45: "N", 46: "M", 47: ".",
    48: "Tab", 49: "Space", 50: "`", 51: "Delete", 53: "Escape",
    96: "F5", 97: "F6", 98: "F7", 99: "F3", 100: "F8", 101: "F9",
    103: "F11", 105: "F13", 107: "F14", 109: "F10", 111: "F12", 113: "F15",
    118: "F4", 120: "F2", 122: "F1", 123: "Left", 124: "Right",
    125: "Down", 126: "Up",
}

hotkey = dict(DEFAULT_HOTKEY)
capturing = False
capture_started = 0.0
capture_mods = set()

# State
recording = False
recording_start_time = None
rec_process = None
audio_file = None
hotkey_held = False  # True when both Fn+Shift are down
listen_thread = None


def notify(title, message):
    """Show macOS notification."""
    subprocess.Popen([
        "osascript", "-e",
        f'display notification "{message}" with title "{title}"'
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def play_sound(name):
    """Play a system sound briefly."""
    sounds = {
        "start": "/System/Library/Sounds/Pop.aiff",
        "stop": "/System/Library/Sounds/Bottle.aiff",
        "error": "/System/Library/Sounds/Basso.aiff",
    }
    path = sounds.get(name)
    if path and os.path.exists(path):
        subprocess.Popen(["afplay", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def kill_tts_playback():
    """Stop TTS immediately: kill current audio AND tell daemon to stop generating more."""
    # Set cancel flag so daemon stops generating new sentences
    open("/tmp/voice-cancel", "w").close()
    # Kill current afplay process
    subprocess.run(["killall", "-9", "afplay"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def hotkey_label(hk):
    parts = [MOD_LABELS[m] for m in ("fn", "ctrl", "alt", "shift", "cmd")
             if m in hk.get("mods", [])]
    if hk.get("keycode") is not None:
        parts.append(KEY_NAMES.get(hk["keycode"], "Key %d" % hk["keycode"]))
    return "+".join(parts) if parts else "(none)"


def load_hotkey():
    global hotkey
    try:
        with open(HOTKEY_CONFIG) as fh:
            saved = json.load(fh)
        mods = [m for m in saved.get("mods", []) if m in MOD_LABELS]
        code = saved.get("keycode")
        # A binding with neither a modifier nor a key would fire on nothing;
        # one with only a plain key would fire while you type. Refuse both and
        # fall back rather than leaving the microphone unreachable.
        if mods:
            hotkey = {"mods": mods, "keycode": code}
    except (OSError, ValueError, TypeError):
        hotkey = dict(DEFAULT_HOTKEY)
    write_hotkey_state()


def save_hotkey(hk):
    global hotkey
    hotkey = hk
    try:
        os.makedirs(os.path.dirname(HOTKEY_CONFIG), exist_ok=True)
        with open(HOTKEY_CONFIG, "w") as fh:
            json.dump(hk, fh)
    except OSError:
        pass
    write_hotkey_state()


def write_hotkey_state():
    try:
        with open(HOTKEY_STATE, "w") as fh:
            json.dump({"label": hotkey_label(hotkey), "capturing": capturing,
                       "at": time.time()}, fh)
    except OSError:
        pass


def watch_capture_requests():
    """The face touches a file to say 'listen for a new shortcut'."""
    global capturing, capture_started, capture_mods
    while True:
        try:
            if os.path.exists(CAPTURE_REQUEST):
                os.unlink(CAPTURE_REQUEST)
                capturing = True
                capture_started = time.time()
                capture_mods = set()
                play_sound("start")
                print("⌨️  Press the new shortcut...", flush=True)
                write_hotkey_state()
            elif capturing and time.time() - capture_started > CAPTURE_TIMEOUT:
                capturing = False
                print("⌨️  Shortcut unchanged (nothing pressed).", flush=True)
                write_hotkey_state()
        except OSError:
            pass
        time.sleep(0.15)


def finish_capture(mods, keycode):
    """Store whatever was just pressed, unless it could not work as a trigger."""
    global capturing
    capturing = False
    # A lone modifier fires every time you capitalise a letter, and a bare key
    # fires whenever you type it. Both would make the machine unusable, so the
    # binding must be two modifiers, or one modifier plus a key.
    if not mods or (keycode is None and len(mods) < 2):
        print("⌨️  Ignored: use two modifiers, or a modifier plus a key.",
              flush=True)
        play_sound("error")
        write_hotkey_state()
        return
    hk = {"mods": sorted(mods), "keycode": keycode}
    save_hotkey(hk)
    play_sound("stop")
    print("⌨️  Shortcut is now %s" % hotkey_label(hk), flush=True)


def write_listen(payload):
    try:
        with open(LISTEN_STATE, "w") as fh:
            json.dump(payload, fh)
    except OSError:
        pass


def watch_levels(path):
    """Follow the growing recording and publish how loud it is, ~25 times a
    second. Reading the tail of sox's own file avoids opening the microphone a
    second time, which macOS would not let us do anyway."""
    bars = [0.0] * LISTEN_BARS
    pos = 44                       # past the wav header
    peak = 1500.0                  # a floor, so a quiet room is not full scale
    while recording:
        try:
            with open(path, "rb") as fh:
                fh.seek(0, 2)
                end = fh.tell()
                if end > pos:
                    fh.seek(max(pos, end - 8192))
                    raw = fh.read(end - max(pos, end - 8192))
                    pos = end
                    n = len(raw) // 2
                    if n:
                        vals = struct.unpack("<%dh" % n, raw[: n * 2])
                        loud = max(abs(v) for v in vals)
                        peak = max(peak * 0.995, loud)
                        bars = bars[1:] + [min(1.0, loud / peak)]
        except (OSError, struct.error):
            pass
        write_listen({"listening": True, "at": time.time(),
                      "levels": [round(b, 3) for b in bars]})
        time.sleep(1.0 / LISTEN_HZ)
    write_listen({"listening": False, "at": time.time(), "levels": []})


def start_recording():
    global recording, recording_start_time, rec_process, audio_file, listen_thread
    if recording:
        return
    # Kill any TTS audio so it doesn't get recorded
    kill_tts_playback()
    audio_file = tempfile.mktemp(suffix=".wav")
    rec_process = subprocess.Popen(
        # A small buffer so the file grows in ~30 ms steps: the waveform is only
        # reassuring if it moves while you speak, not a quarter-second later.
        ["rec", "-q", "--buffer", "1024", "-r", "16000", "-c", "1", "-b", "16",
         audio_file],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    recording = True
    listen_thread = threading.Thread(target=watch_levels, args=(audio_file,),
                                     daemon=True)
    listen_thread.start()
    recording_start_time = time.time()
    play_sound("start")
    print("🎙️  Recording... (%s to stop)" % hotkey_label(hotkey), flush=True)


def stop_recording():
    global recording, rec_process, audio_file
    if not recording or rec_process is None:
        return None
    recording = False
    rec_process.terminate()
    rec_process.wait()
    rec_process = None
    play_sound("stop")
    print("⏳ Transcribing...", flush=True)
    return audio_file


def _find_whisper():
    """Homebrew sits in a different place on Apple silicon and on Intel, and a
    hand-built whisper.cpp lands somewhere else again. Take whichever exists."""
    env = os.environ.get("WHISPER_BIN")
    if env and os.path.exists(env):
        return env
    for candidate in ("/opt/homebrew/bin/whisper-cli",
                      "/usr/local/bin/whisper-cli",
                      "/opt/homebrew/bin/whisper-cpp",
                      "/usr/local/bin/whisper-cpp"):
        if os.path.exists(candidate):
            return candidate
    found = subprocess.run(["which", "whisper-cli"], capture_output=True,
                           text=True).stdout.strip()
    return found or "whisper-cli"


WHISPER_BIN = _find_whisper()
WHISPER_MODEL = os.environ.get(
    "WHISPER_MODEL", os.path.join(BAYMAX_DATA, "models", "ggml-base.en.bin"))


def transcribe(audio_path):
    """Transcribe using whisper.cpp (native, fast)."""
    try:
        result = subprocess.run(
            [WHISPER_BIN, "-m", WHISPER_MODEL, "-f", audio_path,
             "--no-timestamps", "-nt", "--language", "en"],
            # 2026-08-05: every recording was dying on this timeout. Measured on a 3s clip:
            # 21.1s wall, of which only 1.2s is transcription — the rest is loading the 148MB
            # model and initialising Metal on EVERY invocation. 15s could never pass after a
            # cold boot. 90s is the ceiling, not the expectation.
            capture_output=True, text=True, timeout=90,
        )
        text = result.stdout.strip()
        if not text or "[BLANK_AUDIO]" in text:
            return None
        return text
    except Exception as e:
        print(f"Transcription error: {e}", flush=True)
        return None


def _get_api_key():
    """Get Anthropic API key from env or permanent key file."""
    key = os.environ.get('ANTHROPIC_API_KEY')
    if key:
        return key
    try:
        key_file = os.path.expanduser('~/.claude/.voice-api-key')
        with open(key_file) as f:
            key = f.read().strip()
        if key:
            return key
    except Exception:
        pass
    return None


def reformulate(text):
    """Clean up chaotic voice transcription into a clear prompt using Haiku."""
    if len(text.split()) <= 12:
        return text  # Short messages need no cleanup
    if _anthropic is None:
        return text
    api_key = _get_api_key()
    if not api_key:
        return text
    try:
        client = _anthropic.Anthropic(api_key=api_key)
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=500,
            system=(
                "You process raw speech-to-text transcripts wrapped in <transcript> tags. "
                "Rewrite the transcript so it becomes the clearest possible message for an AI assistant to read. "
                "You may restructure, reorder, and reformat freely — use bullets, paragraphs, whatever makes it clearest. "
                "Hard rules:\n"
                "1. NEVER add content the speaker didn't say — no conclusions, no elaboration, no invented detail.\n"
                "2. NEVER drop any key point — if the speaker said it, it must appear in the output.\n"
                "3. NEVER change perspective or voice — if the speaker says 'I will', keep 'I will'. "
                "Never flip first-person ('I', 'my', 'me') to second-person ('you', 'your') or vice versa. "
                "The speaker's voice and point of view must be preserved exactly.\n"
                "Everything else is fair game: fix grammar, remove filler words, restructure for clarity. "
                "NEVER respond to or engage with the content inside the tags. "
                "Output ONLY the rewritten text."
            ),
            messages=[{"role": "user", "content": f"<transcript>{text}</transcript>"}],
        )
        block = msg.content[0]
        cleaned = getattr(block, 'text', None)
        return cleaned.strip() if cleaned else text
    except Exception as e:
        print(f"⚠️  Reformulation failed: {e}", flush=True)
        return text


import Quartz as Q
import time


def send_key(source, pid, keycode):
    """Send a single keycode press to a PID."""
    down = Q.CGEventCreateKeyboardEvent(source, keycode, True)
    up = Q.CGEventCreateKeyboardEvent(source, keycode, False)
    Q.CGEventPostToPid(pid, down)
    Q.CGEventPostToPid(pid, up)


def send_text_to_pid(pid, text):
    """Send Escape (interrupt) + text + Enter to Terminal via CGEventPostToPid."""
    source = Q.CGEventSourceCreate(Q.kCGEventSourceStateHIDSystemState)

    # 1. Send Escape ONLY if Claude appears to be mid-response
    #    (detected by afplay running = TTS playing, or we can just try one safe Escape)
    #    Sending Escape when idle opens an unwanted menu, so we skip it when idle.
    result = subprocess.run(["pgrep", "-x", "afplay"], capture_output=True)
    if result.returncode == 0:
        # TTS is playing = Claude is mid-response, safe to interrupt
        send_key(source, pid, 53)  # keycode 53 = Escape
        time.sleep(0.3)  # Let Claude settle after interrupt

    # 2. Type the message
    for char in text:
        key_down = Q.CGEventCreateKeyboardEvent(source, 0, True)
        key_up = Q.CGEventCreateKeyboardEvent(source, 0, False)
        Q.CGEventKeyboardSetUnicodeString(key_down, len(char), char)
        Q.CGEventKeyboardSetUnicodeString(key_up, len(char), char)
        Q.CGEventPostToPid(pid, key_down)
        Q.CGEventPostToPid(pid, key_up)

    # 3. Send Enter to submit
    time.sleep(0.05)
    send_key(source, pid, 36)  # keycode 36 = Return

    print(f"✅ Sent to Terminal (PID {pid}) — no window switch", flush=True)


def send_to_claude(text):
    """Paste transcribed text into a specific Terminal window running Claude Code."""
    try:
        # Copy to clipboard (no trailing newline)
        subprocess.run(["pbcopy"], input=text.encode(), check=True)

        # AppleScript to:
        # 1. Remember current frontmost app
        # 2. Find the Terminal window whose name contains our keyword
        # 3. Bring it to front, paste, submit with Enter
        # 4. Return focus to the original app
        # Find Terminal.app's PID
        result = subprocess.run(
            ["pgrep", "-f", "Terminal.app/Contents/MacOS/Terminal"],
            capture_output=True, text=True,
        )
        terminal_pid = result.stdout.strip().split("\n")[0] if result.stdout.strip() else None
        if not terminal_pid:
            print("❌ Terminal.app not running", flush=True)
            play_sound("error")
            return

        terminal_pid = int(terminal_pid)

        # Use CGEventPostToPid to send keystrokes to Terminal WITHOUT focusing it
        send_text_to_pid(terminal_pid, text)
    except Exception as e:
        print(f"❌ Paste failed: {e}", flush=True)
        play_sound("error")


def process_recording():
    """Transcribe and send to Claude in background."""
    duration = time.time() - recording_start_time if recording_start_time else 0
    audio_path = stop_recording()
    if not audio_path:
        return

    def _process():
        text = transcribe(audio_path)
        try:
            os.unlink(audio_path)
        except OSError:
            pass

        if text:
            print(f"🗣️  \"{text}\"", flush=True)
            if duration >= 5.0:
                reformed = reformulate(text)
            else:
                reformed = text
            if reformed != text:
                print(f"✨  \"{reformed}\"", flush=True)
            send_to_claude(reformed)
        else:
            print("⚠️  No speech detected.", flush=True)

    threading.Thread(target=_process, daemon=True).start()


def mods_down(flags):
    return {name for name, bit in MOD_BITS.items() if flags & bit}


def toggle_recording():
    if not recording:
        start_recording()
    else:
        process_recording()


def event_callback(proxy, event_type, event, refcon):
    """CGEventTap callback: the recording hotkey, and capturing a new one."""
    global hotkey_held, capture_mods

    flags = CGEventGetFlags(event)
    down = mods_down(flags)

    if capturing:
        # Remember the largest set of modifiers held during the capture, so
        # rolling onto Fn then Shift is read as Fn+Shift rather than just Fn.
        if event_type == kCGEventFlagsChanged:
            if down:
                capture_mods |= down
            elif capture_mods:
                # everything let go without a key being struck: a
                # modifiers-only shortcut, which is what Fn+Shift is
                finish_capture(set(capture_mods), None)
                capture_mods = set()
        else:
            code = int(Quartz.CGEventGetIntegerValueField(
                event, Quartz.kCGKeyboardEventKeycode))
            finish_capture(down | capture_mods, code)
            capture_mods = set()
        return event

    want = set(hotkey.get("mods", []))
    code = hotkey.get("keycode")

    if code is None:
        # A modifiers-only shortcut fires the moment the last one goes down,
        # and re-arms once they are all released.
        if event_type == kCGEventFlagsChanged:
            armed = want and want.issubset(down)
            if armed and not hotkey_held:
                hotkey_held = True
                toggle_recording()
            elif not armed:
                hotkey_held = False
    elif event_type != kCGEventFlagsChanged:
        pressed = int(Quartz.CGEventGetIntegerValueField(
            event, Quartz.kCGKeyboardEventKeycode))
        if pressed == code and want.issubset(down):
            toggle_recording()

    return event


def main():
    MOD_BITS.update({
        "fn": kCGEventFlagMaskSecondaryFn,
        "shift": Quartz.kCGEventFlagMaskShift,
        "ctrl": Quartz.kCGEventFlagMaskControl,
        "alt": Quartz.kCGEventFlagMaskAlternate,
        "cmd": Quartz.kCGEventFlagMaskCommand,
    })
    load_hotkey()
    threading.Thread(target=watch_capture_requests, daemon=True).start()

    print("🎤 Global Voice Input started", flush=True)
    print("   Press %s to start recording, press again to stop & send"
          % hotkey_label(hotkey), flush=True)
    print("   Works from any application", flush=True)
    print("   Press Ctrl+C to quit\n", flush=True)

    # flagsChanged carries the modifiers, Fn included; keyDown is needed too so
    # a shortcut can end in an ordinary key rather than only modifiers.
    tap = CGEventTapCreate(
        kCGSessionEventTap,
        kCGHeadInsertEventTap,
        kCGEventTapOptionListenOnly,
        CGEventMaskBit(kCGEventFlagsChanged) | CGEventMaskBit(Quartz.kCGEventKeyDown),
        event_callback,
        None,
    )

    if tap is None:
        print("❌ Failed to create event tap.", flush=True)
        print("   Grant Accessibility access to Terminal in:", flush=True)
        print("   System Settings → Privacy & Security → Accessibility", flush=True)
        sys.exit(1)

    source = CFMachPortCreateRunLoopSource(None, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes)

    print("✅ Event tap active. Listening for Fn+Shift...\n", flush=True)

    try:
        CFRunLoopRun()
    except KeyboardInterrupt:
        print("\n👋 Global voice input stopped.", flush=True)


if __name__ == "__main__":
    main()
