#!/bin/bash
# Set up voice for Claude Code: talking, listening, and the robot face.
#
# One command from a fresh clone to a working install. Everything it downloads
# goes under ~/.baymax so removing it is one folder; the only files it
# writes outside that are the Claude Code hooks and skill, which uninstall.sh
# takes back out again.
set -euo pipefail

BAYMAX_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BAYMAX_DATA="${BAYMAX_DATA:-$HOME/.baymax}"
CLAUDE_DIR="$HOME/.claude"
ENV_FILE="$CLAUDE_DIR/.baymax-env"
WHISPER_MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$1"; }
die()  { printf '\033[1;31mxx \033[0m %s\n' "$1" >&2; exit 1; }

# --- 1. the machine ---------------------------------------------------------
[ "$(uname)" = "Darwin" ] || die "This only runs on macOS: it uses CoreAudio, the macOS accessibility APIs and afplay."

if ! command -v brew >/dev/null 2>&1; then
  die "Homebrew is required. Install it from https://brew.sh and run this again."
fi

say "Installing system packages (sox, whisper.cpp, node, python)"
for pkg in sox whisper-cpp node python@3.12; do
  if brew list --formula "$pkg" >/dev/null 2>&1; then
    echo "    $pkg already there"
  else
    brew install "$pkg"
  fi
done

PY=""
for candidate in /opt/homebrew/bin/python3.12 /usr/local/bin/python3.12 python3.12 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done
[ -n "$PY" ] || die "No usable python3 found after installing python@3.12."

# --- 2. the speech models ---------------------------------------------------
mkdir -p "$BAYMAX_DATA/models"

say "Creating the Python environment"
if [ ! -x "$BAYMAX_DATA/venv/bin/python3" ]; then
  "$PY" -m venv "$BAYMAX_DATA/venv"
fi
"$BAYMAX_DATA/venv/bin/pip" install --quiet --upgrade pip
say "Installing Python packages (this pulls in PyTorch and takes a few minutes)"
"$BAYMAX_DATA/venv/bin/pip" install --quiet -r "$BAYMAX_HOME/requirements.txt"

if [ -s "$BAYMAX_DATA/models/ggml-base.en.bin" ]; then
  say "Speech-to-text model already downloaded"
else
  say "Downloading the speech-to-text model (141 MB)"
  curl -fL --progress-bar "$WHISPER_MODEL_URL" \
    -o "$BAYMAX_DATA/models/ggml-base.en.bin"
fi

# Kokoro pulls its own weights (314 MB) from Hugging Face the first time the
# daemon runs. Doing it here means the first thing you say is not preceded by a
# silent five-minute download.
say "Warming up the text-to-speech model (314 MB on first run)"
"$BAYMAX_DATA/venv/bin/python3" - <<'PY'
import warnings
warnings.filterwarnings('ignore')
from kokoro import KPipeline
pipe = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M')
for _ in pipe("Ready.", voice='af_heart', speed=1.1):
    break
print("    voice model ready")
PY

# --- 3. the face ------------------------------------------------------------
say "Building the robot face"
(cd "$BAYMAX_HOME/face" && npm install --silent --no-audit --no-fund)

# --- 4. wiring it into Claude Code ------------------------------------------
say "Installing the Claude Code hooks and skill"
mkdir -p "$CLAUDE_DIR/hooks" "$CLAUDE_DIR/skills/baymax"
cp "$BAYMAX_HOME"/claude/hooks/voice-*.sh "$CLAUDE_DIR/hooks/"
chmod +x "$CLAUDE_DIR"/hooks/voice-*.sh
# Publishes the five-hour budget so the face can sleep when the session runs out.
cp "$BAYMAX_HOME/bin/statusline-limit.js" "$CLAUDE_DIR/hooks/"
cp "$BAYMAX_HOME/claude/skills/voice/SKILL.md" "$CLAUDE_DIR/skills/baymax/SKILL.md"

cat > "$ENV_FILE" <<EOF
# Written by baymax/install.sh — where the voice install lives.
BAYMAX_HOME="$BAYMAX_HOME"
BAYMAX_DATA="$BAYMAX_DATA"
BAYMAX_PYTHON="$BAYMAX_DATA/venv/bin/python3"
EOF

# The hooks have to be registered in settings.json. Merging by hand is where
# people lose their existing configuration, so this does it for them and keeps
# a copy of what was there before.
"$BAYMAX_DATA/venv/bin/python3" "$BAYMAX_HOME/bin/register-hooks.py" \
  --settings "$CLAUDE_DIR/settings.json"

chmod +x "$BAYMAX_HOME"/bin/baymax-* "$BAYMAX_HOME"/bin/*.py 2>/dev/null || true

# --- 4b. the optional key that turns rambling into a clean prompt ------------
# Without this, speech reaches Claude exactly as it came out of your mouth. With
# it, anything over twelve words is tidied by Haiku first. Skipping is fine and
# everything else still works; you can add the key later by writing it to
# ~/.claude/.voice-api-key.
KEY_FILE="$CLAUDE_DIR/.voice-api-key"
if [ -s "$KEY_FILE" ]; then
  say "Anthropic API key already set — speech clean-up is on"
elif [ -t 0 ]; then
  echo
  say "Optional: an Anthropic API key tidies rambling speech into a clean prompt"
  echo "    Get one at https://console.anthropic.com — costs a fraction of a cent"
  echo "    per message. Press Return to skip."
  printf '    Key (sk-ant-...): '
  read -r ANTHROPIC_KEY_INPUT || ANTHROPIC_KEY_INPUT=""
  if [ -n "$ANTHROPIC_KEY_INPUT" ]; then
    printf '%s' "$ANTHROPIC_KEY_INPUT" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    echo "    saved to $KEY_FILE"
  else
    echo "    skipped — speech goes to Claude exactly as spoken"
  fi
else
  warn "No terminal to ask on — add an Anthropic key to $KEY_FILE later if you want speech clean-up"
fi

# --- 5. what the user still has to do ---------------------------------------
cat <<EOF

$(say "Installed.")

Two permissions only you can grant, in System Settings → Privacy & Security:

  • Microphone     → your terminal app (so it can hear you)
  • Accessibility  → your terminal app (so the hotkey works from any app)

Then, in Claude Code:

  /baymax            turn voice on (run it again to turn it off)

Press Fn+Shift anywhere to talk. The floating face starts with it; you can
change its colours, its size and the hotkey from the gear in its corner.

Optional: put an Anthropic API key in ~/.claude/.voice-api-key and long
ramblings get tidied into a clean prompt before Claude sees them.

  $BAYMAX_HOME/bin/baymax-start     start everything by hand
  $BAYMAX_HOME/bin/baymax-stop      stop everything
  $BAYMAX_HOME/uninstall.sh       remove all of it

EOF
