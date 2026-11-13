# install-hooks.py <script> [claude] [codex]: registers <script> as the SessionStart/SessionEnd hook of
# Claude Code (~/.claude/settings.json) and Codex (~/.codex/hooks.json): the agents named (default: both),
# where this machine has them.
# Idempotent: rewrites a file only when its hooks change, keeps a one-time .bak-herdr copy, and
# drops entries that point at an older copy of the script. Prints the files it changed.
import json, os, shutil, sys

script = sys.argv[1]
wanted = sys.argv[2:] or ["claude", "codex"]
home = os.path.expanduser("~")
shown = "$HOME" + script[len(home):] if script.startswith(home + "/") else script
name = os.path.basename(script)
agents = [(agent, path) for agent, path in [("claude", os.path.join(home, ".claude", "settings.json")), ("codex", os.path.join(home, ".codex", "hooks.json"))] if agent in wanted]

for agent, path in agents:
    if not os.path.isdir(os.path.dirname(path)):
        continue
    config = json.load(open(path)) if os.path.exists(path) else {}
    hooks = config.setdefault("hooks", {})
    command = f'sh "{shown}" {agent}'
    before = json.dumps(config, sort_keys=True)
    for event in ("SessionStart", "SessionEnd"):
        older = lambda hook: hook.get("command") != command and any(mark in hook.get("command", "") for mark in ("herdr-session-label.sh", f"conductr-chrome/{name}", f"calvin-chrome/{name}"))
        groups = [group for group in hooks.get(event, []) if not any(older(hook) for hook in group.get("hooks", []))]
        if not any(hook.get("command") == command for group in groups for hook in group.get("hooks", [])):
            groups.append({"matcher": "", "hooks": [{"type": "command", "command": command, "timeout": 5}]})
        hooks[event] = groups
    if json.dumps(config, sort_keys=True) == before:
        continue
    if os.path.exists(path) and not os.path.exists(path + ".bak-herdr"):
        shutil.copy2(path, path + ".bak-herdr")
    with open(path, "w") as handle:
        json.dump(config, handle, indent=2)
        handle.write("\n")
    print(path)
