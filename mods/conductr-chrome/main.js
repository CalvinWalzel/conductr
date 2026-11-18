// The sidebar's top bar: sidebar toggle and search after the window buttons, and on the
// right how much memory Herdr and everything running in it use. With props { footer: true },
// the sidebar's footer instead.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, layout, exec, updates, nextCommand, openOverlay, panes, focused, appHome, notify } from "herdr";

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

// On macOS the window buttons sit at the top left, over this bar.
const besideLights = () => window()?.platform === "macos" && !window()?.fullscreen;

// Hides the sidebar; conductr-tabs shows the same button to bring it back (cmd-b toggles it too).
const toggleSidebar = () => run("layout.toggle", { id: "sidebar" });

// Herdr's own processes: the app window and the herdr-core servers. Not the old `herdr` TUI.
const ROOTS = new Set(["Herdr", "herdr-core"]);
const MEMORY_EVERY = 10000;

// Prints each pid's phys_footprint (what Activity Monitor shows): field 9 of rusage_info_v6.
// ps has no footprint column and `top -l 1` costs ~0.8 s of CPU per sample.
const FOOTPRINT = `import ctypes, sys
libc = ctypes.CDLL("/usr/lib/libSystem.dylib")
info = (ctypes.c_uint64 * 64)()
print(sum(info[9] for pid in sys.argv[1:] if libc.proc_pid_rusage(int(pid), 6, info) == 0))`;

// Memory footprint (KB) of Herdr's processes and all their descendants: every shell,
// agent and program running in it. This computer only.
async function memory() {
  const r = await exec("ps", ["-axo", "pid=,ppid=,rss=,comm="]);
  if (r.code !== 0) return null;
  const rows = r.stdout.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, rss, comm]) => ({ pid, ppid, rss: Number(rss), name: comm.split("/").pop() }));
  const children = new Map();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const counted = new Set();
  const visit = (row) => {
    if (counted.has(row.pid)) return;
    counted.add(row.pid);
    for (const child of children.get(row.pid) ?? []) visit(child);
  };
  rows.filter((row) => ROOTS.has(row.name)).forEach(visit);
  const footprint = await exec("/usr/bin/python3", ["-I", "-c", FOOTPRINT, ...counted]);
  return footprint.code === 0 ? Number(footprint.stdout.trim()) / 1024 : null;
}

