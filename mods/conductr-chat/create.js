// The Create screen (conductr-chat with props { create: true }): the layout's "main-stack" shows it
// in place of the tab, from conductr-spaces' Create. Pick a repo, where to work (a new worktree or
// the repo's main checkout) and an agent, write the first message in the chat's own composer, and
// Create starts it there: Claude Code as a chat tab, other agents in a terminal. A new worktree
// goes through conductr-worktree, so the repo's setup script runs.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Popover } from "gpui-base";
import { spaces, panes, focused, layout, knownAgents, exec, run, openOverlay, theme, shared, setShared, appHome } from "herdr";
import { Composer } from "./composer.js";
import { sendArgs } from "./parts.js";
import { repoKey } from "./repo-key.js";
import { branchBase, freeBranch } from "./branch.js";

export const CLAUDE = "conductr-chat.claude"; // { models, commands } a chat last reported
const STACK = "main-stack";
const OPENED = "conductr-create.opened"; // when conductr-spaces' Create was last clicked
const REPO = "conductr-create.repo"; // { key, at }: a repo chosen from the repo menu (conductr-menu)
const ADD = "conductr-create.add"; // { folder, at }: a repo picked from Add space (conductr-menu, conductr-clone)
const LAST = "conductr-create.last"; // { repo, place, agent, model, effort } used last
const AGENTS = "new-menu.agents"; // new-menu's cache of knownAgents() per machine
const DONE = "conductr-worktree.done"; // { overlay, error }: a quiet conductr-worktree finished
const PREFIX = "conductr-settings.branch-prefix"; // e.g. "calvin/": new worktree branches start with it
// Until a chat has reported Claude's own list.
const MODELS = [
  { value: "opus", displayName: "Opus", resolvedModel: "opus", supportsEffort: true },
  { value: "sonnet", displayName: "Sonnet", resolvedModel: "sonnet", supportsEffort: true },
  { value: "haiku", displayName: "Haiku", resolvedModel: "haiku", supportsEffort: true },
];
// How Claude Code runs: the chat (conductr-chat) or its own terminal UI.
const UIS = [["chat", "Chat", "mods/conductr-settings/lucide/message-square.svg"], ["terminal", "Terminal", "mods/conductr-settings/lucide/square-terminal.svg"]];
const PLACES = [["worktree", "New worktree", "mods/workspace-chrome/git-branch.svg"], ["main", "Main checkout", "mods/workspace-chrome/folder.svg"]];
// Avatar colors, as conductr-spaces draws them.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const shown = () => find(layout(), STACK)?.active === "create";
const back = () => run("layout.select", { stack: STACK, child: "main" });

// The repo a folder is in: { key (conductr-spaces' repo key), main, top, machine, name }, or null outside git.
async function repoOf(folder, machine) {
  const r = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { cwd: folder, on: machine }).catch(() => null);
  if (r?.code !== 0) return null;
  const [top, common] = r.stdout.trim().split("\n");
  const main = common.replace(/\/\.git$/, "");
  return { key: repoKey(machine, common), main, top, machine: machine ?? null, name: main.split("/").pop() };
}

export class Create {
  constructor(cx) {
    this.opened = shared(OPENED) ?? 0;
    this.added = shared(ADD)?.at;
    this.chosen = shared(REPO)?.at;
    this.tab = focused()?.tab ?? null;
    this.repos = [];
    this.agents = {}; // machine ("" here) -> knownAgents()
    this.menu = null; // the open picker's key
    this.mode = null;
    this.error = "";
    const last = shared(LAST) ?? {};
    this.pick = { repo: last.repo, place: last.place ?? "worktree", agent: last.agent ?? "claude", ui: last.ui ?? "chat" };
    this.model = last.model ?? "opus";
    this.effort = last.effort ?? "high";
    this.composer = new Composer(cx, {
      placeholder: "What do you want to work on?",
      dir: () => this.dir,
      cwd: () => this.repo()?.main,
      state: () => this.state(),
      busy: () => false,
      send: (cx) => cx.spawn(async (cx) => this.create(cx)),
      stop: () => {},
      setMode: (mode, cx) => { this.mode = mode; cx.notify(); },
      escape: () => back(),
    });
    this.prepare(cx);
    cx.spawn(async (cx) => {
      const ps = panes();
      const found = await Promise.all(spaces().map(async (s) => {
        const tabs = new Set((s.tabs ?? []).map((c) => c.id));
        const at = ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
        return at ? { repo: await repoOf(at, s.machine), space: s } : null;
      }));
      const byKey = new Map();
      for (const f of found) {
        if (!f?.repo) continue;
        const repo = byKey.get(f.repo.key) ?? { ...f.repo, color: f.space.id };
        // The space whose first terminal is in the main checkout: Main checkout opens a tab there.
        if (f.repo.top === f.repo.main) repo.space ??= f.space.id;
        byKey.set(f.repo.key, repo);
      }
      this.repos = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
      if (!byKey.has(this.pick.repo)) this.pick.repo = found.find((f) => f?.space.active && f.repo)?.repo.key ?? this.repos[0]?.key;
      cx.notify();
      await this.loadAgents(cx);
    });
  }

