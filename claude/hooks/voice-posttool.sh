#!/bin/bash
# PostToolUse hook: speaks /tmp/voice-preview immediately after each tool.
# Synchronous send (no &) so the message reaches the daemon before the script exits.
# Cancels any current audio so new message plays immediately, not queued behind old one.

VOICE_ENABLED="$HOME/.claude/.voice-enabled"
PREVIEW_FILE="/tmp/voice-preview"

if [ ! -f "$VOICE_ENABLED" ]; then
    exit 0
fi

# Timer is NOT killed here — it persists across tool calls within a response.
# It is killed by the Stop hook (voice-output.sh) when the response ends.

# LAST-TOOL marker — the Stop gate reads this to enforce the CLOSING echo (the Baymax skill).
# A turn that opens with an echo and then ends on a work tool leaves Nelson in silence: he hears
# the plan and never the answer. So record, per tool call, whether THIS tool was the echo.
# Scoped per session: Nelson runs several terminals at once, and a global flag meant any
# other session's work tool call reset it to 0 in between this session's closing echo and
# its Stop hook — so the gate fired "closing echo missing" on turns that ended in an echo.
STDIN_TMP=$(mktemp)
cat > "$STDIN_TMP"
SESSION_ID=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('session_id',''))" "$STDIN_TMP" 2>/dev/null)
rm -f "$STDIN_TMP"
[ -z "$SESSION_ID" ] && SESSION_ID="default"
LAST_ECHO_FLAG="/tmp/voice-last-was-echo.${SESSION_ID}"

if [ ! -f "$PREVIEW_FILE" ]; then
    echo 0 > "$LAST_ECHO_FLAG"
    exit 0
fi

# Read and immediately speak the preview
VOICE_TEXT=$(cat "$PREVIEW_FILE")
rm -f "$PREVIEW_FILE"

if [ -z "$VOICE_TEXT" ]; then
    echo 0 > "$LAST_ECHO_FLAG"
    exit 0
fi

# From here the tool call WAS an echo carrying text — including the dropped-filler branch below,
# which is a deliberate silence, not a missing closing echo.
echo 1 > "$LAST_ECHO_FLAG"

# A short filler echo must NEVER interrupt a substantive one that is already playing.
# Cancelling is how "Proposal is ready…" got cut off mid-sentence by "Still working."
# (observed 2026-08-05 in /tmp/voice-daemon.log). If audio is playing and the new text is
# too short to carry information, drop it rather than talk over the real answer.
if pgrep -x afplay > /dev/null 2>&1 && [ "${#VOICE_TEXT}" -lt 80 ]; then
    exit 0
fi

# Cancel any currently playing audio so this message plays immediately
touch /tmp/voice-cancel
killall -9 afplay 2>/dev/null

# Strip markdown formatting that TTS would read literally
VOICE_TEXT=$(python3 -c "
import re, sys
t = sys.argv[1]
t = re.sub(r'\*\*(.+?)\*\*', r'\1', t)
t = re.sub(r'\*(.+?)\*', r'\1', t)
t = re.sub(r'\x60(.+?)\x60', r'\1', t)
t = re.sub(r'#{1,6}\s+', '', t)
t = re.sub(r'\[(.+?)\]\(.+?\)', r'\1', t)
t = re.sub(r'[<>]', '', t)
print(t)
" "$VOICE_TEXT" 2>/dev/null)

# Synchronous send — no & — ensures message reaches daemon before script exits
python3 -c "
import socket, sys, time
# Brief pause so daemon registers the cancel before receiving new message
time.sleep(0.1)
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2)
    s.connect('/tmp/voice-daemon.sock')
    s.sendall(sys.argv[1].encode('utf-8'))
    s.close()
except Exception as e:
    print('no')
    import traceback; traceback.print_exc(file=open('/tmp/voice-errors.log','a'))
" "$VOICE_TEXT" 2>/dev/null

# Persistent flag: tells Stop hook voice was sent this response (survives multiple tool calls)
touch /tmp/voice-sent-this-response

exit 0
