# Conductr

A [Herdr](https://herdr.dev) layout and mods for working with coding agents in git worktrees, in the
style of Conductor: spaces grouped by status in the sidebar, Claude Code as a chat or a terminal, a
PR status bar with CI checks, and Files and Source Control in the right panel.

## Install

Install Herdr and start it once. Then run:

```sh
curl -fsSL https://raw.githubusercontent.com/CalvinWalzel/conductr/main/install.sh | sh
```

The script puts the repo's git data in `~/.local/share/conductr.git` and checks its files out into
`~/.config/herdr-app`: the `conductr` layout and the `conductr-*` mods. It never overwrites a file
that is already there, and it leaves your keys, settings and other mods alone. Then it switches Herdr
to the Conductr layout.

On the first start, a setup dialog checks the programs Conductr uses (`git`, `gh`, `jq`, `python3`,
`claude`, and `codex` if you use it). It asks before it changes anything outside Herdr:

- **Resume hooks.** A SessionStart and SessionEnd hook in `~/.claude/settings.json` and
  `~/.codex/hooks.json` label each agent's terminal, so its session comes back after a reboot.
- **`restore_screen`.** herdr-core shows a terminal's last screen after a reboot.

It also asks for your branch prefix and the prompt that Create PR sends. Settings opens it again.

## Updates

Herdr checks for a new release every hour. When one exists, a blue button shows next to Settings.
It opens the changelog of every release you don't have yet, and Install updates. Herdr reloads the
changed mods at once. To update by hand, run the install command again.

## Change it

The files in `~/.config/herdr-app` are a normal git work tree, with the git data elsewhere:

```sh
alias conductr='git --git-dir="$HOME/.local/share/conductr.git"'
conductr status
conductr commit -am "..."
```

Herdr reloads a mod as soon as you save a file in it. `herdr-app check mods/<mod>` checks a mod.

## Remove it

```sh
cd ~/.config/herdr-app && rm -rf mods/conductr-* layouts/conductr.json install.sh README.md CHANGELOG.md .gitignore
rm -rf ~/.local/share/conductr.git
```

Then pick another layout with `ctrl-shift-l`.

## Release

Commits on `main` reach nobody until you release them. A release is a `v*` tag and a section in
`CHANGELOG.md`, newest first:

```sh
# 1. Add "## 0.2.0 - 2026-11-20" with a list of changes to the top of CHANGELOG.md, then:
conductr commit -am "Release 0.2.0" && conductr tag v0.2.0 && conductr push --follow-tags
```
