# Conductr

A [Herdr](https://herdr.dev) layout and mods for working with coding agents in git worktrees, in the
style of Conductor: spaces grouped by status in the sidebar, Claude Code as a chat or a terminal, a
PR status bar with CI checks, and Files and Source Control in the right panel.

## Install

Install Herdr and start it once. Then run:

```sh
curl -fsSL https://raw.githubusercontent.com/CalvinWalzel/conductr/main/install.sh | sh
```

The script adds the `conductr` layout and the `conductr-*` mods to Herdr's folder,
`~/.config/herdr-app`, and switches Herdr to the Conductr layout. It never overwrites a file that is
already there, and it leaves your keys, settings and other mods alone.

On the first start, a setup dialog checks the programs Conductr uses (`git`, `gh`, `jq`, `python3`,
`claude`, and `codex` if you use it). It asks before it changes anything outside Herdr:

- **Resume hooks.** A SessionStart and SessionEnd hook in `~/.claude/settings.json` and
  `~/.codex/hooks.json` label each agent's terminal, so its session comes back after a reboot.
- **`restore_screen`.** herdr-core shows a terminal's last screen after a reboot.

It also asks for your branch prefix and the prompt that Create PR sends. Settings opens it again.

## Updates

Herdr checks for a new release every hour. When one exists, a blue button shows next to Settings.
It opens the changelog of every release you don't have yet, and Update installs it. Herdr reloads the
changed mods at once. To update by hand, run the install command again.

## Change it

Conductr's files in `~/.config/herdr-app` are a git checkout, but its `.git` folder is not there.
Herdr's folder holds much more than Conductr, and it may already be a git repo of your own. So the
history lives in `~/.local/share/conductr.git`, and you point git at it with `--git-dir`:

```sh
alias conductr='git --git-dir="$HOME/.local/share/conductr.git"'
conductr status
conductr commit -am "..."
```

Herdr reloads a mod as soon as you save a file in it. `herdr-app check mods/<mod>` checks a mod.

## Remove it

```sh
cd ~/.config/herdr-app && rm -rf mods/conductr-* layouts/conductr.json install.sh README.md changelog .gitignore
rm -rf ~/.local/share/conductr.git
```

Then pick another layout with `ctrl-shift-l`.

## Release

Commits on `main` reach nobody until you release them. A release is an annotated `v*` tag and its
notes in `changelog/<version>.md`. The notes are markdown: a short text, then the list of changes.
An image on a line of its own, like `![The new header](media/header.png)`, shows in the update
dialog; put the file in `changelog/media/`. The tag's date shows next to the version.

```sh
# Write changelog/0.2.0.md, then:
conductr add changelog && conductr commit -am "Release 0.2.0"
conductr tag -a v0.2.0 -m "Conductr 0.2.0" && conductr push --follow-tags
```
