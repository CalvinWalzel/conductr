// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead, "conductr-settings" the settings dialog.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec, shared, setShared, knownAgents, appHome, home } from "herdr";
import { repoKey } from "./repo-key.js";
import { recentRepos } from "./recents.js";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: { kind: "main" (a repo's own) | "linked" (a worktree), top: its folder }, or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  const path = top.stdout.trim();
  return { kind: common.stdout.trim() === `${path}/.git` ? "main" : "linked", top: path, common: common.stdout.trim() };
}

const AGENTS = "conductr-menu.agents";
// conductr-spaces draws and moves these: space id -> { status, ... }, and its grouping.
const STATUS = "conductr-spaces.status";
const GROUP = "conductr-spaces.group";
const STATUSES = [
  ["backlog", "Backlog", (t) => t.dim],
  ["in_progress", "In progress", (t) => t.ansi3],
  ["in_review", "In review", () => "#3fae6a"],
  ["done", "Done", () => "#c9a48a"],
  ["canceled", "Canceled", (t) => t.muted],
];
// Pane names given from a split tab's pane menu (Herdr has no pane rename): pane id -> name.
const PANE_NAMES = "conductr-spaces.pane-names";
const statusIcon = (key) => `mods/conductr-spaces/status-${key}.svg`;
// Add space: Open project asks conductr-spaces for the folder picker (this menu closes under it);
// a folder picked with `pick` goes to the Create screen instead of a new space.
const PICK_FOLDER = "conductr-menu.pick-folder";
function addSpace(folder, pick) {
  if (pick) setShared("conductr-create.add", { folder, at: Date.now() });
  else run("space.new", { folder, machine: "" });
}
// Recent repos: the git repos under ~/src (two levels) whose index changed last, newest first.
const RECENTS = 'ls -dt "$HOME"/src/*/.git/index "$HOME"/src/*/*/.git/index 2>/dev/null | head -n 20';
// Avatar colors, as conductr-spaces draws them.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
// A repo's avatar, as conductr-spaces draws its spaces': conductr-settings' icon, else its first letter.
// `repo`: { key (conductr-spaces' repo key), name, color (a space id whose color it takes) }.
function avatar(repo, t, size = 16) {
  const color = shared("space.colors")?.[repo.color] ?? "ansi6";
  const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
  const box = h_flex().size(size).flex_none().rounded(4).items_center().justify_center();
  const icon = shared("conductr-settings.icons")?.[repo.key];
  if (icon?.kind === "image") return box.child(image(`mods/conductr-settings/.images/${icon.value}`).size(size).rounded(4));
  if (icon?.kind === "emoji") return box.text_size(size * 0.72).child(icon.value);
  if (icon?.kind === "icon") return box.bg(fill).text_color("#ffffff").child(svg(`mods/conductr-settings/lucide/${icon.value}.svg`).size(size * 0.66));
  return box.bg(fill).text_size(size * 0.58).font_bold().text_color("#ffffff").child([...(repo.name ?? "?")][0].toUpperCase());
}
const tilde = (path) => (path.startsWith(home()) ? `~${path.slice(home().length)}` : path);

function items(p, git, agents, recents) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      // A terminal shown outside a tab (a layout terminal block, a window) has
      // no pane to split, zoom or close: its pane is the block's id.
      const inTab = panes().some((pane) => pane.pane === tg.pane);
      return [
        ...(inTab
          ? [
              ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
              ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
              ["Zoom", "pane.zoom", { pane: tg.pane }],
            ]
          : []),
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ...(inTab ? [["Close pane", "pane.close", { pane: tg.pane }]] : []),
      ];
    }
    case "tab": {
      // Unread tabs are listed in shared "conductr-spaces.unread"; conductr-spaces draws and clears them.
      // Unread is about an agent finishing: a tab with none (`agent: false`) has no such item.
      const unread = (shared("conductr-spaces.unread") ?? []).includes(tg.id);
      return [
        ...(tg.agent === false ? [] : [[unread ? "Mark as read" : "Mark as unread", "unread", { id: tg.id, unread: !unread }, { icon: "mods/conductr-menu/mail.svg" }]]),
        ["Rename", "tab.rename", { id: tg.id }],
        ["Close", "tab.close", { id: tg.id }],
      ];
    }
    case "split":
      // A split tab's row in conductr-spaces: Close ends every pane in it.
      return [
        ["Rename", "tab.rename", { id: tg.id }],
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "split-pane": {
      // One pane of a split tab, from conductr-spaces. Unread pane ids share the tabs' list;
      // only an agent's pane can be unread.
      const unread = (shared("conductr-spaces.unread") ?? []).includes(tg.pane);
      return [
        ...(tg.agent ? [[unread ? "Mark as read" : "Mark as unread", "unread", { id: tg.pane, unread: !unread }, { icon: "mods/conductr-menu/mail.svg" }]] : []),
        ["Rename", "pane-rename", { pane: tg.pane, name: tg.name }, { icon: "square-pen" }],
        ["Close", "pane.close", { pane: tg.pane }],
      ];
    }
    case "viewer":
      // A right-click in conductr-viewer's diff: the selection's text comes along to copy.
      return [
        ...(tg.text ? [["Copy", "copy", { text: tg.text }, { icon: "mods/conductr-menu/copy.svg", hint: "⌘C" }]] : []),
        ["Select all", "conductr-viewer.select-all", {}, { icon: "square", hint: "⌘A" }],
      ];
    case "repo":
      // From the top bar's repo name.
      return [
        ["Repository settings", "conductr-settings", { repo: tg.repo }, { icon: "settings" }],
        ...(tg.url ? [["Open on GitHub", "exec", { cmd: "open", args: [tg.url] }, { icon: "mods/conductr-menu/external.svg" }]] : []),
      ];
    case "open":
      // From the top bar's Open chevron: the installed apps conductr-tabs found, then the path itself.
      return [
        ...(shared("conductr-tabs.open-apps") ?? []).map((app) => [app.name, "open-in", { app: app.path, key: app.key, path: tg.path }, app.icon ? { image: app.icon } : { icon: "monitor" }]),
        ["Copy path", "copy", { text: tg.path }, { icon: "files", group: true }],
      ];
    case "pr":
      // From the top bar's Create PR chevron: GitHub's new PR page for the shown branch.
      return [["Create PR manually", "exec", { cmd: "open", args: [tg.compare] }, { icon: "mods/conductr-menu/external.svg" }]];
    case "review":
      // From the top bar's Review chevron: every installed agent. Claude reads `@file` itself.
      return agents.filter((a) => a.installed).map((a) =>
        [a.name, "review", { ...tg.args, argv: a.run, task: a.key === "claude" ? tg.claudeTask : tg.task }, { image: a.icon, tint: a.tint }]);
    case "change": {
      // A changed file from the Source Control panel; View and Discard run in conductr-source-control.
      return [
        ["View", "conductr-source-control.view", {}, { icon: "mods/conductr-settings/lucide/eye.svg" }],
        ["Copy path", "copy", { text: tg.file }, { group: true, icon: "mods/conductr-menu/copy.svg" }],
        ["Copy relative path", "copy", { text: tg.relative }, { icon: "mods/conductr-menu/copy.svg" }],
        ["Discard changes", "conductr-source-control.ask-discard", {}, { group: true, icon: "mods/conductr-settings/lucide/undo-2.svg" }],
      ];
    }
    case "file": {
      // A file or folder from the Files panel. Finder only reaches this computer's files.
      // Cut, copy, paste, rename and delete run in conductr-files, which remembers the target.
      const local = !tg.on;
      const clip = shared("conductr-files.clipboard");
      const finder = !local ? [] : tg.dir
        ? [["Open in Finder", "exec", { cmd: "open", args: [tg.file] }, { icon: "folder" }]]
        : [["Open with default app", "exec", { cmd: "open", args: [tg.file] }, { icon: "monitor" }],
           ["Reveal in Finder", "exec", { cmd: "open", args: ["-R", tg.file] }, { icon: "folder" }]];
      const icon = (name) => `mods/conductr-menu/${name}.svg`;
      return [
        ...(tg.dir ? [] : [["Open", "conductr-files.open", {}, { icon: "file-text" }]]),
        ...finder,
        ["Cut", "conductr-files.cut", {}, { group: true, icon: icon("scissors") }],
        ["Copy", "conductr-files.copy", {}, { icon: icon("copy") }],
        ...(tg.dir && clip && (clip.on ?? null) === (tg.on ?? null) ? [[`Paste ${clip.file.split("/").pop()}`, "conductr-files.paste", {}, { icon: icon("clipboard") }]] : []),
        ["Copy path", "copy", { text: tg.file }, { group: true, icon: "files" }],
        ["Copy relative path", "copy", { text: tg.relative }, { icon: "files" }],
        ["Rename", "conductr-files.rename", {}, { group: true, icon: "square-pen" }],
        ["Delete", "confirm", { title: `Delete ${tg.file.split("/").pop()}?`, detail: local ? `Moves ${tg.file} to the Trash.` : `Removes ${tg.file} for good.`, command: { name: "conductr-files.delete" } }, { icon: icon("trash") }],
      ];
    }
    case "space": {
      // The space's checkout, else the folder its first terminal is in now.
      const space = spaces().find((s) => s.id === tg.id);
      const path = git?.top ?? (space && place(space));
      const current = STATUSES.find(([key]) => key === (shared(STATUS)?.[tg.id]?.status ?? "in_progress"));
      return [
        ["Set status", "sub", { tab: "status", target: { id: tg.id } }, { icon: statusIcon(current[0]), color: current[2](theme()) }],
        ["Rename", "space.rename", { id: tg.id }],
        // The repo key conductr-spaces uses for a space's repo (see its check()).
        ...(git ? [["Space settings…", "conductr-settings", { repo: repoKey(space?.machine, git.common) }, { icon: "settings" }]] : []),
        ...(path ? [["Copy path", "copy", { text: path }, { icon: "files" }]] : []),
        // A fourth element starts a group ({ group: true }: a line above it) or sets the icon.
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }, { group: true }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git?.kind === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ["New tab", "tab.new", { space: tg.id }, { group: true }],
        ...(path ? [["New chat", "exec", { cmd: "sh", args: [`${appHome()}/mods/conductr-chat/new.sh`, tg.id, path] }]] : []),
        ["Close", "space.close", { id: tg.id }],
      ];
    }
    case "status": {
      // From the space menu's Set status.
      const current = shared(STATUS)?.[tg.id]?.status ?? "in_progress";
      return STATUSES.map(([key, label, color]) =>
        [label, "status", { id: tg.id, status: key }, { icon: statusIcon(key), color: color(theme()), checked: key === current }]);
    }
    case "settings":
      // From the sidebar footer's Settings.
      return [
        ["Herdr Settings", "app.settings", {}, { icon: "settings" }],
        ["Conductr settings", "conductr-settings", {}, { icon: "square-pen" }],
      ];
    case "spaces":
      // From the Spaces header's ⋯.
      return [
        ["Group by", "sub", { tab: "group" }, { icon: "layers" }],
        ["Add space", "sub", { tab: "add-space" }, { icon: "mods/conductr-settings/lucide/folder-plus.svg" }],
      ];
    case "create-repo":
      // The Create screen's repo menu: its repos (target.repos), then Add space.
      return [
        ...(tg.repos ?? []).map((repo) => [repo.machine ? `${repo.name} · ${repo.machine}` : repo.name, "create-repo", { key: repo.key }, { avatar: repo, checked: repo.key === tg.current }]),
        ["Add space", "sub", { tab: "add-space", target: { pick: true } }, { icon: "mods/conductr-settings/lucide/folder-plus.svg", group: true }],
      ];
    case "add-space": {
      // From the Spaces header's ⋯, and the Create screen's repo menu (`pick`).
      const pick = Boolean(tg.pick);
      return [
        ["Open project", "add-space", { how: "folder", pick }, { icon: "folder" }],
        ["Open GitHub project", "add-space", { how: "github", pick }, { icon: "mods/conductr-settings/lucide/globe.svg" }],
        ["Quick start", "add-space", {}, { icon: "mods/conductr-settings/lucide/folder-plus.svg", disabled: true }],
        ...(recents?.length ? [["Recents", "header", {}], ...recents.map((folder) => [tilde(folder), "add-space", { how: "recent", folder, pick }, { icon: "folder" }])] : []),
      ];
    }
    case "group": {
      const by = shared(GROUP) ?? "project";
      return [
        ["Project", "group", { by: "project" }, { icon: "folder", checked: by === "project" }],
        ["Status", "group", { by: "status" }, { icon: statusIcon("in_progress"), checked: by === "status" }],
      ];
    }
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

