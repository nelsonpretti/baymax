---
name: baymax
description: Toggle Baymax — Claude's voice, ears and floating robot face. When on, Claude speaks every reply aloud, listens on a hotkey, and the robot reacts to what it is doing. Use /baymax to toggle, /baymax on to enable, /baymax off to disable.
user_invocable: true
---

# Voice Mode

## EXECUTE IMMEDIATELY — before reading anything else

Run this toggle NOW. Do not read the rest of the skill first. Do not ask questions. Just execute:

1. `test -f ~/.claude/.voice-enabled` — check if file exists
2. If it EXISTS → `rm ~/.claude/.voice-enabled && . ~/.claude/.baymax-env && "$BAYMAX_HOME/bin/baymax-stop" --keep-voice` → respond only: **"Voice mode off."** → STOP (do not output anything else)
3. If it does NOT exist → `touch ~/.claude/.voice-enabled && . ~/.claude/.baymax-env && "$BAYMAX_HOME/bin/baymax-start"` → respond only: **"Voice mode on."** → STOP (do not output anything else)

`baymax-start` is idempotent: it starts the speech daemon, the hotkey listener and the robot
face window, and skips any of the three that is already running. Turning voice mode ON must
ALWAYS run it — never assume they are up. `baymax-stop --keep-voice` closes the face and the
listener while leaving the speech daemon warm.

**Override:** `/baymax on` always enables (create file + `baymax-start`). `/baymax off` always disables (remove file + `baymax-stop --keep-voice`). These skip the toggle.

The rest of this skill is reference material loaded into context for when voice mode is ON.

---

## The Mechanic: Echo Before Every Text Block

Every response follows this pattern — no exceptions:

1. `Bash(echo '...' > /tmp/voice-preview)` — spoken immediately by the TTS daemon
2. Written text response

This applies to EVERY response. A response that starts with text instead of an echo is **broken** — the user hears nothing.

During multi-step work, same pattern between tool calls. Before each narrative text block, send an echo, then the work tool call. NEVER combine echo + work in one Bash call.

---

## The Closing Echo — the one that actually matters

**The LAST tool call of every turn is an echo carrying the answer.** After all work, all
verification, all bookkeeping — one final `Bash(echo '...' > /tmp/voice-preview)`, then the
written response. No exceptions.

This is the failure mode this skill kept shipping: the opening echo narrates the plan, mid-work
echoes narrate progress, and then the turn ends with a block of text and silence. The user hears
what I was *about to do* and never hears the result — he has to read the screen to find out
whether the turn is even finished.

The closing echo carries:
1. **The conclusion** — the number, the verdict, the decision. Not "I've finished the analysis."
2. **Anything he must act on** — a choice to make, a command to run, a thing that failed.
3. **That the turn is over.** Silence after it means done, not thinking.

Self-check before writing any closing text: *did my last tool call speak the answer?* If the
answer only exists on screen, the turn is broken.

| | Example |
|---|---|
| BAD (opening echo only) | `echo 'Cross-checking the closed stores against the dashboard now.'` … then text with the finding, never spoken |
| GOOD (closing echo) | `echo 'Only four of the eight hundred closed stores clash with the dashboard — two still have uptime, two are marked recovered. Nothing to worry about.'` |

A turn with a single tool call still needs this: the one echo IS the closing echo, so it must
carry the answer, not an announcement of it.

---

## Never emit a filler echo — it kills the message before it

Each new preview **cancels whatever is currently being spoken** (`voice-posttool.sh` touches
`/tmp/voice-cancel` and kills `afplay`). A long echo takes 15-20 seconds to speak. So a throwaway
echo sent after a substantive one does not add anything — it **truncates the real message
mid-sentence**.

Banned outright, they carry no information and destroy what came before:
`On it.` · `Still working.` · `Yep, on it.` · `One sec.` · `Let me check.`

Observed 2026-08-05 in `/tmp/voice-daemon.log`: `Speaking: Proposal is ready. Three fixes…` →
`Cancelled mid-stream.` → `Speaking: Still working....` → `Speaking: Yep... on it....`. The user
heard the first few words of the answer and then three pieces of noise.

Rule: **one echo per meaningful step, and never one after the closing echo.** If there is nothing
new to say, say nothing — silence costs nothing, an interruption costs the whole message.

---

## The One Rule: The Echo Must Stand Alone

**If the user heard ONLY the echo and never read the text, would they have the key information?** If not, the echo is broken.

The echo is not a preview, not a summary, not an announcement. It is a **self-sufficient spoken answer** — a coworker's hallway take that delivers the actual content in their own words.

---

