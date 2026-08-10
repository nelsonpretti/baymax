#!/bin/bash
# Background timer: speaks "Still working." every 2 minutes while this session is actively working.
# Started by PreToolUse (voice-checkin-counter.sh), stopped by Stop hook.
# State files are scoped per session_id (passed as $1) so multiple terminals are independent.
# Self-exits when:
#   - this session's RUNNING_FLAG is removed (Stop hook cleanup)
#   - voice mode is disabled (~/.claude/.voice-enabled gone)
#   - the flag is older than 30s (stale — work has clearly ended)

SESSION_ID="${1:-default}"
VOICE_ENABLED="$HOME/.claude/.voice-enabled"
RUNNING_FLAG="/tmp/voice-tool-running.${SESSION_ID}"
TIMER_PID_FILE="/tmp/voice-timer-pid.${SESSION_ID}"
QUIET_GAP=120  # seconds of machine-wide silence required before a check-in
POLL=15        # how often to re-check; the gap above is what actually gates speech
STALE_THRESHOLD=30  # seconds — flag must be refreshed within this window
LAST_SPOKEN=/tmp/voice-last-spoken  # written by voice-daemon.py when speech ENDS

# On a machine that has not spoken yet, start the clock now rather than treating a
# missing file as "silent for ever" and firing on the first poll.
[ -f "$LAST_SPOKEN" ] || date +%s > "$LAST_SPOKEN"

while [ -f "$RUNNING_FLAG" ] && [ -f "$VOICE_ENABLED" ]; do
    sleep "$POLL"

    # Re-check after sleep — tool may have finished or voice disabled
    if [ ! -f "$RUNNING_FLAG" ] || [ ! -f "$VOICE_ENABLED" ]; then
        break
    fi

    # If the flag wasn't refreshed recently, the session has stopped working.
    # PreToolUse refreshes the flag on every tool call, so a gap > 30s means idle.
    FLAG_AGE=$(( $(date +%s) - $(stat -f %m "$RUNNING_FLAG" 2>/dev/null || echo 0) ))
    if [ "$FLAG_AGE" -gt "$STALE_THRESHOLD" ]; then
        break
    fi

    # Never talk over speech. Two guards, both machine-wide rather than per-session,
    # because several terminals share one voice daemon and one pair of speakers.
    # 1. Something is being spoken right now — say nothing, check again next poll.
    if pgrep -x afplay > /dev/null 2>&1; then
        continue
    fi
    # 2. Anything spoken in the last QUIET_GAP seconds, by ANY session, resets the
    #    clock. A check-in is only for a genuinely silent stretch.
    LAST=$(cat "$LAST_SPOKEN" 2>/dev/null | cut -d. -f1)
    if [ -n "$LAST" ]; then
        SILENT_FOR=$(( $(date +%s) - LAST ))
        if [ "$SILENT_FOR" -lt "$QUIET_GAP" ]; then
            continue
        fi
    fi

    touch /tmp/voice-cancel
    killall -9 afplay 2>/dev/null

    python3 -c "
import socket, time
time.sleep(0.1)
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2)
    s.connect('/tmp/voice-daemon.sock')
    s.sendall(b'Still working.')
    s.close()
except Exception as e:
    print('no')
    import traceback; traceback.print_exc(file=open('/tmp/voice-errors.log','a'))
" 2>/dev/null

    touch /tmp/voice-socket-used
done

# Self-cleanup on exit — only remove this session's files
rm -f "$RUNNING_FLAG" "$TIMER_PID_FILE"
