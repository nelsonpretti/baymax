#!/bin/bash
# PreToolUse hook: starts a background timer that fires "Still working." every 2min.
# Timer persists across tool calls within a response; killed by Stop hook.
# State files are scoped per session_id so multiple terminals don't clobber each other.
# Only active when voice mode is enabled.

# Where the Baymax install lives. Written by install.sh; without it nothing here
# can find the daemons, so the hook simply does nothing rather than erroring.
BAYMAX_ENV="$HOME/.claude/.baymax-env"
[ -f "$BAYMAX_ENV" ] && . "$BAYMAX_ENV"
[ -z "$BAYMAX_HOME" ] && exit 0

VOICE_ENABLED="$HOME/.claude/.voice-enabled"

if [ ! -f "$VOICE_ENABLED" ]; then
    exit 0
fi

# Read the incoming tool call from stdin
TMPFILE=$(mktemp)
cat > "$TMPFILE"
SESSION_ID=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('session_id',''))" "$TMPFILE" 2>/dev/null)
TOOL_NAME=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('tool_name',''))" "$TMPFILE" 2>/dev/null)
TOOL_CMD=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('tool_input',{}).get('command',''))" "$TMPFILE" 2>/dev/null)
rm -f "$TMPFILE"

if [ -z "$SESSION_ID" ]; then
    SESSION_ID="default"
fi

RUNNING_FLAG="/tmp/voice-tool-running.${SESSION_ID}"
TIMER_PID_FILE="/tmp/voice-timer-pid.${SESSION_ID}"

# If this tool call IS a direct voice send — restart timer (reset 2-min window), mark socket used, exit
if [ "$TOOL_NAME" = "Bash" ] && echo "$TOOL_CMD" | grep -q "voice-daemon.sock"; then
    OLD_PID=$(cat "$TIMER_PID_FILE" 2>/dev/null)
    kill "$OLD_PID" 2>/dev/null
    rm -f "$TIMER_PID_FILE" "$RUNNING_FLAG"
    touch "$RUNNING_FLAG"
    nohup bash $HOME/.claude/hooks/voice-timer.sh "$SESSION_ID" > /dev/null 2>&1 &
    echo "$!" > "$TIMER_PID_FILE"
    touch /tmp/voice-sent-this-response
    exit 0
fi

# Increment tool count for this response (read by Stop hook to detect missed narration)
TC=0
[ -f /tmp/voice-tool-count ] && TC=$(cat /tmp/voice-tool-count 2>/dev/null || echo 0)
echo $((TC + 1)) > /tmp/voice-tool-count

# Touch the running flag to refresh its timestamp (timer uses this to detect staleness)
touch "$RUNNING_FLAG"

# Only start a new timer if one isn't already running for THIS session
OLD_PID=$(cat "$TIMER_PID_FILE" 2>/dev/null)
if [ -z "$OLD_PID" ] || ! kill -0 "$OLD_PID" 2>/dev/null; then
    nohup bash $HOME/.claude/hooks/voice-timer.sh "$SESSION_ID" > /dev/null 2>&1 &
    echo "$!" > "$TIMER_PID_FILE"
fi

exit 0
