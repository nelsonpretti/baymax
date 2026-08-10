#!/bin/bash
# UserPromptSubmit hook: immediately says "On it." via voice socket.
# Fires the instant the user submits — before any text streams.

# Where the Baymax install lives. Written by install.sh; without it nothing here
# can find the daemons, so the hook simply does nothing rather than erroring.
BAYMAX_ENV="$HOME/.claude/.baymax-env"
[ -f "$BAYMAX_ENV" ] && . "$BAYMAX_ENV"
[ -z "$BAYMAX_HOME" ] && exit 0

VOICE_ENABLED="$HOME/.claude/.voice-enabled"
SOCKET_PATH="/tmp/voice-daemon.sock"

if [ ! -f "$VOICE_ENABLED" ]; then
    exit 0
fi

if [ ! -S "$SOCKET_PATH" ]; then
    exit 0
fi

python3 -c "
import socket, random
phrases = [
    'On it.',
    'Let me take a look.',
    'Got it, give me a second.',
    'Sure, looking into it.',
    'Right, let me check.',
    'Yep... on it.',
    'Let me dig into that.',
    'Processing that now.',
    'Taking a look now.',
    'Understood, looking now.',
    'Leave it with me.',
]
msg = random.choice(phrases)
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2)
    s.connect('/tmp/voice-daemon.sock')
    s.sendall(msg.encode('utf-8'))
    s.close()
except Exception as e:
    print('no')
    import traceback; traceback.print_exc(file=open('/tmp/voice-errors.log','a'))
" 2>/dev/null

exit 0
