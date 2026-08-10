#!/bin/bash
# Voice Output Hook (Stop) — auto-starts daemon if needed, cleans up THIS session's timer.
# State files are scoped per session_id so we never kill another terminal's heartbeat.

# Where the Baymax install lives. Written by install.sh; without it nothing here
# can find the daemons, so the hook simply does nothing rather than erroring.
BAYMAX_ENV="$HOME/.claude/.baymax-env"
[ -f "$BAYMAX_ENV" ] && . "$BAYMAX_ENV"
[ -z "$BAYMAX_HOME" ] && exit 0

VOICE_ENABLED_FLAG="$HOME/.claude/.voice-enabled"
SOCKET_PATH="/tmp/voice-daemon.sock"
DAEMON_SCRIPT="$BAYMAX_HOME/bin/voice-daemon.py"
DAEMON_LOG="/tmp/voice-daemon.log"
VENV_PYTHON="$BAYMAX_PYTHON"
GLOBAL_INPUT_SCRIPT="$BAYMAX_HOME/bin/voice-listener.py"
GLOBAL_INPUT_LOG="/tmp/voice-global.log"

# Read stdin once, extract session_id
STDIN_TMP=$(mktemp)
cat > "$STDIN_TMP"
SESSION_ID=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('session_id',''))" "$STDIN_TMP" 2>/dev/null)
rm -f "$STDIN_TMP"
if [ -z "$SESSION_ID" ]; then
    SESSION_ID="default"
fi

TIMER_PID_FILE="/tmp/voice-timer-pid.${SESSION_ID}"
RUNNING_FLAG="/tmp/voice-tool-running.${SESSION_ID}"

# ALWAYS clean up THIS session's timer — even if voice was disabled mid-session
OLD_PID=$(cat "$TIMER_PID_FILE" 2>/dev/null)
if [ -n "$OLD_PID" ]; then
    kill "$OLD_PID" 2>/dev/null
    sleep 0.2
    if kill -0 "$OLD_PID" 2>/dev/null; then
        kill -9 "$OLD_PID" 2>/dev/null
    fi
fi
rm -f "$TIMER_PID_FILE" "$RUNNING_FLAG"

# Only run the rest if voice mode is enabled
if [ ! -f "$VOICE_ENABLED_FLAG" ]; then
    rm -f /tmp/voice-tool-count /tmp/voice-sent-this-response /tmp/voice-socket-used
    exit 0
fi

# Auto-start daemon if not running (or stale socket from dead process)
if [ -S "$SOCKET_PATH" ] && ! pgrep -f "voice-daemon.py" > /dev/null 2>&1; then
    rm -f "$SOCKET_PATH"
fi

if [ ! -S "$SOCKET_PATH" ]; then
    if ! pgrep -f "voice-daemon.py" > /dev/null 2>&1; then
        nohup "$VENV_PYTHON" "$DAEMON_SCRIPT" >> "$DAEMON_LOG" 2>&1 &
        disown
        for i in $(seq 1 60); do
            if [ -S "$SOCKET_PATH" ]; then
                break
            fi
            sleep 0.5
        done
    fi
fi

if [ ! -S "$SOCKET_PATH" ]; then
    exit 0
fi

# Auto-start global voice input daemon if not running
if ! pgrep -f "voice-listener.py" > /dev/null 2>&1; then
    nohup "$VENV_PYTHON" "$GLOBAL_INPUT_SCRIPT" >> "$GLOBAL_INPUT_LOG" 2>&1 &
    disown
fi

PERSISTENT_FLAG="/tmp/voice-sent-this-response"
FORGOT_FLAG="/tmp/voice-forgot-last-response"

VOICE_MID_SENT=0
if [ -f "$PERSISTENT_FLAG" ]; then
    VOICE_MID_SENT=1
    rm -f "$PERSISTENT_FLAG"
fi

TOOL_COUNT=0
if [ -f "/tmp/voice-tool-count" ]; then
    TOOL_COUNT=$(cat /tmp/voice-tool-count 2>/dev/null || echo 0)
    rm -f /tmp/voice-tool-count
fi

FORGOT=0
[ "$VOICE_MID_SENT" = "0" ] && FORGOT=1

if [ "$FORGOT" = "1" ]; then
    echo "1" > "$FORGOT_FLAG"
else
    rm -f "$FORGOT_FLAG"
fi

# CLOSING-ECHO GATE. The warning above only catches a response with NO echo at all. The failure
# the user keeps hearing is different and more common: an opening echo announces the plan, the work
# runs, and the turn ends on a work tool — so the ANSWER is never spoken. voice-posttool.sh marks
# whether the most recent tool call was the echo; if it was not, block the stop once and make the
# closing echo happen. Blocking once is safe: the retry sends an echo, which flips the marker.
LAST_ECHO_FLAG="/tmp/voice-last-was-echo.${SESSION_ID}"
BLOCK_GUARD="/tmp/voice-closing-block.${SESSION_ID}"

if [ "$(cat "$LAST_ECHO_FLAG" 2>/dev/null)" != "1" ] && [ ! -f "$BLOCK_GUARD" ]; then
    touch "$BLOCK_GUARD"
    echo "CLOSING ECHO MISSING — your last tool call was not an echo, so the user hears silence where the answer should be. Send the closing echo NOW: Bash(echo '<the conclusion, in your own spoken words>' > /tmp/voice-preview), then give the written reply. See the Baymax skill, 'The Closing Echo'." >&2
    exit 2
fi

rm -f "$BLOCK_GUARD"
exit 0
