#!/bin/sh
# prepare.sh [<chat> <line> <uuid>]: make a new chat's folder and print it. run.sh in a new tab puts
# the chat pane over itself on first start. With a chat's folder, the line of a turn's end in its
# out.jsonl and the turn's last message uuid, the chat is a fork: it shows that chat up to there and
# resumes a copy of its session from there.
from=$1 line=$2 uuid=$3
mods=$(cd "$(dirname "$0")" && pwd)
dir="$(dirname "$(dirname "$mods")")/data/conductr-chat/$(date +%s)"
mkdir -p "$dir" && : > "$dir/out.jsonl" && : > "$dir/adopt" || exit 1
if [ -n "$from" ]; then
  head -n "$line" "$from/out.jsonl" > "$dir/out.jsonl"
  grep -E '"subtype":"(set_model|apply_flag_settings)"' "$from/in.jsonl" > "$dir/in.jsonl"
  printf '%s' "$uuid" > "$dir/fork"
fi
printf '%s\n' "$dir"
