// A thin top bar for layouts that list tabs in the sidebar: the window drag area, and at the top
// right the shown tab's actions (Create PR or its linked PR, Review) and the side panel toggle.
// Files and Source Control switch in the panel's own header. Scroll on the bar to change tabs.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, terminals, run, openOverlay, theme, window, shared, setShared, layout, settings, exec, notify, appHome, props } from "herdr";

// Set in conductr-settings.
// What Create PR sends; conductr-settings edits it and has the same default.
const prPrompt = () => shared("conductr-settings.pr-prompt") || "Create a draft pull request for this branch. Commit anything uncommitted, push the branch, write a short title and a description from the commits and the diff, then give me the link.";
const mainBranches = () => new Set(shared("conductr-settings.main-branches") ?? ["main", "master", "main-dev"]);

// The shown tab's Claude Code pane (the focused one if it is Claude), and the branch to make
// a PR from: that pane's, else the focused pane's.
function prContext() {
  const tab = spaces().find((s) => s.active)?.tabs.find((c) => c.active)?.id;
  const mine = panes().filter((p) => p.tab === tab && p.terminal);
  const isClaude = (p) => p.program?.key === "claude" || p.app === "claude-code";
  const claude = mine.find((p) => p.focused && isClaude(p)) ?? mine.find(isClaude);
  const lead = claude ?? mine.find((p) => p.focused) ?? mine[0];
  const machine = spaces().find((s) => s.active)?.machine ?? null;
  return { claude, branch: lead?.branch ?? null, cwd: lead?.cwd ?? null, machine };
}

// A conductr-chat backend reads its messages from a folder, not from its terminal: run.sh's argument.
function chatFolder(terminal) {
  const argv = terminals().find((t) => t.address === terminal)?.argv ?? [];
  return argv.some((arg) => arg.endsWith("-chat/run.sh")) ? argv[argv.length - 1] : null;
}

// "git@github.com:owner/repo.git" or "https://github.com/owner/repo(.git)" -> GitHub's new PR page.
function compareUrl(remote, branch) {
  const repo = remote.trim().match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1];
  return repo ? `https://github.com/${repo}/compare/${encodeURIComponent(branch)}?expand=1` : null;
}

// Types text into the tab's Claude: a conductr-chat backend through its folder, else its terminal.
function sendToClaude(claude, text, title) {
  const chat = chatFolder(claude.terminal);
  const sent = chat ? exec("sh", [`${appHome()}/mods/conductr-chat/send.sh`, chat, `t:${text}`]) : exec("hc", ["send", claude.terminal, text]);
  sent.then((r) => {
    if (r.code !== 0) notify({ title, body: (r.stderr || r.stdout).trim() || "Couldn't type into Claude", level: "warning" });
  });
}

const PR_FIELDS = "number,url,state,isDraft,mergeable,reviewDecision,baseRefName,statusCheckRollup";

// The latest run of each check (reruns repeat a name), counted as failing or pending. Graphite's
// mergeability check stays in progress until the PRs below in the stack merge, so a waiting one doesn't count.
function checkCounts(rollup) {
  const latest = new Map();
  for (const run of rollup ?? []) {
    const name = `${run.workflowName ?? ""}/${run.name ?? run.context}`;
    if ((run.startedAt ?? "") >= (latest.get(name)?.startedAt ?? "")) latest.set(name, run);
  }
  let failing = 0, pending = 0;
  for (const run of latest.values()) {
    if (run.name === "Graphite / mergeability_check" && run.status !== "COMPLETED") continue;
    if (run.__typename === "StatusContext") {
      if (run.state === "PENDING" || run.state === "EXPECTED") pending++;
      else if (run.state !== "SUCCESS") failing++;
    } else if (run.status !== "COMPLETED") pending++;
    else if (!["SUCCESS", "SKIPPED", "NEUTRAL", "CANCELLED", "STALE"].includes(run.conclusion)) failing++;
  }
  return { failing, pending };
}

