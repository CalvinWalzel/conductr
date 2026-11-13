// The sidebar's top bar: sidebar toggle and search after the window buttons, and on the
// right how much memory Herdr and everything running in it use. With props { footer: true },
// the sidebar's footer instead.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, layout, exec, updates, nextCommand, openOverlay, panes, appHome, notify } from "herdr";

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
// or Codex session (agent.session=<agent>:<id>, set by ~/.claude/hooks/herdr-session-label.sh). Only
// terminals that show a bare shell are touched; "conductr-chrome.restore" does it again by hand.
const RESTORED = "conductr-chrome.restored-core";
const quote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;

async function coreStart() {
  const r = await exec("ps", ["-axo", "lstart=,comm="]);
  const line = r.stdout.split("\n").find((row) => row.endsWith("/Herdr Core.app/Contents/MacOS/herdr-core"));
  return line?.match(/^\s*(\w{3} \w{3} +\d+ [\d:]+ \d{4})/)?.[1] ?? null;
}

// Labels come from `hc get`: terminals() and `hc ls` leave them out.
async function restore() {
  for (const pane of panes()) {
    if (!pane.terminal || pane.terminal.includes("/") || !pane.program?.shell) continue;
    const got = await exec("hc", ["get", pane.terminal, "--json"]).catch(() => null);
    const labels = got?.code === 0 ? JSON.parse(got.stdout).labels ?? {} : {};
    const [agent, session] = (labels["agent.session"] ?? "").split(/:(.*)/);
    const chat = labels["conductr.chat"] ?? labels["calvin.chat"];
    const command = chat ? `sh ${quote(`${appHome()}/mods/conductr-chat/run.sh`)} ${quote(chat)}`
      : agent === "claude" ? `claude --resume ${quote(session)}`
      : agent === "codex" ? `codex resume ${quote(session)}` : null;
    if (command) await exec("hc", ["send", pane.terminal, command]);
  }
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
// { count, log } while upstream has commits this checkout lacks; the footer shows an update button.
const UPDATE = "conductr-chrome.update";

async function checkUpdates(byHand = false) {
  if ((await conductr("fetch", "--quiet")).code !== 0) return;
  const count = Number((await conductr("rev-list", "--count", "HEAD..@{u}")).stdout.trim() || 0);
  const log = count ? (await conductr("log", "--format=- %s · %cr", "-n", "20", "HEAD..@{u}")).stdout.trim() : "";
  setShared(UPDATE, count ? { count, log } : null);
  if (byHand && !count) notify({ title: "Conductr is up to date", level: "success" });
}

async function update() {
  const r = await conductr("pull", "--ff-only", "--quiet");
  if (r.code !== 0) return notify({ title: "Couldn't update Conductr", body: r.stderr.trim(), level: "error" });
  setShared(UPDATE, null);
  notify({ title: "Conductr updated", level: "success" });
}

// The changelog in conductr-confirm; Install runs the update.
function showUpdate({ count, log }) {
  openOverlay({ mod: "conductr-confirm", kind: "dialog", width: 540, height: Math.min(480, 170 + 22 * Math.min(count, 20)), props: {
    title: `Conductr update: ${count} new change${count === 1 ? "" : "s"}`,
    detail: `${log}${count > 20 ? `\n- …and ${count - 20} more` : ""}`,
    action: "Install", command: { name: "conductr-chrome.update" } } });
}

export default class ConductrChrome extends View {
  init(_props, cx) {
    this.memory = null;
    if (props()?.footer) return;
    migrateShared();
    // "conductr-chrome.toggle-sidebar" / ".restore" / ".update" / ".check-updates" (a key, a toast or `herdr-app do`);
    // only this copy listens.
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (command === "toggle-sidebar") toggleSidebar();
        if (command === "restore") restore();
        if (command === "update") update();
        if (command === "check-updates") checkUpdates(true);
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
      if (!start || shared(RESTORED) === start) return;
      setShared(RESTORED, start);
      // Give the app a moment to load the core's terminals and panes.
      cx.timer.after(3000, () => restore());
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
    const settings = row("settings", "settings", "Settings", () => openOverlay({ mod: "conductr-menu", kind: "popup", width: 200, height: 76, props: { tab: "settings" } }))
      .when(!collapsed, el => el.flex_1())
      .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready.absolute().top(5).right(6) : ready));
    return (collapsed ? v_flex().items_center().px(0) : h_flex().items_center().px(8)).size_full().bg(t.chrome).border_t(1).border_color(t.border)
      .pt(4).pb(8).gap(4).text_size(13)
      .child(settings)
      .when(Boolean(update), el => el.child(div().id("conductr-update").size(28).flex_none().flex().items_center().justify_center()
        .rounded(8).bg(t.ansi4 + "26").text_color(t.ansi4).cursor_pointer().hover(s => s.bg(t.ansi4 + "40"))
        .tooltip(`Conductr update: ${update.count} new change${update.count === 1 ? "" : "s"}`)
        .on_click(() => showUpdate(update)).child(svg("mods/conductr-chrome/circle-arrow-down.svg").size(15))));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) return this.footer(t, collapsed);
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
