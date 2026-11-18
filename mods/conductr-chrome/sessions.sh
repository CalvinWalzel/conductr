#!/bin/sh
# sessions.sh outdated|update|hibernate [terminal...]: Claude Code sessions in Herdr terminals that
# carry an agent.session label (session-label.sh). Terminals: the ones named, else all.
#   outdated   prints the terminals whose session runs an older Claude Code than is installed
#   update     stops those sessions; conductr-chrome resumes them at once, on the installed version
#   hibernate  stops sessions; conductr-chrome resumes each when its tab shows
# SIGTERM ends Claude, keeps the label and leaves the shell, so the session resumes in the same
# terminal. update and hibernate never stop a session that works or waits for an answer, and print
# the terminal of each session they stopped.
set -eu

self=${HC_TERMINAL_ID:-}

action=${1:-}
[ $# -gt 0 ] && shift
case $action in outdated|update|hibernate) ;; *) echo "usage: sessions.sh outdated|update|hibernate [terminal...]" >&2; exit 2 ;; esac

installed=
if [ "$action" != hibernate ]; then
  installed=$(claude --version 2>/dev/null | cut -d' ' -f1)
  [ -n "$installed" ] || exit 0
fi

# ponytail: finds the native `claude` binary only. An npm install runs as `node` and is left alone.
claude_of() {
  for child in $(pgrep -P "$1" || true); do
    case $(ps -o comm= -p "$child") in *claude) echo "$child"; return ;; esac
  done
}

# The native binary's file is named after its version, which ps shows as ucomm.
outdated() {
  running=$(ps -o ucomm= -p "$1" | tr -d ' ')
  case $running in [0-9]*.*) [ "$running" != "$installed" ] ;; *) return 1 ;; esac
}

stop() {
  kill -TERM "$1"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.5
  done
  return 1
}

picked=$*
for terminal in ${picked:-$(hc ls --json | jq -r '.terminals[].address')}; do
  info=$(hc get "$terminal" --json) || continue
  session=$(printf '%s' "$info" | jq -r '.labels["agent.session"] // "" | select(startswith("claude:")) | .[7:]')
  [ -n "$session" ] || continue
  claude=$(claude_of "$(printf '%s' "$info" | jq -r .pid)")
  [ -n "$claude" ] || continue
  if [ -n "$installed" ] && ! outdated "$claude"; then continue; fi
  if [ "$action" = outdated ]; then echo "$terminal"; continue; fi
  [ "$terminal" = "$self" ] && continue
  case $(printf '%s' "$info" | jq -r '.status.state? // ""') in working|blocked) continue ;; esac
  stop "$claude" || continue
  echo "$terminal"
done