function menuIcon(command, options) {
  if (options?.icon?.includes("/")) return options.icon;
  const name = options?.icon ? options.icon : command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "copy" ? "folder" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

const ITEM = 31, PAD = 5, SEP_MARGIN = 4, MAIN = 200, SUB = 190;

// A line above an item that starts a group.
function separated(list, i) {
  const it = list[i];
  return i > 0 && (it[3]?.group || it[1].endsWith(".close") || it[1] === "app.help" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme"));
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.sub = null; // the open submenu's item
    this.subAt = -1; // the keyboard's item in it, -1 while the keyboard is in the menu
    this.git = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    if (p?.tab === "review") {
      // The last list this machine reported, shown at once while knownAgents() checks again.
      const where = p.target.machine ?? "";
      this.agents = shared(AGENTS)?.[where] ?? [];
      cx.spawn(async (cx) => {
        this.agents = await knownAgents({ on: p.target.machine }).catch(() => this.agents);
        setShared(AGENTS, { ...shared(AGENTS), [where]: this.agents });
        cx.notify();
      });
    }
    if (["spaces", "add-space", "create-repo"].includes(p?.tab)) cx.spawn(async (cx) => this.loadRecents(cx));
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
  }

  // Recent repos that no space on this computer is in yet (a worktree's space counts for its repo).
  async loadRecents(cx) {
    const listed = await exec("sh", ["-c", RECENTS]).catch(() => null);
    const open = new Set(await Promise.all(spaces().filter((s) => !s.machine).map(async (s) => {
      const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: place(s) }).catch(() => null);
      return r?.code === 0 ? r.stdout.trim().replace(/\/\.git$/, "") : null;
    })));
    this.recents = recentRepos(listed?.stdout ?? "", open);
    cx.notify();
  }

  // A "sub" item's own items, shown beside the menu while it's open.
  subItems(list) {
    const it = this.sub === null ? null : list[this.sub];
    return it?.[1] === "sub" ? items({ tab: it[2].tab, target: it[2].target }, this.git, this.agents, this.recents) : [];
  }

  openSub(i, keyboard, cx) {
    this.sub = i;
    this.subAt = keyboard ? 0 : -1;
    cx.notify();
  }

  choose(it, i, cx) {
    if (!it || it[1] === "header" || it[3]?.disabled) return;
    if (it[1] === "sub") return this.openSub(i, true, cx);
    closeOverlay(props()?.overlay);
    if (it[1] === "copy") cx.write_to_clipboard(it[2].text);
    else if (it[1] === "unread") {
      const rest = (shared("conductr-spaces.unread") ?? []).filter((id) => id !== it[2].id);
      setShared("conductr-spaces.unread", it[2].unread ? [...rest, it[2].id] : rest);
    }
    else if (it[1] === "status") {
      const all = shared(STATUS) ?? {};
      setShared(STATUS, { ...all, [it[2].id]: { ...all[it[2].id], status: it[2].status } });
    }
    else if (it[1] === "group") setShared(GROUP, it[2].by);
    else if (it[1] === "create-repo") setShared("conductr-create.repo", { key: it[2].key, at: Date.now() });
    else if (it[1] === "add-space") {
      if (it[2].how === "folder") setShared(PICK_FOLDER, { pick: it[2].pick, at: Date.now() });
      else if (it[2].how === "github") openOverlay({ mod: "conductr-clone", kind: "dialog", width: 560, height: 620, props: { pick: it[2].pick } });
      else addSpace(it[2].folder, it[2].pick);
    }
    else if (it[1] === "pane-rename") openOverlay({ mod: "conductr-prompt", kind: "dialog", width: 420, height: 210,
      props: { title: "Rename pane", value: it[2].name, hint: "Empty: its own label again.", store: { key: PANE_NAMES, id: it[2].pane } } });
    else if (it[1] === "exec") exec(it[2].cmd, it[2].args);
    // The top bar's Open button then opens the same app.
    else if (it[1] === "open-in") { exec("open", ["-a", it[2].app, it[2].path]); setShared("conductr-tabs.open-app", it[2].key); }
    else if (it[1] === "review") run("tab.new", it[2]);
    else if (it[1] === "conductr-settings") openOverlay({ mod: "conductr-settings", kind: "dialog", width: 760, height: 560, props: it[2] });
    else if (it[1] === "confirm") openOverlay({ mod: "confirm", kind: "dialog", width: 420, height: 170, props: it[2] });
    else if (it[1] === "worktree") openOverlay({ mod: "conductr-worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else run(it[1], it[2]);
  }

  rows(list, at, prefix, t, hover, choose) {
    return list.map((it, i) => it[1] === "header"
      ? div().px(8).pt(10).pb(4).text_size(11).text_color(t.dim).child(it[0])
      : v_flex()
        .when(separated(list, i), (el) => el.child(div().mx(7).my(SEP_MARGIN).h(1).bg(t.border)))
        .child(h_flex()
          .id(`${prefix}-${i}`)
          .h(ITEM)
          .px(8)
          .gap(9)
          .rounded(7)
          .items_center()
          .justify_between()
          .text_color(it[3]?.disabled ? t.dim : t.foreground)
          .when(i === at && !it[3]?.disabled, (el) => el.bg(t.selected))
          .when(!it[3]?.disabled, (el) => el.hover((s) => s.bg(t.hover))
            .on_hover((hovered, cx) => { if (hovered) { hover(i); cx.notify(); } })
            .on_click((_e, cx) => choose(i, cx)))
          .child(it[3]?.avatar ? avatar(it[3].avatar, t) : it[3]?.image ? (it[3].tint ? svg(it[3].image).size(14).flex_none().text_color(t.foreground) : image(it[3].image).size(14).flex_none()) : svg(menuIcon(it[1], it[3])).size(14).flex_none().text_color(it[3]?.color ?? t.muted))
          .child(div().flex_1().child(it[0]))
          .child(it[1] === "sub"
            ? svg("mods/workspace-chrome/chevron-right.svg").size(12).flex_none().text_color(t.muted)
            : it[3]?.checked
              ? svg("mods/workspace-chrome/check.svg").size(13).flex_none().text_color(t.muted)
              : div().text_size(11).text_color(t.dim).child(it[3]?.hint ?? shortcut(it[1], it[2])))));
  }

  render(cx) {
    const t = theme();
    const list = items(props(), this.git, this.agents, this.recents);
    const subList = this.subItems(list);
    const inSub = this.subAt >= 0 && subList.length > 0;
    // With `flyout` the opener drops Herdr's frame (frame: "none") and leaves room on the right,
    // so a submenu can sit beside the menu: each panel draws its own frame.
    const flyout = Boolean(props()?.flyout);
    const panel = (el) => el.p(PAD).bg(t.popover).text_size(12.8)
      .when(flyout, (el) => el.border_1().border_color(t.border).rounded(10).shadow_md());
    // Add space lists folders: wider than the other menus.
    const wide = (tab) => (tab === "add-space" ? 300 : tab === "create-repo" ? 240 : null);
    const main = panel(v_flex().when(flyout, (el) => el.w(wide(props()?.tab) ?? MAIN)).when(!flyout, (el) => el.w_full().min_h(0)))
      .when(props()?.tab === "review", (el) => el.child(div().px(8).pt(4).pb(4).text_size(11).text_color(t.dim)
        .child(list.length ? "Review with" : "Checking installed agents…")))
      .children(this.rows(list, inSub ? this.sub : this.at, "mi", t,
        (i) => { this.at = i; this.sub = list[i][1] === "sub" ? i : null; this.subAt = -1; },
        (i, cx) => this.choose(list[i], i, cx)));
    // The submenu's first item lines up with the item that opened it.
    const top = list.slice(0, (this.sub ?? 0) + 1).reduce((y, _it, k) => y + (separated(list, k) ? 2 * SEP_MARGIN + 1 : 0) + (k < this.sub ? ITEM : 0), 0);
    const root = !flyout ? main : h_flex().items_start().gap(4).child(main)
      .when(subList.length > 0, (el) => el.child(panel(v_flex().w(wide(list[this.sub]?.[2]?.tab) ?? SUB).mt(top))
        .children(this.rows(subList, this.subAt, "si", t, (j) => { this.subAt = j; }, (j, cx) => this.choose(subList[j], j, cx)))));
    return root
      .id("menu")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const keys = inSub ? subList : list;
        if (!keys.length && e.key !== "escape") return;
        const move = (n) => (inSub ? (this.subAt = (this.subAt + n + keys.length) % keys.length) : (this.at = (this.at + n + keys.length) % keys.length));
        if (e.key === "down") move(1);
        else if (e.key === "up") move(-1);
        else if (e.key === "enter") inSub ? this.choose(subList[this.subAt], this.subAt, cx) : this.choose(list[this.at], this.at, cx);
        else if (e.key === "right" && !inSub && list[this.at]?.[1] === "sub") this.openSub(this.at, true, cx);
        else if ((e.key === "left" || e.key === "escape") && this.sub !== null) { this.sub = null; this.subAt = -1; }
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      });
  }
}