  // As events.js keeps a chat's: the model by its full name (this.model is its alias, "opus").
  state() {
    const models = shared(CLAUDE)?.models ?? MODELS;
    const model = models.find((candidate) => candidate.value === this.model)?.resolvedModel ?? this.model;
    return { models, commands: shared(CLAUDE)?.commands ?? [], model, effort: this.effort, mode: this.mode };
  }

  // The next chat's folder (prepare.sh): pasted images and the `@` file list go there.
  // ponytail: one unused chat folder is left behind per app start.
  prepare(cx) {
    this.dir = null;
    cx.spawn(async () => { this.dir = (await exec("sh", [`${appHome()}/mods/conductr-chat/prepare.sh`])).stdout.trim() || null; });
  }

  repo() {
    return this.repos.find((r) => r.key === this.pick.repo);
  }

  agentList() {
    return this.agents[this.repo()?.machine ?? ""] ?? shared(AGENTS)?.[this.repo()?.machine ?? ""] ?? [];
  }

  agent() {
    const installed = this.agentList().filter((a) => a.installed);
    return installed.find((a) => a.key === this.pick.agent) ?? installed[0];
  }

  async loadAgents(cx) {
    const machine = this.repo()?.machine ?? "";
    if (this.agents[machine]) return;
    try { this.agents[machine] = await knownAgents({ on: machine || undefined }); }
    catch { this.agents[machine] = []; }
    cx.notify();
  }

  choose(changes, cx) {
    if (changes.repo && changes.repo !== this.pick.repo) this.composer.relist();
    Object.assign(this.pick, changes);
    this.menu = null;
    setShared(LAST, { ...shared(LAST), ...this.pick });
    cx.spawn(async (cx) => this.loadAgents(cx));
    this.composer.box.focus();
    cx.notify();
  }

  async adopt(folder, cx) {
    const repo = await repoOf(folder, null);
    if (!repo) { this.error = `${folder} is not in a git repository.`; return cx.notify(); }
    if (!this.repos.some((r) => r.key === repo.key)) this.repos.push(repo);
    this.choose({ repo: repo.key }, cx);
  }

  async create(cx) {
    const repo = this.repo();
    const agent = this.agent();
    if (this.busy || !repo || !agent || !this.dir) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    try { await this.start(cx, repo, agent); }
    catch (error) { this.error = String(error?.message ?? error); }
    finally { this.busy = false; cx.notify(); }
  }

