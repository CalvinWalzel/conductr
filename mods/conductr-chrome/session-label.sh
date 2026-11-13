#!/bin/sh
# session-label.sh [claude|codex]: remembers this terminal's agent session as a Herdr terminal
# label (agent.session=<agent>:<id>), so conductr-chrome can resume it after herdr-core restarts.
# Labels survive a restart. Leaving Claude on purpose (/exit, Ctrl+C twice, logout) forgets it.
# A SessionStart/SessionEnd hook for Claude Code and Codex; install-hooks.py registers it.
[ -n "$HC_TERMINAL_ID" ] || exit 0
agent=${1:-claude}
input=$(cat)
field() { printf '%s' "$input" | jq -r "$1 // empty"; }
session=$(field .session_id)
# A Codex sub-agent runs its own session inside its parent's terminal: keep the parent's.
[ "$agent" = codex ] && [ -n "$CODEX_THREAD_ID" ] && [ "$CODEX_THREAD_ID" != "$session" ] && exit 0
case $(field .hook_event_name) in
  SessionStart) [ -n "$session" ] && hc label "$HC_TERMINAL_ID" "agent.session=$agent:$session" ;;
  SessionEnd) case $(field .reason) in prompt_input_exit|logout) hc label "$HC_TERMINAL_ID" agent.session= ;; esac ;;
esac >/dev/null 2>&1
exit 0
