#!/usr/bin/env python3
"""Add the four voice hooks to Claude Code's settings.json without disturbing
anything already in it.

Hand-merging JSON is where people lose their existing configuration, so this
does it for them: it appends only the entries that are missing, leaves every
other hook alone, and keeps a timestamped backup of the file it found.

Usage: register-hooks.py --settings ~/.claude/settings.json [--remove]
"""
import argparse
import json
import os
import shutil
import time

# event -> the script that runs on it
HOOKS = {
    "PreToolUse": "voice-checkin-counter.sh",
    "PostToolUse": "voice-posttool.sh",
    "UserPromptSubmit": "voice-user-prompt.sh",
    "Stop": "voice-output.sh",
}


def command_for(script):
    return 'bash "%s"' % os.path.join(
        os.path.expanduser("~/.claude/hooks"), script)


def is_ours(entry, script):
    return script in json.dumps(entry)


STATUSLINE = "statusline-limit.js"


def statusline_command(wrapped=None):
    """The statusline entry that publishes the five-hour budget for the face.

    Claude Code hands the rate-limit figures to the statusline command and nowhere
    else, so this has to sit in that slot. If a statusline is already configured it
    is wrapped rather than replaced: the same input is passed through and its output
    printed unchanged, so the display the user already has survives.
    """
    script = os.path.join(os.path.expanduser("~/.claude/hooks"), STATUSLINE)
    run = 'node "%s"' % script
    if wrapped:
        return "BAYMAX_STATUSLINE_WRAP=%s %s" % (json.dumps(wrapped), run)
    return run


def wire_statusline(data, remove=False):
    """Install, or take back out, the statusline that feeds the face."""
    sl = data.get("statusLine")
    current = sl.get("command", "") if isinstance(sl, dict) else ""

    if remove:
        if STATUSLINE not in current:
            return []
        # Hand the user's own statusline back, if there was one under ours.
        inner = ""
        if "BAYMAX_STATUSLINE_WRAP=" in current:
            rest = current.split("BAYMAX_STATUSLINE_WRAP=", 1)[1]
            try:
                inner, _ = json.JSONDecoder().raw_decode(rest)
            except ValueError:
                inner = ""
        if inner:
            data["statusLine"] = {"type": "command", "command": inner}
            return ["restored the statusline that was there before"]
        data.pop("statusLine", None)
        return ["removed the statusline"]

    if STATUSLINE in current:
        return []
    data["statusLine"] = {"type": "command",
                          "command": statusline_command(current or None)}
    return ["wrapped the statusline" if current else "added the statusline"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--settings", required=True)
    ap.add_argument("--remove", action="store_true",
                    help="take the voice hooks back out again")
    args = ap.parse_args()
    path = os.path.expanduser(args.settings)

    data = {}
    if os.path.exists(path):
        shutil.copy(path, "%s.backup-%d" % (path, int(time.time())))
        try:
            with open(path) as fh:
                data = json.load(fh)
        except ValueError:
            raise SystemExit(
                "%s is not valid JSON — fix it before installing." % path)

    hooks = data.setdefault("hooks", {})
    changed = []

    for event, script in HOOKS.items():
        entries = hooks.setdefault(event, [])
        present = any(is_ours(e, script) for e in entries)
        if args.remove:
            if present:
                hooks[event] = [e for e in entries if not is_ours(e, script)]
                if not hooks[event]:
                    del hooks[event]
                changed.append("removed %s from %s" % (script, event))
        elif not present:
            entries.append({"hooks": [{"type": "command",
                                       "command": command_for(script)}]})
            changed.append("added %s to %s" % (script, event))

    if not hooks:
        data.pop("hooks", None)

    changed += wire_statusline(data, remove=args.remove)

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")

    if changed:
        for line in changed:
            print("    %s" % line)
    else:
        print("    hooks already registered — nothing to change")


if __name__ == "__main__":
    main()
