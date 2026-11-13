#!/bin/sh
# send.sh <dir> <part>...: queue one user message for a conductr-chat backend. Each part is t:<text> or
# i:<image path>, and the content blocks keep their order.
d=$1
shift
for part; do
  case $part in
    t:*) jq -n --arg t "${part#t:}" '{type: "text", text: $t}' ;;
    i:*) f=${part#i:}
      base64 < "$f" | tr -d '\n' | jq -Rs --arg m "$(file -b --mime-type "$f")" \
        '{type: "image", source: {type: "base64", media_type: $m, data: .}}' ;;
  esac
done | jq -sc '{type: "user", message: {role: "user", content: .}}' >> "$d/in.jsonl"
