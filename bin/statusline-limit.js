#!/usr/bin/env node
// Publish Claude Code's five-hour budget to /tmp/claude-session-limit, so the robot
// face can fall asleep when the session is spent and count down to the refresh.
//
// Why a statusline command and not a hook: the rate-limit figures are handed to the
// statusline on stdin and are not written anywhere on disk. This is the only place
// they arrive. (Checked on 2026-08-10: no live copy under ~/.claude — usage-data was
// weeks stale and policy-limits.json holds org policy, not usage.)
//
// It is a WRAPPER, so it never costs you your own status line. If BAYMAX_STATUSLINE_WRAP
// names another command, this passes the same stdin to it and prints its output
// unchanged. With nothing to wrap it prints nothing, which is a valid empty statusline.

const fs = require('fs');
const { execSync } = require('child_process');

const LIMIT_FILE = '/tmp/claude-session-limit';

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch {
  raw = '';
}

try {
  const data = JSON.parse(raw);
  const fh = data.rate_limits?.five_hour;
  if (fh) {
    fs.writeFileSync(LIMIT_FILE, JSON.stringify({
      used_percentage: fh.used_percentage ?? null,
      resets_at: fh.resets_at ?? null,
      at: Math.floor(Date.now() / 1000),
    }));
  }
} catch {
  // A malformed payload must never break the status line.
}

// A shell is deliberate here: statusLine in settings.json IS a shell command string,
// written by the person whose machine this is. There is no external input to inject.
const wrapped = process.env.BAYMAX_STATUSLINE_WRAP;
if (wrapped) {
  try {
    const out = execSync(wrapped, { input: raw, encoding: 'utf8' });
    process.stdout.write(out);
  } catch (e) {
    process.stdout.write(e.stdout || '');
  }
}
