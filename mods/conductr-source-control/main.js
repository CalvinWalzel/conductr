import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { spaces, panes, exec, readTextFile, watchFolder, theme, shared, setShared, run, openOverlay, nextCommand, notify } from "herdr";

const icon = (name) => `mods/conductr-settings/lucide/${name}.svg`;

const mainBranches = () => new Set(shared("conductr-settings.main-branches") ?? ["main", "master", "main-dev"]);

// The active space's worktree, as conductr-spaces places it: its first terminal's live folder,
// else where it was made. Focus within the space doesn't change it.
function location() {
  const space = spaces().find((s) => s.active);
  const tabs = new Set((space?.tabs ?? []).map((c) => c.id));
  return { cwd: panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space?.folder, on: space?.machine ?? null };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
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

export default class SourceControl extends View {
  init(_props, cx) {
    this.files = []; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    // The right-click menu (conductr-menu) and the discard dialog run "conductr-source-control.<action>" on this.target.
    cx.spawn(async (cx) => { for (;;) { const action = await nextCommand(); await this.act(action, cx); cx.notify(); } });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.stack = null; this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        // git diff leaves out untracked files, so count their lines directly.
        const fresh = files.filter((f) => f.fresh).slice(0, 200);
        if (fresh.length) {
          const counts = await exec("wc", ["-l", "--", ...fresh.map((f) => f.path)], { cwd: root, on });
          const byPath = Object.fromEntries(counts.stdout.split("\n").map((line) => /^\s*(\d+) (.+)$/.exec(line)).filter(Boolean).map((m) => [m[2], +m[1]]));
          for (const f of fresh) f.add = byPath[f.path] ?? 0;
        }
        const stack = await this.loadStack(on, git).catch(() => null);
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files;
        const space = spaces().find((s) => s.active)?.id, published = shared("conductr-source-control.count");
        if (published?.space !== space || published?.files !== files.length) setShared("conductr-source-control.count", { space, files: files.length }); this.stack = stack; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) this.open = null;
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // Reads Graphite's files directly: `gt state` writes under .git, which the folder watch would see.
  async loadStack(on, git) {
    const branch = await git(["symbolic-ref", "--short", "-q", "HEAD"]), current = branch.stdout.trim();
    if (branch.code !== 0 || !current) return null;
    const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
    const db = await exec("sqlite3", ["-readonly", "-json", `file:${encodeURI(common)}/.graphite_metadata.db?immutable=1`,
      "select branch_name name, parent_branch_name parent, parent_branch_revision base from branch_metadata"], { on });
    const refs = await git(["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"]);
    const shas = Object.fromEntries(refs.stdout.split("\n").filter(Boolean).map((line) => line.split("\0")));
    const branches = db.code === 0 && db.stdout.trim() ? JSON.parse(db.stdout).filter((b) => shas[b.name]) : [];
    const byName = Object.fromEntries(branches.map((b) => [b.name, b]));
    const prs = {};
    try {
      for (const pr of JSON.parse(await readTextFile(`${common}/.graphite_pr_info`, { on })).prInfos ?? []) prs[pr.headRefName] = pr;
    } catch {}
    const row = (name) => {
      const b = byName[name] ?? { name };
      return { name, current: name === current, trunk: !b.parent, restack: Boolean(b.parent && shas[b.parent] && b.base !== shas[b.parent]), pr: prs[name] };
    };
    if (byName[current]?.parent) {
      const rows = [];
      const above = (name) => { for (const child of branches.filter((b) => b.parent === name)) { above(child.name); rows.push(row(child.name)); } };
      above(current);
      for (let name = current, seen = new Set(); name && !seen.has(name); name = byName[name]?.parent) { seen.add(name); rows.push(row(name)); }
      return { title: "Graphite", rows };
    }
    let trunk = mainBranches().has(current) ? current : null;
    if (!trunk) try { trunk = JSON.parse(await readTextFile(`${common}/.graphite_repo_config`, { on })).trunk; } catch {}
    if (!trunk) {
      const origin = await git(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
      trunk = origin.code === 0 ? origin.stdout.trim().replace(/^origin\//, "") : "main";
    }
    return { title: "Git", rows: (current === trunk ? [current] : [current, trunk]).map((name) => ({ ...row(name), trunk: name === trunk })) };
  }

  stackRow(branch, index, count, t) {
    const pr = branch.pr, prColor = !pr ? t.dim : pr.state === "MERGED" ? t.ansi5 : pr.state === "CLOSED" || pr.isDraft ? t.dim : t.ansi2;
    return h_flex().id(`stack-${branch.name}`).h(26).flex_none().px(8).gap(8).items_center().rounded(7).when(branch.current, (e) => e.bg(t.selected))
      .child(div().relative().w(9).h_full().flex_none()
        .when(index > 0, (e) => e.child(div().absolute().left(4).top(0).h(13).w(1).bg(t.border)))
        .when(index < count - 1, (e) => e.child(div().absolute().left(4).top(13).bottom(0).w(1).bg(t.border)))
        .child(div().absolute().left(1).top(9.5).w(7).h(7).rounded(4).bg(branch.current ? t.ansi2 : t.dim)))
      .child(h_flex().flex_1().min_w(0).gap(4)
        .child(div().min_w(0).truncate().text_color(branch.current ? t.foreground : t.muted).when(branch.current, (e) => e.font_medium()).child(branch.name))
        .when(branch.trunk, (e) => e.child(div().flex_none().text_color(t.dim).child("(trunk)"))))
      .when(branch.restack, (e) => e.child(div().flex_none().text_size(12).text_color(t.blocked).child("⚠")))
      .when(Boolean(pr), (e) => e.child(div().flex_none().text_size(11).text_color(prColor).child(`#${pr.prNumber}`)));
  }

  async act(action, cx) {
    const file = this.files.find((f) => f.path === this.target);
    if (!file) return;
    if (action === "view") return this.view(file);
    if (action === "ask-discard") return this.askDiscard(file);
    if (action === "discard") return this.discard(file, cx);
  }

  // Shows the file's changes in the active tab's viewer pane, splitting one in if the tab has none.
  // Entries for tabs that are gone are dropped on the way.
  view(file) {
    const tab = spaces().find((s) => s.active)?.tabs.find((c) => c.active)?.id;
    if (!tab || !this.root) return;
    this.open = file.path;
    const tabs = new Set(spaces().flatMap((s) => s.tabs.map((c) => c.id)));
    const kept = Object.fromEntries(Object.entries(shared("conductr-viewer") ?? {}).filter(([id]) => tabs.has(id)));
    const diff = { root: this.root, path: file.path, head: this.hasHead, fresh: file.fresh || (!this.hasHead && file.status === "A") };
    setShared("conductr-viewer", { ...kept, [tab]: { file: `${this.root}/${file.path}`, on: this.on, diff } });
    if (!panes().some((p) => p.tab === tab && p.mod === "conductr-viewer")) run("pane.split", { direction: "right", mod: "conductr-viewer", props: { tab } });
  }

  menu(file) {
    this.target = file.path;
    openOverlay({ mod: "conductr-menu", kind: "popup", width: 220, height: 200,
      props: { tab: "change", target: { file: `${this.root}/${file.path}`, relative: file.path } } });
  }

  askDiscard(file) {
    this.target = file.path;
    const path = `**\`${file.path}\`**`;
    openOverlay({ mod: "conductr-confirm", kind: "dialog", width: 540, height: 190, props: { title: "Discard file changes?", action: "Discard", danger: true,
      detail: !file.fresh ? `Discard all changes to ${path}? This action cannot be undone.`
        : this.on ? `Delete the new file ${path}? This action cannot be undone.` : `Move the new file ${path} to the Trash?`,
      command: { name: "conductr-source-control.discard" } } });
  }

  // New files go to the Trash (another machine's are removed); the rest go back to HEAD, staged or not.
  async discard(file, cx) {
    const root = this.root, on = this.on, full = `${root}/${file.path}`;
    const remove = () => on ? exec("rm", ["-f", full], { on }) : exec("trash", [full]);
    let r;
    if (file.fresh) r = await remove();
    else if (file.status === "A") { r = await exec("git", ["rm", "-q", "--cached", "--", file.path], { cwd: root, on }); if (r.code === 0) r = await remove(); }
    else r = await exec("git", ["restore", "--source=HEAD", "--staged", "--worktree", "--", file.path], { cwd: root, on });
    if (r.code !== 0) notify({ title: "Discard failed", body: (r.stderr || r.stdout).trim(), level: "error" });
    this.refresh(cx);
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  changeRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop(), hovered = this.hovered === f.path;
    const [mark, color] = { A: ["square-plus", t.ansi2], D: ["square-minus", t.ansi1], U: ["square-x", t.ansi1] }[f.status] ?? ["square-dot", t.ansi3];
    return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_hover((over, cx) => { if (over) this.hovered = f.path; else if (hovered) this.hovered = null; cx.notify(); })
      .on_click(() => this.view(f))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(f); })
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(hovered, (e) => e.child(div().id(`discard-${f.path}`).p(3).rounded(5).hover((s) => s.bg(t.raised)).text_color(t.muted)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.askDiscard(f); })
        .child(svg(icon("undo-2")).size(14))))
      .when(!hovered, (e) => e
        .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
        .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
        .child(svg(icon(mark)).size(13).flex_none().text_color(color)));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().pl(8).pr(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(panelTabs(t, "changes"))
)
      .when(Boolean(this.stack?.rows.length), (e) => e.child(v_flex().id("stack").flex_none().max_h(240).overflow_y_scroll().px(6).py(10).border_b(1).border_color(t.border)
        .child(div().px(8).h(24).flex().items_center().text_size(13).font_medium().text_color(t.muted).child(this.stack.title))
        .children(this.stack.rows.map((branch, index) => this.stackRow(branch, index, this.stack.rows.length, t)))))
      .child(h_flex().flex_none().px(14).pt(12).h(36).items_center().justify_between()
        .child(div().text_size(13).font_medium().text_color(t.muted).child(`Changes (${this.files.length})`))
        .child(h_flex().gap(6).text_size(11).child(div().text_color(t.ansi2).child(`+${add}`)).child(div().text_color(t.ansi1).child(`−${del}`))))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).relative()
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().px(6).pb(6).children(this.files.map((f) => this.changeRow(f, t)))
          .when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