// conductr-spaces' status palette, so the PR header and the sidebar's PR icons match.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space's avatar, as conductr-spaces draws it: its repo's icon from conductr-settings, else its first
// letter on its stable color. conductr-spaces shares which space's avatar the shown space wears.
function avatar(owner, g, t) {
  const color = (shared("space.colors") ?? {})[owner.id] ?? "ansi6";
  const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
  const box = h_flex().size(18).flex_none().rounded(5).items_center().justify_center();
  const icon = g && shared("conductr-settings.icons")?.[g.repo];
  if (icon?.kind === "image") return box.child(image(`mods/conductr-settings/.images/${icon.value}`).size(18).rounded(5));
  if (icon?.kind === "emoji") return box.text_size(13).child(icon.value);
  if (icon?.kind === "icon") return box.bg(fill).text_color("#ffffff").child(svg(`mods/conductr-settings/lucide/${icon.value}.svg`).size(12));
  return box.bg(fill).text_size(10.5).font_bold().text_color("#ffffff").child([...owner.name][0]?.toUpperCase() ?? "?");
}

// Apps the Open button offers, when installed: key, name, bundle.
const APPS = [
  ["finder", "Finder", "/System/Library/CoreServices/Finder.app"],
  ["cursor", "Cursor", "/Applications/Cursor.app"],
  ["vscode", "VS Code", "/Applications/Visual Studio Code.app"],
  ["zed", "Zed", "/Applications/Zed.app"],
  ["rubymine", "RubyMine", "/Applications/RubyMine.app"],
  ["xcode", "Xcode", "/Applications/Xcode.app"],
  ["ghostty", "Ghostty", "/Applications/Ghostty.app"],
  ["iterm", "iTerm", "/Applications/iTerm.app"],
  ["warp", "Warp", "/Applications/Warp.app"],
  ["terminal", "Terminal", "/System/Applications/Utilities/Terminal.app"],
  ["fork", "Fork", "/Applications/Fork.app"],
  ["tower", "Tower", "/Applications/Tower.app"],
];

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// base with amount (0..1) of over blended in, for #rrggbb colors.
function mix(base, over, amount) {
  const channels = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const [from, to] = [channels(base), channels(over)];
  return "#" + from.map((value, at) => Math.round(value + (to[at] - value) * amount).toString(16).padStart(2, "0")).join("");
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(props, cx) {
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    if (props?.side !== "panel") this.findApps(cx);
    // The last PR seen per branch, shown at once when it's shown again while the lookup runs.
    this.seen = new Map();
    // A PR made after the branch was shown (Create PR) turns up within a minute; running checks within
    // 20 seconds; a merge done in the browser as soon as the window is back in front.
    cx.timer.every(1000, (cx) => {
      const active = Boolean(window()?.active), back = active && !this.wasActive;
      this.wasActive = active;
      if (!active || !this.showingPr || !this.prWhere) return;
      const since = Date.now() - (this.lookedAt ?? 0);
      if ((back && since >= 5000) || since >= (this.pr?.checks.pending ? 20000 : 60000)) this.lookup(this.prWhere, cx);
    });
  }

  // The branch's GitHub compare page and its PR, if it has one.
  lookup(where, cx) {
    const [machine, cwd, branch] = JSON.parse(where);
    this.lookedAt = Date.now();
    cx.spawn(async (cx) => {
      const [remote, pr] = await Promise.all([
        exec("git", ["remote", "get-url", "origin"], { cwd, on: machine }).catch(() => null),
        exec("gh", ["pr", "view", branch, "--json", PR_FIELDS], { cwd, on: machine, timeout: 20000 }).catch(() => null),
      ]);
      if (this.prWhere !== where) return;
      if (remote?.code === 0) this.compare = compareUrl(remote.stdout, branch);
      // A failed lookup (offline, rate limit) keeps what was shown; only "no pull requests found" clears it.
      if (pr?.code === 0) {
        const data = JSON.parse(pr.stdout);
        this.pr = { number: data.number, url: data.url, state: data.state, isDraft: data.isDraft, mergeable: data.mergeable,
          reviewDecision: data.reviewDecision, base: data.baseRefName, checks: checkCounts(data.statusCheckRollup) };
      } else if (/no pull requests found/i.test(pr?.stderr ?? "")) this.pr = null;
      this.seen.set(where, { pr: this.pr, compare: this.compare });
      cx.notify();
    });
  }

  // The installed APPS with their icons (made once by app-icons.sh), shared for the Open menu.
  findApps(cx) {
    cx.spawn(async () => {
      const dir = `${appHome()}/data/conductr-tabs/app-icons`;
      const found = await exec("sh", ["-c", 'for p; do [ -d "$p" ] && echo "$p"; done', "x", ...APPS.map((app) => app[2])]);
      const installed = APPS.filter((app) => found.stdout.split("\n").includes(app[2]));
      await exec("sh", [`${appHome()}/mods/conductr-tabs/app-icons.sh`, dir, ...installed.map(([key, , path]) => `${key}=${path}`)]);
      const icons = new Set((await exec("ls", [dir])).stdout.split("\n"));
      const apps = installed.map(([key, name, path]) => ({ key, name, path, icon: icons.has(`${key}.png`) ? `data/conductr-tabs/app-icons/${key}.png` : null }));
      if (JSON.stringify(apps) !== JSON.stringify(shared("conductr-tabs.open-apps"))) setShared("conductr-tabs.open-apps", apps);
    });
  }

  // The shown space as Conductor's header shows it: its avatar and repo (a click: repository
  // settings or GitHub), then its branch (a click renames it in place), with ahead and behind.
  crumb(t, stop) {
    const current = shared("conductr-spaces.current");
    if (!current) return null;
    const g = current.git;
    const target = (el) => el.h(26).px(6).gap(7).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop);
    return h_flex().flex_shrink(1).min_w(0).gap(1).items_center().text_size(13)
      .child(target(h_flex().id("crumb-repo").flex_none())
        .when(Boolean(g), (el) => el.on_click((_e, cx) => this.repoMenu(g, cx)))
        .child(avatar(current.avatar, g, t))
        .child(div().font_medium().text_color(t.foreground).child(g ? g.name : current.name)))
      .when(Boolean(g), (el) => el.child(svg("mods/conductr-chrome/chevron-right.svg").size(12).flex_none().text_color(t.dim))
        .child(this.renaming
          ? Input.new(this.renaming).min_w(160).flex_1().h(26).px(6).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(13)
            .on_key_down((e, cx) => { if (e.key === "escape") { this.renaming = null; cx.stop_propagation(); cx.notify(); } })
          : target(h_flex().id("crumb-branch").flex_shrink(1).min_w(0)).tooltip("Rename branch")
            .on_click((_e, cx) => this.startRename(g, cx))
            .child(div().min_w(0).truncate().text_color(t.muted).child(g.branch)))
        .when(g.ahead > 0, (el) => el.child(div().flex_none().px(2).text_size(11.5).text_color(MARK.ansi2).child(`\u2191${g.ahead}`)))
        .when(g.behind > 0, (el) => el.child(div().flex_none().px(2).text_size(11.5).text_color(MARK.ansi1).child(`\u2193${g.behind}`))));
  }

  // The repo name's menu: its settings, and its GitHub page when origin is on GitHub.
  repoMenu(g, cx) {
    const { machine } = prContext();
    cx.spawn(async () => {
      const remote = await exec("git", ["remote", "get-url", "origin"], { cwd: g.top, on: machine }).catch(() => null);
      const repo = remote?.code === 0 && remote.stdout.trim().match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1];
      openOverlay({ mod: "conductr-menu", kind: "popup", width: 220, props: { tab: "repo", target: { repo: g.repo, url: repo ? `https://github.com/${repo}` : null } } });
    });
  }

  // The branch name edits in place: Enter renames it (git branch -m), Escape or leaving it cancels.
  startRename(g, cx) {
    const input = InputState.new({ value: g.branch });
    input.set_selected_range({ start: 0, end: g.branch.length });
    input.on("submit", (_e, cx) => this.renameBranch(g, input.value().trim(), cx));
    input.on("blur", (_e, cx) => { if (this.renaming === input) { this.renaming = null; cx.notify(); } });
    this.renaming = input;
    input.focus();
    cx.timer?.after(150, () => { if (this.renaming === input) input.focus(); });
    cx.notify();
  }

  renameBranch(g, name, cx) {
    this.renaming = null;
    cx.notify();
    if (!name || name === g.branch) return;
    const { machine } = prContext();
    cx.spawn(async () => {
      const r = await exec("git", ["branch", "-m", g.branch, name], { cwd: g.top, on: machine });
      if (r.code !== 0) notify({ title: "Rename branch failed", body: (r.stderr || r.stdout).trim(), level: "error" });
    });
  }

  // Opens the space's checkout in the app picked last (Finder at first); the chevron picks another.
  // This computer only: `open -a` can't reach another machine's folders.
  openButton(t, stop) {
    const current = shared("conductr-spaces.current"), apps = shared("conductr-tabs.open-apps") ?? [];
    const { cwd, machine } = prContext();
    const path = current?.git?.top ?? cwd;
    if (!path || machine || !apps.length) return null;
    const app = apps.find((a) => a.key === shared("conductr-tabs.open-app")) ?? apps[0];
    return h_flex().id("open").flex_none().h(24).items_center().rounded(6).border_1().border_color(t.border)
      .child(h_flex().id("open-app").h_full().px(6).items_center().rounded_l(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(`Open in ${app.name}`)
        .on_mouse_down("left", stop)
        .on_click(() => exec("open", ["-a", app.path, path]))
        .child(app.icon ? image(app.icon).size(15) : svg("mods/conductr-chrome/monitor.svg").size(14).text_color(t.muted)))
      .child(div().w(1).h_full().bg(t.border))
      .child(h_flex().id("open-more").h_full().px(5).items_center().rounded_r(6).text_color(t.muted)
        .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click(() => openOverlay({ mod: "conductr-menu", kind: "popup", width: 200, props: { tab: "open", target: { path } } }))
        .child(svg("mods/conductr-chrome/chevron-down.svg").size(12)));
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // What the PR needs next: a colored line and, when Claude can do it, the action that moves it on.
  prStatus(pr, t) {
    const space = spaces().find((s) => s.active)?.id, changes = shared("conductr-source-control.count");
    const uncommitted = changes?.space === space ? changes.files : 0;
    const { failing, pending } = pr.checks;
    if (pr.state === "MERGED") return { text: "Merged", color: MARK.ansi5, icon: "conductr-spaces/pr-merged" };
    if (pr.state === "CLOSED") return { text: "Closed", color: t.muted, icon: "conductr-spaces/pr-closed" };
    if (uncommitted) return { text: plural(uncommitted, "uncommitted change"), color: MARK.ansi3, icon: "conductr-chrome/square-pen", action: ["Commit and push", "Commit and push all changes."] };
    if (pr.mergeable === "CONFLICTING") return { text: "Merge conflicts", color: MARK.ansi1, icon: "conductr-chrome/x", action: ["Fix conflicts", `PR #${pr.number} has merge conflicts with ${pr.base}. Resolve them and push.`] };
    if (failing) return { text: `${plural(failing, "check")} failing`, color: MARK.ansi1, icon: "conductr-chrome/x", action: ["Fix checks", `CI checks are failing on PR #${pr.number}. Find them with \`gh pr checks ${pr.number}\`, fix them, and push.`] };
    if (pending) return { text: `${plural(pending, "check")} pending…`, color: MARK.ansi3, icon: "conductr-chrome/spinner", spin: true };
    if (pr.isDraft) return { text: "Draft", color: t.muted, icon: "conductr-spaces/pr-draft" };
    if (pr.reviewDecision === "CHANGES_REQUESTED") return { text: "Changes requested", color: MARK.ansi1, icon: "conductr-chrome/square-pen" };
    if (pr.reviewDecision === "REVIEW_REQUIRED") return { text: "Waiting for review", color: MARK.ansi4, icon: "conductr-chrome/clock" };
    return { text: "Ready to merge", color: MARK.ansi2, icon: "conductr-chrome/circle-check" };
  }

  // Types text into the tab's Claude when it's idle or done (not `hc send --if idle`: a finished turn
  // is "done" in the core, which --if can't match). hc send itself won't type into a blocked dialog.
  claudeButton(id, label, text, color, t, stop) {
    const { claude } = prContext();
    const busy = claude && claude.status !== "idle" && claude.status !== "done";
    const ready = Boolean(claude && !busy);
    const why = !claude ? "No Claude Code session in this tab" : busy ? "Claude is busy" : `Ask this tab's Claude: ${text}`;
    // Filled with the status color, as Conductor's Merge button is; faded while Claude can't take it.
    return h_flex().id(id).flex_none().h(24).px(9).items_center().rounded(6).text_size(12).font_medium().tooltip(why)
      .bg(ready ? color : mix(t.chrome, color, 0.25)).text_color(ready ? t.background : mix(t.chrome, color, 0.7))
      .when(ready, (el) => el.cursor_pointer().hover((s) => s.bg(mix(color, t.foreground, 0.15))))
      .on_mouse_down("left", stop)
      .on_click(() => ready && sendToClaude(claude, text, label))
      .child(label);
  }

  // The branch's PR as Conductor shows it: its number (opens GitHub), what it needs next, and the action
  // for that. Without a PR: Create PR, which runs the PR skill in a new Claude tab (no wait for a busy
  // Claude or for a draft in the tab's own); its chevron opens the manual way, GitHub's compare page.
  prParts(t, stop, cx) {
    const { branch, cwd, machine } = prContext();
    if (!branch || mainBranches().has(branch)) return null;
    const where = JSON.stringify([machine, cwd, branch]);
    if (where !== this.prWhere) {
      this.prWhere = where;
      ({ pr: this.pr, compare: this.compare } = this.seen.get(where) ?? { pr: null, compare: null });
      this.lookup(where, cx);
    }
    if (this.pr) {
      const pr = this.pr, status = this.prStatus(pr, t);
      const color = status.color;
      const pill = h_flex().id("pr-linked").flex_none().h(24).px(8).gap(6).items_center().rounded(6).border_1().border_color(color + "66")
        .bg(color + "1f").text_size(12).text_color(color).cursor_pointer().hover((s) => s.bg(color + "33")).tooltip("Open the PR on GitHub")
        .on_mouse_down("left", stop)
        .on_click(() => exec("open", [pr.url]))
        .child(`#${pr.number}`)
        .child(svg("mods/conductr-tabs/arrow-up-right.svg").size(12));
      const icon = svg(`mods/${status.icon}.svg`).size(14).flex_none();
      const line = h_flex().min_w(0).gap(6).items_center().text_size(13).font_medium().text_color(status.color)
        .child(status.spin ? icon.spin(900) : icon).child(div().min_w(0).truncate().child(status.text));
      return { lead: [pill, line], tint: status.color, action: status.action && this.claudeButton("pr-action", ...status.action, status.color, t, stop) };
    }
    const space = spaces().find((s) => s.active)?.id;
    return { lead: [h_flex().id("pr").flex_none().h(24).items_center().rounded(6).border_1().border_color(t.border).text_size(12)
      .child(h_flex().id("pr-create").h_full().px(8).gap(6).items_center().rounded_l(6).tooltip("Create the PR in a new Claude tab")
        .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop)
        .on_click(() => run("tab.new", { name: "Create PR", space, folder: cwd, argv: ["claude"], task: prPrompt() }))
        .child(svg("mods/conductr-spaces/pr-open.svg").size(13))
        .child("Create PR"))
      .child(div().w(1).h_full().bg(t.border))
      .child(h_flex().id("pr-more").h_full().px(5).items_center().rounded_r(6).text_color(this.compare ? t.muted : t.dim)
        .when(Boolean(this.compare), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_mouse_down("left", stop)
        .on_click(() => this.compare && openOverlay({ mod: "conductr-menu", kind: "popup", width: 210, props: { tab: "pr", target: { compare: this.compare } } }))
        .child(svg("mods/conductr-chrome/chevron-down.svg").size(12)))], action: null };
  }

  // Review: a new tab in this space with Codex (the chevron offers every installed agent), asked
  // to review against our guidelines file. Claude reads `@file` itself; others get the plain path.
  reviewButton(t, stop) {
    const { cwd, machine } = prContext();
    if (!cwd) return null;
    const args = { name: "Review", space: spaces().find((s) => s.active)?.id, folder: cwd };
    const file = `${appHome()}/mods/conductr-tabs/review.md`;
    const task = `Please review the changes in this workspace: ${file}`;
    const claudeTask = `Please review the changes in this workspace: @${file}`;
    return h_flex().id("review").flex_none().h(24).items_center().rounded(6).border_1().border_color(t.border).text_size(12)
      .child(h_flex().id("review-codex").h_full().px(8).gap(6).items_center().rounded_l(6).text_color(t.foreground)
        .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Review this workspace's changes in a new Codex tab")
        .on_mouse_down("left", stop)
        .on_click(() => run("tab.new", { ...args, argv: ["codex", "--no-daemon"], task }))
        .child(svg("mods/conductr-tabs/eye.svg").size(13))
        .child("Review"))
      .child(div().w(1).h_full().bg(t.border))
      .child(h_flex().id("review-more").h_full().px(5).items_center().rounded_r(6).text_color(t.muted)
        .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click(() => openOverlay({ mod: "conductr-menu", kind: "popup", width: 190, props: { tab: "review", target: { args, task, claudeTask, machine } } }))
        .child(svg("mods/conductr-chrome/chevron-down.svg").size(12)));
  }

  render(cx) {
    const t = theme();
    const space = spaces().find(p => p.active);
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    // Two copies: above the main pane and, with props { side: "panel" }, above the side panel.
    // The tab's actions (Create PR or its PR, Review) and the panel toggle sit at the top right:
    // over the panel while it shows, else at the main pane's right edge.
    const onPanel = props()?.side === "panel";
    const panelShown = Boolean(panel && !panel.hidden);
    if (!onPanel) this.syncPanel(space, panel, body, enabled);
    const firstPanel = ["changes", "files"].find((id) => enabled.includes(id));
    const openPanel = () => {
      run("layout.select", { stack: "panel-body", child: enabled.includes(body?.active) ? body.active : firstPanel });
      run("layout.show", { id: "panel" });
    };
    this.showingPr = onPanel || !panelShown;
    const pr = this.showingPr ? this.prParts(t, stop, cx) : null;
    // Over the main pane (panel closed), the PR sits in a tinted group at the right instead.
    const group = !onPanel && pr?.tint
      ? [h_flex().flex_shrink(1).min_w(0).h(32).pl(4).pr(pr.action ? 4 : 10).gap(8).items_center().rounded(8)
          .bg(mix(t.chrome, pr.tint, 0.12)).children([...pr.lead, pr.action].filter(Boolean))]
      : [...(pr?.lead ?? []), ...(onPanel ? [div().flex_1().min_w(0)] : []), pr?.action].filter(Boolean);
    const actions = h_flex().min_w(0).gap(8).items_center().when(onPanel, el => el.flex_1())
      .children([...group, this.reviewButton(t, stop)].filter(Boolean));
    const controls = h_flex().flex_none().gap(3).items_center()
      .when(Boolean(firstPanel), el => el.child(div().id("panel-toggle").size(24).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(panelShown ? t.foreground : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
        .tooltip(panelShown ? "Hide Files and Source Control" : "Show Files and Source Control")
        .on_mouse_down("left", stop).on_click(() => panelShown ? run("layout.hide", { id: "panel" }) : openPanel())
        .child(svg("mods/conductr-chrome/panel-right.svg").size(15))))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/conductr-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/conductr-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/conductr-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
    // Above the panel, the bar takes a tint of the PR's status color, as Conductor's does.
    const tint = onPanel && pr?.tint;
    const bar = h_flex().size_full().min_w(0).gap(6).items_center().bg(tint ? mix(t.chrome, tint, 0.12) : t.chrome)
      .border_b(1).border_color(tint ? mix(t.border, tint, 0.3) : t.border)
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); });
    if (onPanel) return bar.px(10).child(actions).child(controls);
    // A worktree's folder name, as Conductor names its workspaces; a main checkout's is the repo's.
    const top = shared("conductr-spaces.current")?.git;
    const worktree = top?.linked && top.top && div().flex_none().max_w(200).truncate().text_size(12).text_color(t.dim).child(top.top.split("/").pop());
    // 8px right padding: main-row's margin, so the buttons end at the main pane's right edge.
    return bar.pl(lightsPadding).pr(8)
      // The sidebar's own toggle (conductr-chrome) hides it; this one brings it back.
      // Drawn exactly like conductr-chrome's toggle (26px, muted), so the icon stays put when the sidebar hides.
      .when(Boolean(sidebar?.hidden), el => el.child(div().id("sidebar-show").size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop).on_click(() => run("layout.show", { id: "sidebar" }))
        .child(svg("mods/conductr-chrome/sidebar.svg").size(15))))
      .children([this.crumb(t, stop), div().flex_1(), worktree, this.openButton(t, stop)].filter(Boolean))
      .when(!panelShown, el => el.child(actions).child(controls));
  }
}
