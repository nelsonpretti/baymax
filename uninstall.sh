#!/bin/bash
# Remove everything install.sh put on this machine.
#
# The models and the Python environment are one folder, so they go in one line.
# The hooks and the skill are taken out of ~/.claude individually, and the hook
# registration is unwound from settings.json rather than the file being
# replaced — you may well have other hooks in there.
set -uo pipefail

BAYMAX_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BAYMAX_DATA="${BAYMAX_DATA:-$HOME/.baymax}"
CLAUDE_DIR="$HOME/.claude"

echo "This will remove:"
echo "  $BAYMAX_DATA                     (models and Python environment)"
echo "  $CLAUDE_DIR/hooks/voice-*.sh"
echo "  $CLAUDE_DIR/skills/baymax/"
echo "  the voice hook entries in $CLAUDE_DIR/settings.json"
echo
echo "It will NOT touch this folder, or anything else in ~/.claude."
printf 'Type yes to continue: '
read -r answer
[ "$answer" = "yes" ] || { echo "Nothing removed."; exit 0; }

bash "$BAYMAX_HOME/bin/baymax-stop" >/dev/null 2>&1 || true

if [ -x "$BAYMAX_DATA/venv/bin/python3" ]; then
  "$BAYMAX_DATA/venv/bin/python3" "$BAYMAX_HOME/bin/register-hooks.py" \
    --settings "$CLAUDE_DIR/settings.json" --remove
elif command -v python3 >/dev/null 2>&1; then
  python3 "$BAYMAX_HOME/bin/register-hooks.py" \
    --settings "$CLAUDE_DIR/settings.json" --remove
fi

rm -f "$CLAUDE_DIR"/hooks/voice-*.sh
rm -f "$CLAUDE_DIR/hooks/statusline-limit.js"
rm -rf "$CLAUDE_DIR/skills/baymax"
rm -f "$CLAUDE_DIR/.baymax-env" "$CLAUDE_DIR/.voice-enabled"
rm -rf "$BAYMAX_DATA"

echo
echo "Removed. Your Anthropic key at ~/.claude/.voice-api-key was left alone,"
echo "and so was the Hugging Face cache at ~/.cache/huggingface — other tools"
echo "share it."
