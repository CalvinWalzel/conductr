#!/bin/sh
# app-icons.sh <out dir> <key=app path>...: each app's icon as a 64px PNG in <out dir>/<key>.png,
# made once. Apps whose icon is only in an asset catalog get none.
out=$1
shift
mkdir -p "$out"
for pair; do
  key=${pair%%=*} app=${pair#*=} png="$out/${pair%%=*}.png"
  [ -s "$png" ] && continue
  name=$(plutil -extract CFBundleIconFile raw "$app/Contents/Info.plist" 2>/dev/null) || continue
  case $name in *.icns) ;; *) name=$name.icns ;; esac
  # Through a file of its own, so two runs at once (copies starting together) can't clobber each other.
  sips -s format png -Z 64 "$app/Contents/Resources/$name" --out "$png.$$.png" > /dev/null 2>&1 && mv "$png.$$.png" "$png"
  rm -f "$png.$$.png"
done