const format = (kb) => kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(2)} GB` : `${Math.round(kb / 1024)} MB`;

// After herdr-core starts fresh (a reboot, a crash), Herdr reopens each terminal as a shell in its
// last folder and never reruns what ran there. Terminal labels survive, so once per core start we
// put back what they name: a chat backend (conductr.chat, set by conductr-chat/run.sh) or a Claude Code
// or Codex session (agent.session=<agent>:<id>, set by session-label.sh). Only terminals that show a
// bare shell are touched. Chats come back at once. A session comes back when its tab shows, so the
// ones nobody opens use no memory; "conductr-chrome.restore" brings all of them back by hand.
const RESTORED = "conductr-chrome.restored-core";
const quote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
// When each terminal's session last resumed: the shell still shows for a moment after the command is sent.
const resumed = new Map();
const RESUMING = 5000;

async function coreStart() {
  const r = await exec("ps", ["-axo", "lstart=,comm="]);
  const line = r.stdout.split("\n").find((row) => row.endsWith("/Herdr Core.app/Contents/MacOS/herdr-core"));
  return line?.match(/^\s*(\w{3} \w{3} +\d+ [\d:]+ \d{4})/)?.[1] ?? null;
}

// Labels come from `hc get`: terminals() and `hc ls` leave them out.
// `tab`: sessions in that tab only (null: none; left out: all). `chats: false`: sessions only.
// `only`: these terminals, which sessions.sh just stopped; the app may still show their old program.
async function restore({ tab, chats = true, only } = {}) {
  for (const pane of panes()) {
    if (!pane.terminal || pane.terminal.includes("/")) continue;
    if (only ? !only.includes(pane.terminal) : !pane.program?.shell) continue;
    const got = await exec("hc", ["get", pane.terminal, "--json"]).catch(() => null);
    const info = got?.code === 0 ? JSON.parse(got.stdout) : {};
    // The terminal's own shell is in front: nothing runs in it now.
    if (!info.pid || info.foreground?.pid !== info.pid) continue;
    const [agent, session] = (info.labels?.["agent.session"] ?? "").split(/:(.*)/);
    const chat = info.labels?.["conductr.chat"] ?? info.labels?.["calvin.chat"];
    if (chat) {
      if (chats) await exec("hc", ["send", pane.terminal, `sh ${quote(`${appHome()}/mods/conductr-chat/run.sh`)} ${quote(chat)}`]);
      continue;
    }
    const command = agent === "claude" ? `claude --resume ${session}` : agent === "codex" ? `codex resume ${session}` : null;
    if (!command || !/^[\w-]+$/.test(session) || !(tab === undefined || pane.tab === tab)) continue;
    if (Date.now() - (resumed.get(pane.terminal) ?? 0) < RESUMING) continue;
    resumed.set(pane.terminal, Date.now());
    used.set(pane.terminal, Date.now());
    // Typed as keys: `hc send` holds its text for up to a minute after the person's last key there,
    // then pastes it into whatever runs in the terminal by then. ctrl+c clears a half-typed line.
    await exec("hc", ["keys", pane.terminal, "ctrl+c", ...[...command].map((char) => (char === " " ? "space" : char)), "enter"]);
  }
}

// A Claude Code session nobody used for a while stops, to free its memory (sessions.sh), and restore
// resumes it when its tab shows. In use: its tab shows, or it works, waits for an answer or finished
// unseen. The time counts from this app's start, since Claude's transcript files also change while a
// session sits idle.
const HIBERNATE_EVERY = 5 * 60 * 1000;
const BUSY = ["working", "blocked", "done"];
const used = new Map();
const sessions = (...args) => exec("sh", [`${appHome()}/mods/conductr-chrome/sessions.sh`, ...args], { timeout: 120000 }).catch(() => null);

function noteUse() {
  const shown = focused()?.tab;
  for (const pane of panes()) {
    if (pane.terminal && (!used.has(pane.terminal) || pane.tab === shown || BUSY.includes(pane.status))) used.set(pane.terminal, Date.now());
  }
}

// `now`: every session that is not in use, however recently it was.
async function hibernate(now = false) {
  const minutes = Number(shared("conductr-settings.hibernate-minutes") ?? 30);
  const shown = focused()?.tab;
  if (!shown || (!now && !(minutes > 0))) return;
  noteUse();
  const idle = panes().filter((pane) => pane.terminal && !pane.terminal.includes("/") && !pane.program?.shell && pane.tab !== shown
    && !BUSY.includes(pane.status) && (now || Date.now() - used.get(pane.terminal) > minutes * 60000))
    .map((pane) => pane.terminal);
  if (idle.length) await sessions("hibernate", ...idle);
}

// Right-click Hibernate (conductr-menu) names its terminals in PICKED. A session that would lose a
// draft or a background command stops only after the person confirms.
const PICKED = "conductr-chrome.hibernate-picked";
let unsaved = [];
async function hibernatePicked(force) {
  const picked = force ? unsaved : (shared(PICKED) ?? []);
  if (!picked.length) return;
  const result = await sessions("hibernate", ...(force ? ["-f"] : []), ...picked);
  unsaved = force ? [] : [...(result?.stderr ?? "").matchAll(/^unsaved (.+)$/gm)].map((match) => match[1]);
  if (unsaved.length) openOverlay({ mod: "conductr-confirm", kind: "dialog", width: 540, height: 190, props: { title: "Hibernate and lose the draft?", action: "Hibernate", danger: true,
    detail: `${count(unsaved.length)} ${unsaved.length === 1 ? "has" : "have"} an unsent draft or a running background command. Hibernation loses both.`,
    command: { name: "conductr-chrome.hibernate-unsaved" } } });
}

// Claude Code updates itself, but a running session keeps its old version until it restarts.
// { count } while sessions run an older Claude Code than is installed; the footer shows a button
// that restarts the ones that are not busy.
const CLAUDE_UPDATE = "conductr-chrome.claude-update";
const count = (n) => `${n} ${n === 1 ? "session" : "sessions"}`;

async function checkClaude() {
  const outdated = (await sessions("outdated"))?.stdout.split("\n").filter(Boolean).length ?? 0;
  if (outdated !== (shared(CLAUDE_UPDATE)?.count ?? 0)) setShared(CLAUDE_UPDATE, outdated ? { count: outdated } : null);
}

async function updateClaude() {
  const restarted = (await sessions("update"))?.stdout.split("\n").filter(Boolean) ?? [];
  await restore({ chats: false, only: restarted });
  await checkClaude();
  const busy = shared(CLAUDE_UPDATE)?.count;
  notify({ title: restarted.length ? `Restarted ${count(restarted.length)} on the new Claude Code` : "No session restarted",
    body: busy ? `${count(busy)} still busy. Click again when they are idle.` : undefined, level: restarted.length ? "success" : "warning" });
}

// ponytail: one-time copy of shared state from the calvin-* names; drop once no machine has them.
const OLD_KEYS = ["chat.claude", "chrome.restored-core", "clone.repos", "create.add", "create.last", "create.opened", "create.repo",
  "files.clipboard", "menu.agents", "menu.pick-folder", "settings.icons", "settings.main-branches", "settings.scripts",
  "spaces.group", "spaces.pane-names", "spaces.status", "spaces.status-order", "spaces.unread", "tabs.open-app", "worktree.done"];
function migrateShared() {
  for (const key of OLD_KEYS) {
    const old = shared(`calvin-${key}`);
    if (old != null && shared(`conductr-${key}`) == null) setShared(`conductr-${key}`, old);
  }
}

// Conductr's own repo: install.sh keeps its git data here and checks its files out into Herdr's folder.
const conductr = (...args) => exec("sh", ["-c", 'git --git-dir="${CONDUCTR_GIT_DIR:-$HOME/.local/share/conductr.git}" "$@"', "x", ...args])
  .catch(() => ({ code: 1, stdout: "", stderr: "" }));
const UPDATE_EVERY = 3600 * 1000;
// Releases are tags (v0.2.0), each with its notes in changelog/0.2.0.md: markdown, and images as
// lines of their own, ![alt](media/x.png), relative to changelog/. While newer releases exist than
// this checkout's: { from, to, notes: [{ version, date, blocks }] }, newest first, where a block is
// { text } (markdown) or { image, width, height } (a path under Herdr's folder). The footer shows a button.
const UPDATE = "conductr-chrome.update";
const IMAGE_LINE = /^\s*!\[[^\]]*\]\(([^)\s]+)\)\s*$/;
const MEDIA = "data/conductr-chrome/releases";

// The image is still only in git: copy it out of the release, and measure it.
async function releaseImage(tag, src) {
  const path = `${MEDIA}/${tag}/${src}`;
  const r = await exec("sh", ["-c", '{ test -s "$2" || { mkdir -p "$(dirname "$2")" && git --git-dir="${CONDUCTR_GIT_DIR:-$HOME/.local/share/conductr.git}" show "$1" > "$2"; }; } && sips -g pixelWidth -g pixelHeight "$2"',
    "x", `${tag}:changelog/${src}`, `${appHome()}/${path}`]).catch(() => null);
  const [width, height] = ["pixelWidth", "pixelHeight"].map((key) => Number(r?.stdout.match(new RegExp(`${key}: (\\d+)`))?.[1]));
  return r?.code === 0 && width && height ? { image: path, width, height } : null;
}

// A release without a notes file lists its commits since the release before it (`previous`).
async function releaseNotes(tag, previous) {
  const file = await conductr("show", `${tag}:changelog/${tag.slice(1)}.md`);
  const markdown = file.code === 0 ? file.stdout
    : (await conductr("log", "--no-merges", "--format=- %s", "-n", "30", previous ? `${previous}..${tag}` : tag)).stdout;
  const blocks = [];
  let text = [];
  const flush = () => { if (text.join("\n").trim()) blocks.push({ text: text.join("\n").trim() }); text = []; };
  for (const line of markdown.split("\n")) {
    const src = line.match(IMAGE_LINE)?.[1];
    if (!src || /^[a-z]+:|^\//i.test(src)) { text.push(line); continue; }
    flush();
    const image = await releaseImage(tag, src);
    if (image) blocks.push(image);
  }
  flush();
  const date = (await conductr("for-each-ref", "--format=%(creatordate:short)", `refs/tags/${tag}`)).stdout.trim();
  return { version: tag.slice(1), date, blocks };
}

// Every release this checkout has, for conductr-settings' Changelog: { current, notes }, newest first.
const CHANGELOG = "conductr-chrome.changelog";

async function checkUpdates(byHand = false) {
  // Offline, the installed releases still show.
  await conductr("fetch", "--tags", "--quiet");
  const tags = (await conductr("tag", "--list", "v*", "--sort=-v:refname")).stdout.split("\n").filter(Boolean);
  const newer = [], installed = [];
  for (const tag of tags) ((await conductr("merge-base", "--is-ancestor", tag, "HEAD")).code === 0 ? installed : newer).push(tag);
  const notesOf = async (list) => {
    const notes = [];
    for (const tag of list) notes.push(await releaseNotes(tag, tags[tags.indexOf(tag) + 1]));
    return notes;
  };
  setShared(CHANGELOG, { current: installed[0] ?? null, notes: await notesOf(installed) });
  if (!newer.length) {
    setShared(UPDATE, null);
    if (byHand) notify({ title: "Conductr is up to date", level: "success" });
    return;
  }
  setShared(UPDATE, { from: installed[0] ?? null, to: newer[0], notes: await notesOf(newer) });
}

async function update() {
  const to = shared(UPDATE)?.to;
  if (!to) return;
  const r = await conductr("merge", "--ff-only", "--quiet", to);
  if (r.code !== 0) return notify({ title: "Couldn't update Conductr", body: r.stderr.trim(), level: "error" });
  notify({ title: `Conductr updated to ${to.replace(/^v/, "")}`, level: "success" });
  await checkUpdates();
}

const showUpdate = () => openOverlay({ mod: "conductr-update", kind: "dialog", width: 560, height: 560 });

export default class ConductrChrome extends View {
  init(_props, cx) {
    this.memory = null;
    if (props()?.footer) return;
    migrateShared();
    // "conductr-chrome.toggle-sidebar" / ".restore" / ".hibernate" / ".hibernate-picked" / ".hibernate-unsaved" / ".update-claude" / ".update" / ".check-updates"
    // (a key, a toast or `herdr-app do`); only this copy listens.
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (command === "toggle-sidebar") toggleSidebar();
        if (command === "restore") restore();
        if (command === "hibernate") hibernate(true);
        if (command === "hibernate-picked") hibernatePicked(false);
        if (command === "hibernate-unsaved") hibernatePicked(true);
        if (command === "update-claude") updateClaude();
        if (command === "update") update();
        if (command === "check-updates") {
          checkUpdates(true);
          checkClaude();
        }
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        await checkUpdates();
        await cx.sleep(UPDATE_EVERY);
      }
    });
    // The first start asks (conductr-setup); later starts keep the hooks the person chose current,
    // in case Herdr's folder moved (install-hooks.py changes nothing when they already are).
    const setup = shared("conductr-setup.done");
    if (!setup) openOverlay({ mod: "conductr-setup", kind: "dialog", modal: true, width: 600, height: 680 });
    else if (setup.hooks?.length) cx.spawn(async () => {
      const mod = `${appHome()}/mods/conductr-chrome`;
      const r = await exec("/usr/bin/python3", ["-I", `${mod}/install-hooks.py`, `${mod}/session-label.sh`, ...setup.hooks]).catch(() => null);
      if (r && r.code !== 0) notify({ title: "Session restore", body: `Couldn't update the resume hooks: ${r.stderr.trim()}`, level: "warning" });
    });
    cx.spawn(async (cx) => {
      const start = await coreStart().catch(() => null);
      const fresh = Boolean(start) && shared(RESTORED) !== start;
      if (fresh) setShared(RESTORED, start);
      // Give the app a moment to load the core's terminals and panes.
      cx.timer.after(3000, () => {
        restore({ tab: focused()?.tab ?? null, chats: fresh });
        checkClaude();
      });
    });
    cx.timer.every(HIBERNATE_EVERY, () => {
      hibernate();
      checkClaude();
    });
    const refresh = (cx) => cx.spawn(async (cx) => {
      try { this.memory = await memory(); } catch { this.memory = null; }
      cx.notify();
    });
    refresh(cx);
    cx.timer.every(MEMORY_EVERY, refresh);
  }

  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }

  // The sidebar's footer (props { footer: true }): Settings, a menu of Herdr's and conductr-settings.
  footer(t, collapsed) {
    const row = (id, icon, label, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
      .when(collapsed, el => el.relative().w(32).px(0).justify_center().tooltip(label))
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .on_click(action).child(svg(`mods/conductr-chrome/${icon}.svg`).size(14))
      .when(!collapsed, el => el.child(label));
    const ready = div().size(6).rounded_full().bg(t.accent);
    const update = shared(UPDATE);
    const claude = shared(CLAUDE_UPDATE);
    const settings = row("settings", "settings", "Settings", () => openOverlay({ mod: "conductr-menu", kind: "popup", width: 200, height: 76, props: { tab: "settings" } }))
      .when(!collapsed, el => el.flex_1())
      .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready.absolute().top(5).right(6) : ready));
    return (collapsed ? v_flex().items_center().px(0) : h_flex().items_center().px(8)).size_full().bg(t.chrome).border_t(1).border_color(t.border)
      .pt(4).pb(8).gap(4).text_size(13)
      .child(settings)
      .when(Boolean(claude), el => el.child(div().id("claude-update").size(28).flex_none().flex().items_center().justify_center()
        .rounded(8).bg(t.ansi3 + "26").cursor_pointer().hover(s => s.bg(t.ansi3 + "40"))
        .tooltip(`Claude Code was updated: ${count(claude.count)} still on the old version. Restarts the ones that are not busy`)
        .on_click(() => updateClaude()).child(image("icons/claude.svg").size(15))))
      .when(Boolean(update?.to), el => el.child(div().id("conductr-update").size(28).flex_none().flex().items_center().justify_center()
        .rounded(8).bg(t.ansi4 + "26").text_color(t.ansi4).cursor_pointer().hover(s => s.bg(t.ansi4 + "40"))
        .tooltip(`Conductr ${update.to.replace(/^v/, "")} is available`)
        .on_click(showUpdate).child(svg("mods/conductr-chrome/circle-arrow-down.svg").size(15))));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) return this.footer(t, collapsed);
    noteUse();
    const tab = focused()?.tab;
    if (tab && tab !== this.tab) {
      this.tab = tab;
      restore({ tab, chats: false });
    }
    const toggle = this.button("sidebar-toggle", svg("mods/conductr-chrome/sidebar.svg").size(15), toggleSidebar);
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .when(besideLights() && !collapsed, el => el.pl(76))
      .child(toggle)
      .when(!collapsed, el => el.child(this.button("search", svg("mods/conductr-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" })))
        .child(div().flex_1())
        .when(this.memory !== null, el => el.child(h_flex().id("memory").flex_none().h(22).px(7).gap(5).items_center().rounded(6)
          .border_1().border_color(t.border).text_size(11.5).text_color(t.muted).cursor_pointer()
          .hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Memory used by Herdr and everything running in it")
          // The bar drags the window, so the pill keeps its press and opens conductr-resources under itself.
          .on_mouse_down("left", (event, cx) => { cx.stop_propagation(); this.pill = event.bounds; })
          .on_click(() => openOverlay({ mod: "conductr-resources", kind: "popup", frame: "none", width: 480, height: 600,
            at: this.pill ? { x: this.pill.x, y: this.pill.y + this.pill.height + 6 } : "pointer" }))
          .child(svg("mods/conductr-chrome/memory.svg").size(12))
          .child(format(this.memory)))));
  }
}
