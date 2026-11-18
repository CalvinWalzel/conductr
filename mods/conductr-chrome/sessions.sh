#!/bin/sh
# sessions.sh outdated|update|hibernate [-f] [terminal...]: Claude Code sessions in Herdr terminals
# that carry an agent.session label (session-label.sh). Terminals: the ones named, else all.
#   outdated   prints the terminals whose session runs an older Claude Code than is installed
#   update     stops those sessions; conductr-chrome resumes them at once, on the installed version
#   hibernate  stops sessions; conductr-chrome resumes each when its tab shows
# SIGTERM ends Claude, keeps the label and leaves the shell, so the session resumes in the same
# terminal. update and hibernate never stop a session that works or waits for an answer, nor one
# that would lose an unsent draft or a background command. They name that one on stderr as
# `unsaved <terminal>`, and -f stops it too. They print the terminal of each session they stopped.
set -eu

self=${HC_TERMINAL_ID:-}

action=${1:-}
[ $# -gt 0 ] && shift
case $action in outdated|update|hibernate) ;; *) echo "usage: sessions.sh outdated|update|hibernate [-f] [terminal...]" >&2; exit 2 ;; esac
force=
if [ "${1:-}" = -f ]; then force=1; shift; fi

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

# Without a transcript, the session has no conversation yet and `claude --resume` cannot find it.
can_resume() { ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1".jsonl >/dev/null 2>&1; }

# A command of Claude's Bash tool runs in a shell that sources Claude's shell snapshot. Under an idle
# session, that is a background command.
has_task() { pgrep -P "$1" -f 'shell-snapshots/' >/dev/null; }

# Succeeds when Claude's prompt box, the text between the last two rules on its screen, holds nothing
# a person typed. Dim text there is Claude's own hint or suggestion, and `hc read` drops the styles,
# so this watches the terminal's own output for a moment. Anything unclear counts as a draft.
EMPTY_PROMPT='
import os, pty, re, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp("hc", ["hc", "attach", "--observe", sys.argv[1]])
raw, end = b"", time.time() + 1.5
while time.time() < end:
    if select.select([fd], [], [], 0.1)[0]:
        try:
            raw += os.read(fd, 65536)
        except OSError:
            break
os.kill(pid, signal.SIGKILL)
os.waitpid(pid, 0)
plain = lambda text: re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)
rows = raw.decode("utf-8", "replace").split("\r\n")
rules = [index for index, row in enumerate(rows) if plain(row).startswith("───")]
if len(rules) < 2:
    sys.exit(1)
box = "".join(rows[rules[-2] + 1:rules[-1]])
typed = plain(re.sub(r"\x1b\[2m.*?\x1b\[(0|22)m", "", box, flags=re.S)).replace("\xa0", " ").strip()
sys.exit(1 if typed[1:].strip() else 0)
'
prompt_empty() { python3 -I -c "$EMPTY_PROMPT" "$1" 2>/dev/null; }

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
  can_resume "$session" || continue
  if [ -z "$force" ] && { has_task "$claude" || ! prompt_empty "$terminal"; }; then echo "unsaved $terminal" >&2; continue; fi
  stop "$claude" || continue
  echo "$terminal"
done
