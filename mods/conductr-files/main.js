// A lazy file browser for the focused pane's folder. A click opens the file in the tab's
// conductr-viewer pane (split in beside the focused pane the first time); right-click for a menu.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window, run, shared, setShared, openOverlay, nextCommand, notify } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  // A focused mod pane (the viewer) has no folder: use a terminal of its tab instead.
  const focusedPane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const pane = focusedPane?.mod ? panes().find(p => p.tab === focusedPane.tab && p.cwd) : focusedPane;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const INDENT = 18;
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// Files and Source Control share the right panel; these header tabs switch between them.
function panelTabs(t, current) {
  const enabled = shared("workspace.panels") ?? ["files", "changes"];
  // Source Control publishes its change count for the active space, so Files can show it too.
  const changes = shared("conductr-source-control.count");
  const count = changes?.space === spaces().find((s) => s.active)?.id && changes?.files > 0 ? String(changes.files) : null;
  const tabs = [["files", "Files", "mods/files/file.svg"], ["changes", "Source Control", "mods/conductr-source-control/changes.svg"]]
    .filter(([id]) => id === current || enabled.includes(id));
  // The open tab shows its name; the others show only their icon.
  return h_flex().flex_none().gap(2).items_center().children(tabs.map(([id, label, icon]) =>
    h_flex().id(`panel-tab-${id}`).h(26).px(id === current ? 8 : 6).gap(6).items_center().rounded(6)
      .child(svg(icon).size(14))
      .when(id === current, (el) => el.font_semibold().bg(t.selected).text_color(t.foreground).child(label))
      .when(id === "changes" && Boolean(count), (el) => el.child(div().font_normal().text_color(t.dim).child(count)))
      .when(id !== current, (el) => el.text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(label).on_click(() => run("layout.select", { stack: "panel-body", child: id })))));
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    // The right-click menu (conductr-menu) runs "conductr-files.<action>" on this.target.
    cx.spawn(async cx => { for (;;) { const action = await nextCommand(); await this.act(action, cx); cx.notify(); } });
  }

  async act(action, cx) {
    const target = this.target;
    if (!target) return;
    if (action === "open") return this.open(target.path);
    if (action === "cut" || action === "copy") return setShared("conductr-files.clipboard", { file: target.file, on: target.on, cut: action === "cut" });
    if (action === "rename") return this.startRename(target, cx);
    if (action === "delete") {
      // This computer's files go to the Trash; another machine's are removed.
      const r = target.on ? await exec("rm", ["-rf", target.file], { on: target.on }) : await exec("trash", [target.file]);
      return this.finish(r, "Delete failed", cx);
    }
    if (action === "paste") {
      const clip = shared("conductr-files.clipboard");
      if (!clip || (clip.on ?? null) !== (target.on ?? null)) return;
      if (target.file === clip.file || target.file.startsWith(clip.file + "/")) return notify({ title: "Paste failed", body: "Can't paste a folder into itself", level: "error" });
      const script = 'dest="$2/${1##*/}"; [ -e "$dest" ] && { echo "${1##*/} already exists there" >&2; exit 1; }; if [ "$3" = cut ]; then mv "$1" "$dest"; else cp -R "$1" "$dest"; fi';
      const r = await exec("sh", ["-c", script, "paste", clip.file, target.file, clip.cut ? "cut" : "copy"], { on: target.on, timeout: 600000 });
      if (r.code === 0 && clip.cut) setShared("conductr-files.clipboard", null);
      if (r.code === 0 && !this.folders.has(target.path)) this.toggle(target.path, cx);
      return this.finish(r, "Paste failed", cx);
    }
  }

  finish(r, title, cx) {
    if (r.code !== 0) notify({ title, body: (r.stderr || r.stdout).trim(), level: "error" });
    this.refresh(cx);
  }

  // Rename edits the row in place: Enter saves, Escape or leaving it cancels.
  startRename(target, cx) {
    const name = target.path.split("/").pop();
    const input = InputState.new({ value: name });
    const dot = target.dir ? -1 : name.lastIndexOf(".");
    input.set_selected_range({ start: 0, end: dot > 0 ? dot : name.length });
    input.on("submit", (_e, cx) => this.rename(target, input.value().trim(), cx));
    input.on("blur", (_e, cx) => { if (this.renaming?.input === input) { this.renaming = null; cx.notify(); } });
    this.renaming = { path: target.path, input };
    input.focus();
    // The closing menu can take focus back for a moment; ask again once it's gone.
    cx.timer?.after(150, () => { if (this.renaming?.input === input) input.focus(); });
    cx.notify();
  }

  rename(target, name, cx) {
    this.renaming = null;
    cx.notify();
    if (!name || name === target.path.split("/").pop()) return;
    if (name.includes("/")) return notify({ title: "Rename failed", body: "A name can't contain /", level: "error" });
    const script = 'dest="${1%/*}/$2"; [ -e "$dest" ] && { echo "$2 already exists" >&2; exit 1; }; mv "$1" "$dest"';
    cx.spawn(async cx => this.finish(await exec("sh", ["-c", script, "rename", target.file, name], { on: target.on }), "Rename failed", cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, this.folders);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(this.saved.get(next));
      this.pending = new Set(); this.marks = {}; this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // Shows the file in the active tab's viewer pane, splitting one in if the tab has none.
  // Entries for tabs that are gone are dropped on the way.
  open(path) {
    const tab = spaces().find(s => s.active)?.tabs.find(c => c.active)?.id;
    if (!tab) return;
    const tabs = new Set(spaces().flatMap(s => s.tabs.map(c => c.id)));
    const kept = Object.fromEntries(Object.entries(shared("conductr-viewer") ?? {}).filter(([id]) => tabs.has(id)));
    setShared("conductr-viewer", { ...kept, [tab]: { file: `${this.root}/${path}`, on: this.on } });
    if (!panes().some(p => p.tab === tab && p.mod === "conductr-viewer")) run("pane.split", { direction: "right", mod: "conductr-viewer", props: { tab } });
  }

  menu(path, dir) {
    this.target = { path, file: `${this.root}/${path}`, dir, on: this.on };
    openOverlay({ mod: "conductr-menu", kind: "popup", width: 220, height: 400,
      props: { tab: "file", target: { file: this.target.file, relative: path, dir, on: this.on } } });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    const clip = shared("conductr-files.clipboard");
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const renaming = this.renaming?.path === path;
      const cut = clip?.cut && clip.file === `${this.root}/${path}` && (clip.on ?? null) === (this.on ?? null);
      out.push(h_flex().relative().id(`file-${path}`).h(28).flex_none().pl(8 + depth * INDENT).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .when(cut, el => el.opacity(0.5))
        // VS Code style indent guides through each ancestor folder's chevron; rows touch, so lines join up.
        .children(Array.from({ length: depth }, (_, i) => div().absolute().top(0).bottom(0).w(1).left(8 + i * INDENT + 5.5).bg(t.border)))
        .on_click((_e, cx) => renaming ? null : entry.dir ? this.toggle(path, cx) : this.open(path))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(path, entry.dir); })
        .child(entry.dir ? svg(`mods/conductr-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/conductr-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(renaming
          ? Input.new(this.renaming.input).flex_1().min_w(0).h(22).px(5).rounded(5).border_1().border_color(t.accent).bg(t.background).text_size(13)
            .on_key_down((e, cx) => { if (e.key === "escape") { this.renaming = null; cx.stop_propagation(); cx.notify(); } })
          : div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().pl(8).pr(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(panelTabs(t, "files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? "")))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }
}
