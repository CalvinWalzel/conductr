#!/bin/sh
# Backend of a conductr-chat tab: a headless Claude Code that reads in.jsonl and writes out.jsonl
# in <dir>, and reports its state to Herdr as OSC 7501 on this terminal.
# Ctrl+C with <dir>/to-terminal present swaps to the interactive TUI on the same session;
# leaving the TUI (/exit) comes back here.
d=$1
trap : INT
# Remembered on the terminal, so conductr-chrome can start this backend again after herdr-core restarts.
[ -n "$HC_TERMINAL_ID" ] && hc label "$HC_TERMINAL_ID" "conductr.chat=$d" > /dev/null 2>&1

last() { jq -r "$1" "$d/out.jsonl" 2>/dev/null | tail -n 1; }
# The session, and the mode, model and effort the chat set last, so a restart keeps them.
session() {
  sid=$(last 'select(.type=="system" and .subtype=="init") | .session_id')
  mode=$(last 'if .type=="system" and .subtype=="init" then .permissionMode
    elif .type=="control_response" then (.response.response.mode // empty) else empty end')
  model=$(jq -r 'select(.request.subtype=="set_model") | .request.model' "$d/in.jsonl" | tail -n 1)
  effort=$(jq -r 'select(.request.subtype=="apply_flag_settings") | .request.settings.effortLevel // empty' "$d/in.jsonl" | tail -n 1)
}

# A new chat tab (prepare.sh): put the chat pane over this terminal and zoom it.
if [ -f "$d/adopt" ]; then
  rm -f "$d/adopt"
  pane=$(herdr-app ls | jq -r --arg t "$HC_TERMINAL_ID" '.spaces[].tabs[].terminals[] | select(.terminal == $t) | .pane')
  chat=$(herdr-app do pane.split "$(jq -nc --arg p "$pane" --arg d "$d" --arg f "$PWD" \
    '{pane: $p, direction: "right", mod: "conductr-chat", props: {dir: $d, cwd: $f}}')" | jq -r .pane)
  herdr-app do pane.zoom "{\"pane\":\"$chat\"}" > /dev/null
  herdr-app do pane.focus "{\"pane\":\"$chat\"}" > /dev/null
fi
touch "$d/in.jsonl"
while :; do
  # A resumed session already has everything in in.jsonl; only a new chat reads it all.
  session
  [ -n "$sid" ] && skip=$(wc -l < "$d/in.jsonl") || skip=0
  printf '\033]7501;state=idle:app=claude-code\033\\'
  # A forked chat (new.sh) starts as a copy of its session, cut after the turn it was forked at.
  fork=$(cat "$d/fork" 2>/dev/null) && rm -f "$d/fork"
  printf 'conductr-chat backend: %s\n' "$d"
  tail -n +$((skip + 1)) -f "$d/in.jsonl" \
  | claude -p ${sid:+--resume "$sid"} ${fork:+--fork-session --resume-session-at "$fork"} \
      ${mode:+--permission-mode "$mode"} ${model:+--model "$model"} ${effort:+--effort "$effort"} \
      --input-format stream-json --output-format stream-json --verbose --thinking-display summarized \
      --replay-user-messages --permission-prompt-tool stdio \
  | jq -cR --unbuffered '(fromjson? | if type == "object" then . + {conductr_at: now} else . end) // .' \
  | tee -a "$d/out.jsonl" \
  | jq --unbuffered -r '
      if .type == "result" then (if .subtype == "success" then "state=done" else "state=idle" end)
      elif .type == "control_request" and .request.subtype == "can_use_tool" then
        "state=blocked:kind=" + (if .request.tool_name == "AskUserQuestion" then "question" else "permission" end)
      elif (.type == "user" and (.message.content | type) == "string" and (.message.content | startswith("<local-command-"))) then empty
      elif .type == "assistant" or .type == "user" or (.type == "system" and .subtype == "init") then "state=working"
      else empty end' \
  | awk '$0 != last { printf "\033]7501;%s:app=claude-code\033\\", $0; fflush(); last = $0 }'
  [ -f "$d/to-terminal" ] || exit
  rm -f "$d/to-terminal"
  session
  touch "$d/tui"
  claude ${sid:+--resume "$sid"} ${mode:+--permission-mode "$mode"} ${model:+--model "$model"} ${effort:+--effort "$effort"}
  rm -f "$d/tui"
done
