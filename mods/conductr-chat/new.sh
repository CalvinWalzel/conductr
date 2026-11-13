#!/bin/sh
# new.sh <space> <folder> [<chat> <line> <uuid>]: open a chat tab in that space (a fork with the
# rest; see prepare.sh). Its backend terminal (run.sh) sits behind the zoomed conductr-chat pane, so
# Herdr sees a normal agent tab.
space=$1 folder=$2
shift 2
mods=$(cd "$(dirname "$0")" && pwd)
dir=$(sh "$mods/prepare.sh" "$@") || exit 1
herdr-app do tab.new "$(jq -nc --arg s "$space" --arg f "$folder" --arg r "$mods/run.sh" --arg d "$dir" \
  '{space: $s, name: "Chat", folder: $f, argv: ["sh", $r, $d]}')" > /dev/null