  async start(cx, repo, agent) {
    const composer = this.composer;
    const model = composer.current();
    const effort = composer.effort();
    // The message stays in the box, disabled, until the chat or worktree is made.
    const { parts, text } = composer.message();
    cx.notify();
    // A chat runs here only: its folder is on this computer.
    const chat = agent.key === "claude" && !repo.machine && this.pick.ui !== "terminal";
    let argv = agent.key === "claude" ? [...agent.run, "--model", model?.value ?? this.model, ...(effort ? ["--effort", effort] : []),
      ...(this.mode ? ["--permission-mode", this.mode] : [])] : agent.run;
    // A terminal agent gets the chips as paths in its first message.
    let task = text || undefined;
    let tab;
    let worktree;
    if (chat) {
      // run.sh feeds in.jsonl to Claude from its first line: the settings, then the message.
      const dir = this.dir;
      const requests = [
        model && { subtype: "set_model", model: model.value },
        effort && { subtype: "apply_flag_settings", settings: { effortLevel: effort } },
        this.mode && { subtype: "set_permission_mode", mode: this.mode },
      ].filter(Boolean).map((request, index) => JSON.stringify({ type: "control_request", request_id: `c${Date.now()}-${index}`, request }));
      if (requests.length) await exec("sh", ["-c", 'printf "%s\\n" "$1" >> "$2"', "x", requests.join("\n"), `${dir}/in.jsonl`]);
      if (parts.length) await exec("sh", [`${appHome()}/mods/conductr-chat/send.sh`, dir, ...sendArgs(parts)]);
      argv = ["sh", `${appHome()}/mods/conductr-chat/run.sh`, dir];
      task = undefined;
      tab = "Chat";
      this.prepare(cx);
      composer.relist();
    }
    if (this.pick.place === "main") {
      if (repo.space) {
        run("space.select", { id: repo.space });
        run("tab.new", { space: repo.space, name: tab, folder: repo.main, argv, task });
      } else run("space.new", { folder: repo.main, machine: repo.machine ?? "", tab, argv, task });
    } else {
      // A branch named after the first words of the message; one that exists gets a number.
      const words = parts.filter((part) => part.text).map((part) => part.text).join(" ");
      const branch = await freeBranch(branchBase(words, shared(PREFIX) ?? ""), async (name) =>
        (await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd: repo.main, on: repo.machine })).code === 0);
      // An invisible window, so nothing shows and nothing waits on a click (conductr-worktree's quiet).
      worktree = openOverlay({ mod: "conductr-worktree", kind: "window", frame: "none", width: 1, height: 1,
        props: { folder: repo.main, machine: repo.machine, branch, tab, argv, task, quiet: true } });
    }
    this.model = model?.value ?? this.model;
    this.effort = effort;
    setShared(LAST, { ...this.pick, model: this.model, effort });
    const done = worktree && await this.finished(worktree, cx);
    if (done?.error) this.error = done.error;
    else {
      composer.clear();
      back();
    }
  }

  // ponytail: polls; gives up after 10 minutes, git worktree add's own timeout.
  async finished(overlay, cx) {
    for (let tries = 0; tries < 3000; tries++) {
      const done = shared(DONE);
      if (done?.overlay === overlay) return done;
      await new Promise((resolve) => cx.timer.after(200, resolve));
    }
    return null;
  }

  // Conductr-spaces' Create focuses the message; going to a tab while this shows goes back to it; a
  // repo picked from Add space is added to the list and chosen.
  follow(cx) {
    const chosen = shared(REPO);
    if (chosen && chosen.at !== this.chosen) {
      this.chosen = chosen.at;
      this.choose({ repo: chosen.key }, cx);
    }
    const add = shared(ADD);
    if (add && add.at !== this.added) {
      this.added = add.at;
      cx.spawn(async (cx) => this.adopt(add.folder, cx));
    }
    const opened = shared(OPENED) ?? 0;
    const tab = focused()?.tab ?? null;
    if (opened !== this.opened) {
      this.opened = opened;
      this.tab = tab;
      this.composer.box.focus();
    } else if (tab !== this.tab && shown()) {
      this.tab = tab;
      back();
    }
  }

  // A repo's avatar, as conductr-spaces draws its spaces': conductr-settings' icon, else its first letter.
  avatar(repo, t, size = 18) {
    const color = shared("space.colors")?.[repo?.color] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    const box = h_flex().size(size).flex_none().rounded(5).items_center().justify_center();
    const icon = repo && shared("conductr-settings.icons")?.[repo.key];
    if (icon?.kind === "image") return box.child(image(`mods/conductr-settings/.images/${icon.value}`).size(size).rounded(5));
    if (icon?.kind === "emoji") return box.text_size(size * 0.72).child(icon.value);
    if (icon?.kind === "icon") return box.bg(fill).text_color("#ffffff").child(svg(`mods/conductr-settings/lucide/${icon.value}.svg`).size(size * 0.66));
    return box.bg(fill).text_size(size * 0.58).font_bold().text_color("#ffffff").child([...(repo?.name ?? "?")][0].toUpperCase());
  }

  // Items: { id, label, icon?, on?, pick } rows and { line: true } dividers.
  picker(key, anchor, trigger, items, t) {
    return Popover.new(key).anchor(anchor).open(this.menu === key)
      .on_open_change((open, cx) => { this.menu = open ? key : null; cx.notify(); })
      .trigger(trigger)
      .content(v_flex().mt(4).p(4).min_w(200).rounded(10).border_1().border_color(t.border).bg(t.popover)
        .children(items.map((item) => item.line ? div().h(1).mx(4).my(4).bg(t.border)
          : h_flex().id(`${key}-${item.id}`).h(32).px(8).gap(10).items_center().rounded(7).text_size(13).cursor_pointer()
            .text_color(item.on ? t.foreground : t.muted)
            .when(item.on, (el) => el.bg(t.selected))
            .when(!item.on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
            .on_click((_e, cx) => item.pick(cx))
            .when(Boolean(item.icon), (el) => el.child(item.icon))
            .child(div().flex_1().truncate().child(item.label))
            .when(item.on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).text_color(t.foreground))))));
  }

  chip(id, children, t) {
    return h_flex().id(id).h(28).px(8).gap(8).items_center().rounded(7).cursor_pointer().text_size(13).text_color(t.muted)
      .when(this.menu === id, (el) => el.bg(t.hover).text_color(t.foreground))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .children(children)
      .child(svg("mods/workspace-chrome/chevron-down.svg").size(12).text_color(t.dim));
  }

  agentIcon(a, t) {
    if (!a?.icon) return svg("icons/shell.svg").size(14).text_color(t.muted);
    return a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14);
  }

  render(cx) {
    const t = theme();
    this.follow(cx);
    const composer = this.composer;
    const repo = this.repo();
    const agent = this.agent();
    const ready = Boolean(repo && agent && this.dir) && !this.busy;

    // The repo menu is conductr-menu's, as the sidebar's ⋯: Add space opens beside it.
    const repoPicker = this.chip("repo", [repo ? this.avatar(repo, t) : svg("mods/workspace-chrome/folder.svg").size(14), div().text_color(t.foreground).child(repo?.name ?? (this.repos.length ? "Pick a space" : "…"))], t)
      .on_click(() => openOverlay({ mod: "conductr-menu", kind: "popup", frame: "none", width: 560, height: 460,
        props: { tab: "create-repo", flyout: true, target: { current: this.pick.repo, repos: this.repos.map(({ key, name, machine, color }) => ({ key, name, machine, color })) } } }));

    const place = PLACES.find(([key]) => key === this.pick.place) ?? PLACES[0];
    const placePicker = this.picker("place", "top_left",
      this.chip("place", [svg(place[2]).size(14), div().child(place[1])], t),
      PLACES.map(([key, name, icon]) => ({ id: key, label: name, icon: svg(icon).size(14).text_color(t.muted), on: key === place[0], pick: (cx) => this.choose({ place: key }, cx) })), t);

    // Chat or terminal, for Claude Code on this computer (a chat's folder is here).
    const ui = UIS.find(([key]) => key === this.pick.ui) ?? UIS[0];
    const uiPicker = this.picker("ui", "top_right",
      this.chip("ui", [svg(ui[2]).size(14), div().child(ui[1])], t),
      UIS.map(([key, name, icon]) => ({ id: key, label: name, icon: svg(icon).size(14).text_color(t.muted), on: key === ui[0], pick: (cx) => this.choose({ ui: key }, cx) })), t);

    const installed = this.agentList().filter((a) => a.installed);
    const agentPicker = this.picker("agent", "top_right",
      this.chip("agent", [this.agentIcon(agent, t), div().text_color(t.foreground).child(agent?.name ?? "Checking agents…")], t),
      installed.map((a) => ({ id: a.key, label: a.name, icon: this.agentIcon(a, t), on: a.key === agent?.key, pick: (cx) => this.choose({ agent: a.key }, cx) })), t);

    const button = h_flex().id("create-go").h(28).px(10).gap(6).items_center().rounded(6).text_size(12)
      .bg(ready ? t.foreground : t.raised).text_color(ready ? t.background : t.dim)
      .when(ready, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).tooltip("Create  ↵"))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); if (ready) cx.spawn(async (cx) => this.create(cx)); })
      .when(this.busy, (el) => el.child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
      .child("Create").child(div().child("↵"));

    // While it creates, the form is dimmed and a cover takes the presses meant for it.
    const cover = div().id("create-cover").absolute().top(0).left(0).size_full()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_mouse_up("left", (_e, cx) => cx.stop_propagation());
    return v_flex().id("create").size_full().bg(t.background).text_size(12.5).text_color(t.foreground).items_center().pt(120).px(16)
      .on_drop((event, cx) => composer.drop(event.paths ?? [], cx))
      .child(v_flex().relative().w_full().max_w(640).gap(8).when(Boolean(this.busy), (el) => el.opacity(0.6))
        .child(h_flex().items_center().gap(2).child(repoPicker).child(placePicker).child(div().flex_1())
          .when(agent?.key === "claude" && !repo?.machine, (el) => el.child(uiPicker)).child(agentPicker))
        .child(composer.view(t, { action: button, error: this.error, claude: agent?.key === "claude", disabled: this.busy }))
        .when(Boolean(composer.menu), (el) => el.child(composer.menuView(t).w_full()))
        .when(Boolean(this.busy), (el) => el.child(cover)));
  }
}
