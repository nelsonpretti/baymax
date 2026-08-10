# Installing Baymax — instructions for Claude

You are reading this because someone cloned this repo and asked you to set it up.
Do the whole thing for them. They should have to do exactly two things by hand:
grant two macOS permissions, and paste an API key if they want one.

Work through this in order. After each step, check the stated result before
moving on — most failures here are silent, and a step that "ran" is not a step
that worked.

## 0. Before you start

Check all four. If any fails, say so and stop rather than working around it.

| Check | Command | Needs to be |
|---|---|---|
| macOS | `uname` | `Darwin` — this uses CoreAudio, `afplay` and the macOS accessibility APIs, and there is no Linux or Windows path |
| Homebrew | `command -v brew` | a path. If missing, send them to https://brew.sh |
| Disk | `df -h ~` | at least 3 GB free |
| Claude Code config | `ls ~/.claude` | exists. If not, they have not run Claude Code yet — have them start it once first |

## 1. Run the installer

```bash
./install.sh
```

It needs a terminal it can prompt on, because it asks for an optional Anthropic
API key near the end. **If you run it in a way that has no TTY, that prompt is
skipped** and the speech clean-up feature stays off — the script warns when this
happens. If you cannot give it a TTY, either ask the user to run it themselves,
or let it finish and then write the key yourself:

```bash
printf '%s' 'sk-ant-...' > ~/.claude/.voice-api-key && chmod 600 ~/.claude/.voice-api-key
```

The installer takes several minutes. Most of it is one `pip install` pulling in
PyTorch, and two model downloads (141 MB and 314 MB). Do not assume it has hung.

## 2. Check it actually installed

Run these and confirm each one:

```bash
ls -l ~/.baymax/models/ggml-base.en.bin        # ~141 MB, speech to text
ls -l ~/.baymax/venv/bin/python3               # the Python environment
ls -d  ~/.baymax/venv/lib/python*/site-packages/kokoro   # the voice model package
ls -l ~/.claude/hooks/voice-*.sh               # five hooks
ls -l ~/.claude/hooks/statusline-limit.js      # feeds the face its session budget
ls -l ~/.claude/skills/baymax/SKILL.md         # the /baymax command
cat   ~/.claude/.baymax-env                    # BAYMAX_HOME / BAYMAX_DATA / BAYMAX_PYTHON
ls -d face/node_modules/electron               # the robot face
```

Then confirm the hooks really landed in the settings file, and that nothing else
in it was disturbed:

```bash
python3 -c "import json;d=json.load(open('$HOME/.claude/settings.json'));print(list(d.get('hooks',{})));print(d.get('statusLine'))"
```

You should see `PreToolUse`, `PostToolUse`, `UserPromptSubmit` and `Stop` among
the hook events, and a `statusLine` command mentioning `statusline-limit.js`. If
the user already had a status line, it is wrapped inside the new one via
`BAYMAX_STATUSLINE_WRAP` and still prints exactly as before — do not "fix" that
by removing it.

The installer keeps a timestamped backup of the settings file it found. If
anything looks wrong, that backup is `~/.claude/settings.json.backup-<epoch>`.

## 3. The two things only the user can do

macOS will not let any program read the keyboard or open the microphone without
a human clicking. Tell them, in these words:

> Open System Settings → Privacy & Security, and add your terminal app under
> **Microphone** and under **Accessibility**. It has to be the terminal you run
> Claude Code in.

Without Accessibility the hotkey does nothing. Without Microphone the recording
is silence. Neither failure announces itself, so do not skip this.

## 4. Turn it on and prove it works

Have them type `/baymax` in Claude Code. That writes `~/.claude/.voice-enabled`
and starts three processes. Verify all three:

```bash
pgrep -fl voice-daemon.py     # speaks
pgrep -fl voice-listener.py   # listens for the hotkey
pgrep -fl "face$"             # the robot window
```

Speak a line through the daemon directly — this is the real end-to-end test of
the voice half, and they should hear it:

```bash
python3 -c "import socket;s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(30);s.connect('/tmp/voice-daemon.sock');s.sendall(b'Baymax is installed.');s.close()"
```

The first line after a cold start takes about fifteen seconds while the voice
model loads. After that it is roughly two.

Then have them press the hotkey (Fn+Shift by default), say something, and press
it again. If nothing appears, read `/tmp/voice-listener.log` — it prints
`Event tap active` when the Accessibility permission is granted.

## 5. When something is wrong

Read the log before changing anything. All three write to `/tmp`.

| Symptom | Look here | Usual cause |
|---|---|---|
| Hotkey does nothing | `/tmp/voice-listener.log` | Accessibility permission not granted to the right terminal |
| No sound at all | `/tmp/voice-daemon.log` | Model still loading, or the daemon is not running |
| Face missing | `/tmp/robot-face.log` | Turn voice off and on again, or run `bin/baymax-start` |
| Mouth out of time with the voice | — | The Voice lag slider in the face's settings panel |
| Speech reaches Claude unedited | `~/.claude/.voice-api-key` | No key, so clean-up is off. This is expected, not a bug |

`bin/baymax-start` is safe to re-run: it starts only what is not already
running. `bin/baymax-stop` stops everything; `bin/baymax-stop --keep-voice`
leaves the speech daemon warm.

## 6. Removing it

```bash
./uninstall.sh
```

It asks for confirmation, unwinds its own hook and status-line entries from
`settings.json` without touching the rest, and deletes `~/.baymax`. It
deliberately leaves the Anthropic key and the shared Hugging Face cache alone.

## What not to do

- **Do not edit the user's `settings.json` by hand.** `bin/register-hooks.py`
  merges and unmerges its own entries and keeps a backup. Hand-editing is how
  people lose their other hooks.
- **Do not move the clone after installing.** `~/.claude/.baymax-env` records
  this folder's path and the hooks read it. If it has to move, re-run
  `install.sh` from the new location.
- **Do not replace the user's status line.** It gets wrapped, not overwritten.
- **Do not put an API key anywhere but `~/.claude/.voice-api-key`**, and keep it
  at mode 600.