## Three Anti-Patterns (in order of how often they happen)

### 1. Topic Announcing (most common)

The echo says WHAT the text is about, but delivers zero information. The user hears a table of contents entry.

| | Example |
|---|---|
| User asks | "How do the approve/dismiss/discuss buttons work?" |
| BAD echo | "Here is how all three buttons work in the KB review flow." |
| WHY bad | Says nothing. User must read the text to learn anything. |
| GOOD echo | "Approve writes the text into the markdown file and you can edit it first. Dismiss just flags it resolved, no file changes. Discuss pops a Claude terminal with full context so you can refine." |
| WHY good | User now knows the answer. Text adds detail, but the echo was enough. |

More BAD announcing patterns:
- "Let me explain how X works."
- "So there are three components to this."
- "I found some interesting things about the sync service."

### 2. Parroting (second most common)

The echo restates the text's last paragraph with minor rewording. User reads and hears the same content twice.

| | Example |
|---|---|
| Text ends with | "The API key was in your .env file and the settings object had it, but the KB service created the Anthropic client without passing it. Every Run Review call failed silently." |
| BAD echo | "The API key was in the env file and the settings object had it but the service was not passing it through to the client." |
| GOOD echo | "Fixed — API key was there all along, just wasn't being passed through. Should work on the next click." |

### 3. Narrating Actions (least common)

The echo describes what you did instead of what the user needs to know.

| | Example |
|---|---|
| BAD | "I updated the memory file with the specific failure pattern." |
| GOOD | "Saved that as a rule so it won't happen again. Should kick in next session." |

---

## Echo Quality Checklist

Before writing the echo, pass these three tests:

1. **Self-sufficiency**: Could the user skip the text entirely and still have the key info?
2. **No duplication**: Does any sentence convey the same meaning as any sentence in the text? If yes — rewrite.
3. **Forward momentum**: Does it end with what it means or what's next?
4. **Closing coverage**: Is this the last tool call of the turn? If yes, it must carry the
   conclusion — see "The Closing Echo" above. If the turn ends with text and no echo before it,
   the response is broken regardless of how good the earlier echoes were.

---

## Length Guide

| Response type | Echo length |
|---|---|
| Simple answer / confirmation | 1-2 sentences |
| Medium explanation | 2-3 sentences |
| Complex multi-part response | 3-4 sentences — give the shape and the risk, not everything |

---

## Examples by Response Type

### Explaining how something works
- GOOD: `echo 'Three buttons — approve writes to the file and you can edit first, dismiss just marks it done with no changes, discuss opens a Claude terminal to refine. Pretty straightforward flow.'`

### Reporting a fix
- GOOD: `echo 'Fixed — API key was there, just not wired through. Should work on next click.'`

### Starting multi-step work
- GOOD: `echo 'The problem is the audio keeps playing because new sentences keep starting. Gonna add a cancel signal.'`

### Giving an opinion or analysis
- GOOD: `echo 'Honestly not sure this covers every edge case, but the main path works now.'`

### Warning about risk
- GOOD: `echo 'Five steps, but step three is the risky one — schema change. Might want a backup first.'`

---

## Voice Style

Write it like you'd actually say it to a coworker sitting next to you:
- Use contractions: "I'd", "couldn't", "won't"
- Have opinions: "I'm not totally sure about this but..."
- Acknowledge uncertainty: "This might break something else"
- No code, file paths, URLs, or technical syntax — those are for the screen
- No AI filler: skip "certainly", "absolutely", "great question"
- No sycophancy: don't start with "great point" or "you're right"

---

## Voice Input Handling

When user speaks via /voice, show **"Here's what I understood:"** summary demonstrating comprehension before proceeding with any action. This is a comprehension check, not a parrot — rephrase in your own words. Wait for confirmation before doing work.
---

## Under the Hood

Two background daemons, both auto-started by `/voice`:

**TTS daemon** (`voice-daemon.py`) — Kokoro model loaded in memory for instant speech
- First response after cold start: ~15-20s (model loading)
- Subsequent responses: ~2s (synthesis only)
- Voice: Kokoro `af_heart` at 1.1x speed
- Streaming: sentences play as they're generated

**Global voice input** (`voice-listener.py`) — listens for Fn+Shift from any app
- Press Fn+Shift to start recording, press again to stop
- Transcribes via whisper-cli (~0.5s) and pastes into the last active Terminal window
- No dedicated terminal needed — runs fully in background
- Logs at `/tmp/voice-global.log`

To kill everything: `pkill -f voice-daemon.py && pkill -f voice-listener.py`
To check status: `pgrep -f voice-daemon && pgrep -f voice-global`
