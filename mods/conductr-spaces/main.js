// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Each space's
// tabs are listed under it with their agent's session summary and status. Click to
// fold it, right-click for its menu, drag to reorder.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, terminals, focused, run as herdrRun, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, pickFolder } from "herdr";
import { repoKey } from "./repo-key.js";

const PICK_FOLDER = "conductr-menu.pick-folder";
// The main area's stack: the tab ("main") or conductr-chat's Create screen ("create").
const MAIN_STACK = "main-stack";
const creating = () => find(layout(), MAIN_STACK)?.active === "create";
// Going to a space, tab or pane, or making a space, leaves the Create screen for the tab.
function run(command, args) {
  if (/^(space\.(select|new)|tab\.select|pane\.focus)$/.test(command) && creating()) herdrRun("layout.select", { stack: MAIN_STACK, child: "main" });
  return herdrRun(command, args);
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
// Space, worktree and tab rows share one height; sub-agent rows are a little shorter.
const ROW = 36, SUB_ROW = 30, FONT = 12.5;
const rowHeight = () => ROW;
const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A tab's lead pane (its agent, else its first terminal) and label: a name someone gave it,
// else the agent's session summary (the terminal title behind a status glyph), else its number.
// Shells set a path or user@host as their title, which isn't a summary.
function tabLabel(tab, ps) {
  const lead = ps.find((p) => p.tab === tab.id && p.program?.agent) ?? ps.find((p) => p.tab === tab.id);
  const program = lead?.program;
  const summary = (lead?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();
  const telling = summary && !/^[~/]/.test(summary) && !summary.includes("@") &&
    ![program?.name?.toLowerCase(), program?.key].includes(summary.toLowerCase());
  return { program, name: !tab.named && telling ? summary : tab.name };
}

// A pane's label in a split tab: a mod pane's name; a shell's folder (its title is a path,
// user@host or, at first, its address); else the agent's session summary, else the program's name.
function paneLabel(p) {
  const given = shared("conductr-spaces.pane-names")?.[p.pane];
  if (given) return given;
  // A viewer pane is named after the file it shows.
  const viewed = p.mod === "conductr-viewer" ? shared("conductr-viewer")?.[p.tab]?.file : null;
  if (viewed) return viewed.split("/").pop();
  if (!p.terminal) return p.title || p.mod;
  if (p.program?.shell) return p.cwd ? base(p.cwd) || "/" : "Shell";
  const summary = (p.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();
  const telling = summary && summary !== p.terminal && !/^[~/]/.test(summary) && !summary.includes("@") &&
    ![p.program?.name?.toLowerCase(), p.program?.key].includes(summary.toLowerCase());
  return telling ? summary : (p.program?.name ?? "Terminal");
}

// One tree level: where a worktree's branch icon sits under its repo's space.
const INDENT = 22;
const indentOf = (level) => 8 + level * INDENT;

// Tab ids marked unread from the tab menu (conductr-menu writes it too).
const UNREAD = "conductr-spaces.unread";
const PR_EVERY = 60000;

// The latest run of each check (reruns repeat a name), counted as failing or pending. Graphite's
// mergeability check stays in progress until the PRs below in the stack merge, so a waiting one doesn't count.
function checkCounts(rollup) {
  const latest = new Map();
  for (const run of rollup) {
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

// What a PR needs next, with the same rules and colors as conductr-tabs' PR header (less its
// uncommitted changes, which only the shown space knows). Open PRs without checks yet stay plain.
function prLook(pr, t) {
  if (pr.state === "MERGED") return { icon: "pr-merged", label: "merged", color: MARK.ansi5 };
  if (pr.state === "CLOSED") return { icon: "pr-closed", label: "closed", color: t.muted };
  const icon = pr.isDraft ? "pr-draft" : "pr-open";
  if (!pr.checks) return { icon, label: pr.isDraft ? "draft" : "open", color: pr.isDraft ? t.dim : MARK.ansi2 };
  const { failing, pending } = pr.checks;
  if (pr.mergeable === "CONFLICTING") return { icon, label: "merge conflicts", color: MARK.ansi1 };
  if (failing) return { icon, label: `${failing} failing`, color: MARK.ansi1 };
  if (pending) return { icon, label: `${pending} pending`, color: MARK.ansi3 };
  if (pr.isDraft) return { icon, label: "draft", color: t.dim };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { icon, label: "changes requested", color: MARK.ansi1 };
  if (pr.reviewDecision === "REVIEW_REQUIRED") return { icon, label: "waiting for review", color: MARK.ansi4 };
  return { icon, label: "ready to merge", color: MARK.ansi2 };
}

// "project" (spaces with their tabs) or "status" (one row per space under its status); conductr-menu sets it.
const GROUP = "conductr-spaces.group";
// Space id -> { status, pr }. Set by hand from conductr-menu's Set status; a change of the
// space's PR state moves it.
const STATUS = "conductr-spaces.status";
const STATUSES = [
  { key: "done", label: "Done", color: () => "#c9a48a" },
  { key: "in_review", label: "In review", color: () => MARK.ansi2 },
  { key: "in_progress", label: "In progress", color: (t) => t.ansi3 },
  { key: "backlog", label: "Backlog", color: (t) => t.dim },
  { key: "canceled", label: "Canceled", color: (t) => t.muted },
];
const FROM_PR = { OPEN: "in_review", MERGED: "done", CLOSED: "canceled" }; // no PR or a draft: in progress
// Space ids in the order dragged within their status; spaces not in it follow, in space order.
const STATUS_ORDER = "conductr-spaces.status-order";
const statusOf = (id) => shared(STATUS)?.[id]?.status ?? "in_progress";

// VS Code style indent guides: one line per ancestor level, through the middle of that
// level's icon (a space's 18px avatar, else a 13px icon). Rows touch, so lines join up.
function guides(level, t, first = 0) {
  return Array.from({ length: level }, (_, i) => i).filter((i) => i >= first).map((i) =>
    div().absolute().top(0).bottom(0).w(1).left(i === 0 ? 16.5 : indentOf(i) + 6).bg(t.border));
}

function programIcon(program, t) {
  return program.tint ? svg(program.icon).size(13).flex_none().text_color(t.dim) : image(program.icon).size(13).flex_none();
}

// A row's leading icon: a spinner while its agent works, else the program's icon.
function leadIcon(status, program, t) {
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.working).spin(900);
  return program?.icon ? programIcon(program, t) : div().w(13).flex_none();
}


// A row's selected or hover background, inset so rows show a gap between them while the
// rows themselves still touch (the guide lines stay unbroken). Added as a row's first child.
const GAP = 3;
function highlight(color) {
  return div().absolute().top(GAP).bottom(GAP).left(0).right(0).rounded(7).bg(color);
}

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.askedAt = shared(PICK_FOLDER)?.at; // the last Open project already answered
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.foldedStatuses = new Set(JSON.parse(localStorage.getItem("status.folded") ?? "[]"));
    // Spaces folded in either view (their tabs hidden, and a main checkout's worktrees in the project
    // view) and split tabs folded (their panes hidden), by id.
    this.foldedSpaces = new Set(JSON.parse(localStorage.getItem("spaces.folded") ?? "[]"));
    this.prs = {}; // repo -> branch -> { number, state, isDraft, url }: your PRs, newest per branch
    this.prAt = 0; // when PRs were last asked for
    this.prRepos = ""; // the repos asked for then
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Refresh only when the refs could have changed (see `due`). Behind other windows, every 2 s.
    this.ticked = 0;
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    if (!window()?.active && now - this.ticked < 2000) return;
    this.ticked = now;
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const ps = panes();
    const due = this.due(now, sp, ps);
    if (due.size) this.refreshGit(due, cx);
    this.duePrs(now, sp, ps, cx);
    this.syncStatus(sp, ps);
    this.shareCurrent(sp, ps);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // The shown space for conductr-tabs' header: its avatar's space (a worktree shows its main
  // checkout's, as in the status view) and its git info, null outside a repo.
  shareCurrent(sp, ps) {
    const space = sp.find((s) => s.active);
    const g = space && this.git[where(space, ps)];
    const owner = g?.linked && sp.find((s) => { const o = this.git[where(s, ps)]; return o && !o.linked && o.repo === g.repo; });
    const current = space ? { space: space.id, name: space.name, avatar: { id: (owner || space).id, name: (owner || space).name }, git: g ?? null } : null;
    const text = JSON.stringify(current);
    if (text === this.shared) return;
    this.shared = text;
    setShared("conductr-spaces.current", current);
  }

  // Your PRs, one `gh pr list` per repo a space is in: when that set of repos
  // changes, else every PR_EVERY while the window is in front, or sooner when nudged.
  duePrs(now, sp, ps, cx) {
    // Coming back to the window or going to another space asks again, at most every 5 seconds.
    const active = Boolean(window()?.active), space = sp.find((s) => s.active)?.id;
    if ((active && !this.wasActive) || space !== this.prSpace) this.prNudged = true;
    this.wasActive = active;
    this.prSpace = space;
    if (this.prBusy) return;
    const repos = {};
    for (const s of sp) {
      const g = this.git[where(s, ps)];
      if (g) repos[g.repo] ??= { cwd: place(s, ps), on: s.machine };
    }
    const key = JSON.stringify(Object.keys(repos).sort());
    if (key === this.prRepos && !(active && now - this.prAt > (this.prNudged ? 5000 : PR_EVERY))) return;
    this.prNudged = false;
    this.prRepos = key;
    this.prAt = now;
    this.prBusy = true;
    cx.spawn(async (cx) => {
      await Promise.all(Object.entries(repos).map(async ([repo, { cwd, on }]) => {
        try {
          // Checks only for open PRs: a rollup per merged PR would make the list far heavier.
          const [r, open] = await Promise.all([
            exec("gh", ["pr", "list", "--state", "all", "--author", "@me", "--limit", "100", "--json", "number,headRefName,state,isDraft,url"], { cwd, on, timeout: 20000 }),
            exec("gh", ["pr", "list", "--state", "open", "--author", "@me", "--limit", "50", "--json", "number,mergeable,reviewDecision,statusCheckRollup"], { cwd, on, timeout: 20000 }).catch(() => null),
          ]);
          if (r.code !== 0) return;
          const details = {};
          if (open?.code === 0) for (const pr of JSON.parse(open.stdout)) details[pr.number] = { mergeable: pr.mergeable, reviewDecision: pr.reviewDecision, checks: checkCounts(pr.statusCheckRollup ?? []) };
          const byBranch = {};
          for (const pr of JSON.parse(r.stdout)) byBranch[pr.headRefName] ??= { ...pr, ...details[pr.number] };
          this.prs[repo] = byBranch;
        } catch {} // gh missing, logged out or the machine away: keep what it showed.
      }));
      this.prBusy = false;
      cx.notify();
    });
  }

  // A worktree's icon: its PR's state, else a plain branch.
  // In a 21px box either way, so names line up; a PR's box gets a border in its state's color.
  treeIcon(w, g, t) {
    const pr = g && this.prs[g.repo]?.[g.branch];
    const look = pr && prLook(pr, t);
    const box = h_flex().size(21).flex_none().items_center().justify_center();
    if (!look) return box.child(svg("mods/conductr-spaces/branch.svg").size(15).text_color(t.foreground));
    return box.id(`pr-${w.id}`).rounded(6).border_1().border_color(look.color + "66").tooltip(`#${pr.number} · ${look.label}`)
      .child(svg(`mods/conductr-spaces/${look.icon}.svg`).size(15).text_color(look.color));
  }

  // A space's PR state: OPEN, DRAFT, MERGED, CLOSED or NONE; undefined until git and gh have answered.
  prState(w, ps) {
    const k = where(w, ps);
    if (!(k in this.git)) return undefined;
    const g = this.git[k];
    if (!g) return "NONE";
    const pr = this.prs[g.repo]?.[g.branch];
    if (!this.prs[g.repo]) return undefined;
    return !pr ? "NONE" : pr.state === "OPEN" && pr.isDraft ? "DRAFT" : pr.state;
  }

  // Moves a space's status only when its PR state changes, so one set by hand
  // stays until then. Entries of spaces that are gone stay: a machine still loading has none yet.
  syncStatus(sp, ps) {
    const all = shared(STATUS) ?? {};
    const next = { ...all };
    let changed = false;
    for (const w of sp) {
      const pr = this.prState(w, ps);
      let e = all[w.id] ?? { status: FROM_PR[pr] ?? "in_progress", pr };
      if (pr !== undefined && e.pr !== pr) e = { ...e, pr, status: FROM_PR[pr] ?? "in_progress" };
      if (e !== all[w.id]) { next[w.id] = e; changed = true; }
    }
    if (changed) setShared(STATUS, next);
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        await Promise.all(keys.map((key) => this.check(key, cx)));
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await Promise.all([
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      ]);
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await Promise.all([
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      ]);
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { name, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: repoKey(on, repo), linked: repo !== `${top}/.git`, top };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = repoKey(null, repo);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    // Flyout: room on the right for Set status's submenu.
    openOverlay({ mod: "conductr-menu", kind: "popup", frame: "none", width: 400, height: 380, props: { tab: "space", target: { id: w.id }, flyout: true } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    if (!collapsed && shared(GROUP) === "status") return this.byStatus(t);
    const listed = this.ordered();
    const isMain = (r) => r.g && !r.g.linked;
    const worktrees = (r) => (isMain(r) ? listed.filter((k) => k.tree && k.g.repo === r.g.repo).length : 0);
    const foldedRepos = new Set(listed.filter((r) => isMain(r) && this.foldedSpaces.has(r.w.id)).map((r) => r.g.repo));
    const rows = listed.filter((r) => !(r.tree && foldedRepos.has(r.g.repo)));
    const ps = panes(), all = terminals();
    const draw = (r) => (collapsed ? [this.compact(r, t)] : [
      this.row({ ...r, count: (r.w.tabs?.length ?? 0) + worktrees(r) }, t),
      ...(this.foldedSpaces.has(r.w.id) ? [] : (r.w.tabs ?? []).flatMap((c) => this.tabRows(r, c, ps, all, t))),
    ]);
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.flatMap(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) return [head];
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      return [cell(head), ...guidance, ...(folded ? [] : mine.length ? mine.flatMap(draw) : [loading(m) ? loadingRow(m) : cell(empty)])];
    });
  }

  // A space's avatar: its repo's icon from conductr-settings, else its first letter on its stable color.
  avatar(w, t, g) {
    const color = (shared("space.colors") ?? {})[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    const box = h_flex().size(18).flex_none().rounded(5).items_center().justify_center();
    const icon = g && shared("conductr-settings.icons")?.[g.repo];
    if (icon?.kind === "image") return box.child(image(`mods/conductr-settings/.images/${icon.value}`).size(18).rounded(5));
    if (icon?.kind === "emoji") return box.text_size(13).child(icon.value);
    if (icon?.kind === "icon") return box.bg(fill).text_color("#ffffff").child(svg(`mods/conductr-settings/lucide/${icon.value}.svg`).size(12));
    return box.bg(fill).text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?");
  }

  // Every space as one row under its status, with its tabs as in the project view; empty
  // statuses too. A worktree shows its repo's avatar; a main checkout is named after its branch.
  // A status folds on a click on its header (remembered here) and then shows its count.
  byStatus(t) {
    const rows = this.ordered();
    const owner = (r) => (r.g?.linked && rows.find((m) => m.g && !m.g.linked && m.g.repo === r.g.repo)?.w) || r.w;
    const order = shared(STATUS_ORDER) ?? [];
    const rank = (id) => { const at = order.indexOf(id); return at === -1 ? Infinity : at; };
    // Ties (both not dragged yet) keep space order.
    const sorted = rows.map((r, n) => [r, rank(r.w.id), n]).sort((a, b) => (a[1] - b[1]) || (a[2] - b[2])).map(([r]) => r);
    const ids = sorted.map((r) => r.w.id);
    const ps = panes(), all = terminals();
    return STATUSES.flatMap((s) => {
      const mine = sorted.filter((r) => statusOf(r.w.id) === s.key);
      const group = mine.map((r) => r.w.id);
      const folded = this.foldedStatuses.has(s.key);
      const id = `status-head-${s.key}`, hovered = this.hovered === id;
      const head = h_flex().relative().id(id).h(ROW).flex_none().px(8).gap(9).items_center()
        .text_size(FONT).font_semibold().text_color(t.foreground)
        .on_hover((hovered, cx) => this.hover(id, hovered, cx))
        .when(hovered, (el) => el.child(highlight(t.hover)))
        .on_click((_e, cx) => {
          folded ? this.foldedStatuses.delete(s.key) : this.foldedStatuses.add(s.key);
          localStorage.setItem("status.folded", JSON.stringify([...this.foldedStatuses]));
          cx.notify();
        })
        .child(svg(`mods/conductr-spaces/status-${s.key}.svg`).size(15).flex_none().text_color(s.color(t)))
        .child(s.label)
        .when(folded && mine.length > 0, (el) => el.child(div().font_normal().text_size(11.5).text_color(t.muted).child(String(mine.length))))
        .when(hovered, (el) => el.child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.muted)));
      if (folded) return [head];
      return [head, ...mine.flatMap((r) => [
        this.statusRow(r, owner(r), group, ids, t),
        // Tabs one level under the row, with guides from the row's avatar down (none under headers).
        ...(this.foldedSpaces.has(r.w.id) ? [] : (r.w.tabs ?? []).flatMap((c) => this.tabRows({ ...r, tree: "status", first: 1 }, c, ps, all, t))),
      ])];
    });
  }

  // Dropped on another row of its status: before it when dragged up, after it when dragged down.
  moveInStatus(drag, target, ids) {
    const order = ids.filter((id) => id !== drag);
    order.splice(order.indexOf(target) + (ids.indexOf(drag) < ids.indexOf(target) ? 1 : 0), 0, drag);
    const gone = (shared(STATUS_ORDER) ?? []).filter((id) => !ids.includes(id));
    setShared(STATUS_ORDER, [...order, ...gone]);
  }

  // `group`: the ids in its status, in order; `ids`: every row's, in order.
  statusRow({ w, g }, owner, group, ids, t) {
    const id = `status-${w.id}`;
    const at = group.indexOf(w.id), from = this.dragRow ? group.indexOf(this.dragRow) : -1;
    return h_flex()
      .relative()
      .id(id)
      .h(ROW)
      .flex_none()
      // The avatar's middle on the level-1 guide its tabs draw.
      .pl(indentOf(1) - 2)
      .pr(8)
      .gap(7)
      .items_center()
      .text_size(FONT)
      .text_color(t.muted)
      .on_hover((hovered, cx) => this.hover(id, hovered, cx))
      .when(this.hovered === id, (el) => el.child(highlight(t.hover)))
      .when(this.dragRow === w.id && this.overRow !== w.id, (el) => el.opacity(0.5))
      .when(from !== -1 && this.overRow === w.id && from !== at, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(from < at, (line) => line.bottom(0))
          .when(from > at, (line) => line.top(0))))
      .on_mouse_down("left", () => { this.dragRow = w.id; this.overRow = w.id; })
      .on_mouse_move((_e, cx) => {
        // Only within its status: another status's rows aren't drop targets.
        const over = this.dragRow && group.includes(this.dragRow) ? w.id : null;
        if (this.dragRow && this.overRow !== over) { this.overRow = over; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const drag = this.dragRow, over = this.overRow;
        this.dragRow = null; this.overRow = null;
        if (drag && over === w.id && drag !== w.id) this.moveInStatus(drag, w.id, ids);
        else if (drag === w.id) this.toggleFold(w.id);
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(this.avatar(owner, t, g))
      .child(g ? this.treeIcon(w, g, t) : div().w(21).flex_none())
      // A main checkout's name in italics: rows of worktrees and checkouts look alike here.
      // Herdr's Geist has no italic face (nothing slants it), so the system font's.
      .child(div().min_w(0).truncate().when(Boolean(g && !g.linked), (el) => el.font_family(".SystemUIFont").italic()).child(w.name))
      .child(this.foldControl(w, w.tabs?.length ?? 0, this.hovered === id, t))
      .child(div().flex_1());
  }

  toggleFold(id) {
    this.foldedSpaces.has(id) ? this.foldedSpaces.delete(id) : this.foldedSpaces.add(id);
    localStorage.setItem("spaces.folded", JSON.stringify([...this.foldedSpaces]));
  }

  // A space row's fold state, after its name: its chevron while hovered, the hidden rows' count while folded.
  foldControl(w, count, hovered, t) {
    const folded = this.foldedSpaces.has(w.id);
    return h_flex().flex_none().gap(4).items_center().text_size(11.5).text_color(t.muted)
      .when(folded && count > 0, (el) => el.child(String(count)))
      .when(hovered && count > 0, (el) => el.child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
  }

  row({ w, i, g, tree, count }, t) {
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree })).text_size(FONT)
      .flex_none()
      .justify_center()
      .on_hover((hovered, cx) => this.hover(`space-${w.id}`, hovered, cx))
      .when(this.hovered === `space-${w.id}`, (el) => el.child(highlight(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) this.toggleFold(w.id);
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .children(guides(tree ? 1 : 0, t))
      .child(
        h_flex()
          .gap(tree ? 5 : 9)
          .items_center()
          // The 21px tree icon box keeps its middle on the indent guide, names where they were.
          .when(Boolean(tree), el => el.pl(18).child(this.treeIcon(w, g, t)))
          .when(!tree, el => el.child(this.avatar(w, t, g)))
          .child(div().min_w(0).truncate().text_color(t.muted).child(w.name))
          .child(this.foldControl(w, count ?? 0, this.hovered === `space-${w.id}`, t))
          .child(div().flex_1()),
      );
  }

  // Which row the pointer is on: rows draw their own inset highlight (see highlight()).
  hover(id, hovered, cx) {
    if (hovered) this.hovered = id;
    else if (this.hovered === id) this.hovered = null;
    cx.notify();
  }

  // A tab under its space, then its agents' live sub-agents one level deeper each. A split tab
  // is a row of its own with one row per pane under it, each pane's sub-agents under that.
  // Every level indents by INDENT, starting where a worktree's branch icon sits.
  tabRows(r, c, ps, all, t) {
    const level = r.tree ? 2 : 1, first = r.first ?? 0;
    const mine = ps.filter((p) => p.tab === c.id);
    const subs = (parent, depth) => all.filter((k) => k.parent === parent && k.state === "live")
      .flatMap((k) => [this.subRow(k, depth, ps, t, first), ...subs(k.address, depth + 1)]);
    // A conductr-chat tab is one chat over its hidden backend terminal: one row, not a split.
    if (mine.length < 2 || mine.some((p) => p.mod === "conductr-chat")) return [this.tabRow(r, c, ps, level, t), ...mine.filter((p) => p.terminal).flatMap((p) => subs(p.terminal, level + 1))];
    if (this.foldedSpaces.has(c.id)) return [this.tabRow(r, c, ps, level, t, mine.length)];
    return [this.tabRow(r, c, ps, level, t, mine.length), ...mine.flatMap((p) => [
      this.paneRow(r, c, p, level + 1, t),
      ...(p.terminal ? subs(p.terminal, level + 2) : []),
    ])];
  }

  // A pane of a split tab: a click goes to it.
  paneRow({ w, first }, c, p, level, t) {
    const id = `pane-${p.pane}`;
    const on = w.active && c.active && p.focused && !creating();
    // Unread: its agent finished while you weren't looking, or you marked it (pane ids share UNREAD).
    const unread = p.status === "done" || (shared(UNREAD) ?? []).includes(p.pane);
    return h_flex()
      .relative()
      .id(id)
      .h(ROW)
      .flex_none()
      .pl(indentOf(level))
      .pr(8)
      .gap(7)
      .items_center()
      .text_size(FONT)
      .text_color(p.status === "blocked" ? t.blocked : unread ? t.foreground : t.muted)
      .when(unread, (el) => el.font_bold())
      .on_hover((hovered, cx) => this.hover(id, hovered, cx))
      .when(on || this.hovered === id, (el) => el.child(highlight(on ? t.selected : t.hover)))
      .children(guides(level, t, first))
      .on_click(() => {
        if (!w.active) run("space.select", { id: w.id });
        if (!c.active) run("tab.select", { id: c.id });
        run("pane.focus", { pane: p.pane });
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "conductr-menu", kind: "popup", width: 200, props: { tab: "split-pane", target: { pane: p.pane, name: paneLabel(p), agent: Boolean(p.program?.agent) } } });
      })
      .child(leadIcon(p.status, p.program, t))
      .child(div().flex_1().min_w(0).truncate().child(p.zoomed ? `${paneLabel(p)} Z` : paneLabel(p)));
  }

  // `split`: a split tab's pane count; its row sits above the panes, which carry the focus
  // highlight and their own labels, and a click on it folds them like a space row.
  tabRow({ w, first }, c, ps, level, t, split = 0) {
    const label = tabLabel(c, ps);
    const program = split ? null : label.program;
    const name = split ? (c.named ? c.name : "Split view") : label.name;
    const on = w.active && c.active && !split && !creating();
    // Unread: an agent finished while you weren't looking ("done"), or you marked it unread.
    const marked = shared(UNREAD) ?? [];
    const unread = c.status === "done" || marked.includes(c.id) || (split > 0 && ps.some((p) => p.tab === c.id && marked.includes(p.pane)));
    const order = w.tabs.map((x) => x.id);
    const from = this.dragTab?.space === w.id ? order.indexOf(this.dragTab.id) : -1;
    const at = order.indexOf(c.id);
    return h_flex()
      .relative()
      .id(`tab-${c.id}`)
      .h(ROW)
      .flex_none()
      .pl(indentOf(level))
      .pr(8)
      .gap(7)
      .items_center()
      .rounded(7)
      .text_size(FONT)
      // Blocked (an agent waits for you) turns the text red; unread makes it bold.
      .text_color(c.status === "blocked" ? t.blocked : unread ? t.foreground : t.muted)
      .when(unread, (el) => el.font_bold())
      .on_hover((hovered, cx) => this.hover(`tab-${c.id}`, hovered, cx))
      .when(on || this.hovered === `tab-${c.id}`, (el) => el.child(highlight(on ? t.selected : t.hover)))
      .children(guides(level, t, first))
      .when(this.dragTab?.id === c.id && this.overTab !== c.id, (el) => el.opacity(0.5))
      .when(from !== -1 && this.overTab === c.id && from !== at, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(from < at, (line) => line.bottom(0))
          .when(from > at, (line) => line.top(0))))
      .on_mouse_down("left", () => {
        this.dragTab = { id: c.id, space: w.id };
        this.overTab = c.id;
      })
      .on_mouse_move((_e, cx) => {
        const over = this.dragTab?.space === w.id ? c.id : null;
        if (this.dragTab && this.overTab !== over) { this.overTab = over; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const drag = this.dragTab, over = this.overTab;
        this.dragTab = null; this.overTab = null;
        if (drag && over === c.id && drag.id !== c.id) run("tab.move", { id: drag.id, index: at + 1 });
        else if (drag?.id === c.id && split) this.toggleFold(c.id);
        else if (drag?.id === c.id) {
          if (!w.active) run("space.select", { id: w.id });
          run("tab.select", { id: c.id });
        }
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "conductr-menu", kind: "popup", width: 200, props: { tab: split ? "split" : "tab", target: { id: c.id, space: w.id, agent: ps.some((p) => p.tab === c.id && p.program?.agent) } } });
      })
      .child(split ? svg("mods/workspace-chrome/panel-right.svg").size(13).flex_none().text_color(t.dim) : leadIcon(c.status, program, t))
      .when(!split, (el) => el.child(div().flex_1().min_w(0).truncate()
        .child(c.zoomed && !ps.some((p) => p.tab === c.id && p.mod === "conductr-chat") ? `${name} Z` : name)))
      .when(Boolean(split), (el) => el.child(div().flex_shrink(1).min_w(0).truncate().child(name))
        .child(this.foldControl(c, split, this.hovered === `tab-${c.id}`, t))
        .child(div().flex_1()));
  }

  // A sub-agent: a kept one (with a pane) gets focus, else a peek over the tab.
  subRow(k, level, ps, t, first = 0) {
    const pane = ps.find((p) => p.terminal === k.address);
    // Without a pane its status is the core's raw word; it reports to its parent, so never "done".
    const raw = pane?.status ?? k.status;
    const status = raw === "error" ? "blocked" : raw === "done" ? "idle" : raw;
    return h_flex()
      .relative()
      .id(`sub-${k.address}`)
      .h(SUB_ROW)
      .flex_none()
      .pl(indentOf(level))
      .pr(8)
      .gap(7)
      .items_center()
      .rounded(7)
      .text_size(FONT)
      .text_color(status === "blocked" ? t.blocked : t.muted)
      .on_hover((hovered, cx) => this.hover(`sub-${k.address}`, hovered, cx))
      .when(this.hovered === `sub-${k.address}`, (el) => el.child(highlight(t.hover)))
      .children(guides(level, t, first))
      .on_click(() => (pane ? run("pane.focus", { terminal: k.address }) : run("terminal.peek", { terminal: k.address })))
      .child(leadIcon(status, k.program, t))
      .child(div().flex_1().min_w(0).truncate().child(k.name || k.template || k.program?.name || k.address));
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  // Add space's Open project (conductr-menu): the menu closes under the system's folder picker, so
  // the picker runs here. With `pick` the folder goes to the Create screen instead of a new space.
  pickFolder(cx) {
    const ask = shared(PICK_FOLDER);
    if (!ask || ask.at === this.askedAt) return;
    this.askedAt = ask.at;
    cx.spawn(async () => {
      const folder = await pickFolder({ prompt: "Select project directory" });
      if (!folder) return;
      if (ask.pick) setShared("conductr-create.add", { folder, at: Date.now() });
      else run("space.new", { folder, machine: "" });
    });
  }

  render(cx) {
    this.pickFolder(cx);
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    // Going to a tab reads it. Only on arrival, so marking the shown tab unread sticks until you come back.
    const shownTab = sp.find((s) => s.active)?.tabs.find((c) => c.active)?.id;
    if (shownTab !== this.shownTab) {
      this.shownTab = shownTab;
      const marked = shared(UNREAD) ?? [];
      if (marked.includes(shownTab)) setShared(UNREAD, marked.filter((id) => id !== shownTab));
    }
    // Likewise a pane marked unread, on going to it.
    const shownPane = focused()?.pane ?? null;
    if (shownPane !== this.shownPane) {
      this.shownPane = shownPane;
      const marked = shared(UNREAD) ?? [];
      if (marked.includes(shownPane)) setShared(UNREAD, marked.filter((id) => id !== shownPane));
    }
    const create = creating();
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().id("create").h(32).mx(8).mt(6).mb(4).px(8).gap(10).items_center().rounded(7)
        .text_color(create ? t.foreground : t.muted)
        .when(create, el => el.bg(t.selected))
        .when(!create, el => el.hover(s => s.bg(t.hover).text_color(t.foreground)))
        .when(collapsed, el => el.mx(0).px(0).justify_center())
        .on_click(() => { setShared("conductr-create.opened", Date.now()); herdrRun("layout.select", { stack: MAIN_STACK, child: "create" }); })
        .child(svg("mods/workspace-chrome/plus.svg").size(14))
        .when(!collapsed, el => el.child("Create")))
      .child(div().h(1).flex_none().mt(4).mb(6).bg(t.border))
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child(div().flex_1().child("My Spaces"))
          .child(div().id("space-view").size(26).flex_none().flex().items_center().justify_center().rounded(6).text_size(14).hover(s => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Group by")
            .on_click(() => openOverlay({ mod: "conductr-menu", kind: "popup", frame: "none", width: 520, height: 440, props: { tab: "spaces", flyout: true } }))
            .child("⋯"))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.dragTab = null; this.overTab = null; this.dragRow = null; this.overRow = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
