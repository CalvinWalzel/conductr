#!/bin/sh
# Installs or updates Conductr, a Herdr layout and its mods, into Herdr's folder.
#   curl -fsSL https://raw.githubusercontent.com/CalvinWalzel/conductr/main/install.sh | sh
# The repo's git data lives outside Herdr's folder (CONDUCTR_GIT_DIR), and its files are checked out
# straight into it, so Herdr reloads them on every pull. Only Conductr's own files are tracked; your
# keys, settings and other mods stay yours.
set -eu

repo=${CONDUCTR_REPO:-https://github.com/CalvinWalzel/conductr.git}
herdr=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
gitdir=${CONDUCTR_GIT_DIR:-$HOME/.local/share/conductr.git}
g() { git --git-dir="$gitdir" --work-tree="$herdr" "$@"; }

command -v git >/dev/null || { echo "Conductr needs git: xcode-select --install" >&2; exit 1; }
[ -d "$herdr" ] || { echo "No Herdr folder at $herdr. Install Herdr and start it once." >&2; exit 1; }

if [ -d "$gitdir" ]; then
  echo "Updating Conductr in $herdr"
  g pull --ff-only --quiet
else
  echo "Installing Conductr into $herdr"
  tmp=$(mktemp -d)
  git clone --quiet --no-checkout --separate-git-dir="$gitdir" "$repo" "$tmp/conductr"
  rm -rf "$tmp"
  git --git-dir="$gitdir" config core.worktree "$herdr"
  # Herdr's folder holds much more than Conductr; status shows only Conductr's files.
  git --git-dir="$gitdir" config status.showUntrackedFiles no
  # read-tree refuses to overwrite files that are already there.
  if ! out=$(g read-tree -mu HEAD 2>&1); then
    echo "These files are already in $herdr. Move them away and run this again:" >&2
    printf '%s\n' "$out" | sed -n 's/^\t/  /p' >&2
    rm -rf "$gitdir"
    exit 1
  fi
fi

if command -v herdr-app >/dev/null && herdr-app status >/dev/null 2>&1; then
  herdr-app do layout.switch '{"name":"conductr"}' >/dev/null && echo "Switched Herdr to the Conductr layout."
else
  echo "Start Herdr and pick the Conductr layout (ctrl-shift-l)."
fi
echo "Done. Updates show in Herdr; git commands: git --git-dir=$gitdir <command>"
