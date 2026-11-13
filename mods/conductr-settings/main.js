// Conductr's settings, a dialog (props { repo? }: open on that repo). General: the PR prompt and
// main branches conductr-tabs uses. One page per repo: its icon, drawn by conductr-spaces' avatars.
// Everything is shared state:
//   conductr-settings.pr-prompt      string: what Create PR sends (a /skill works too)
//   conductr-settings.main-branches  string[]
//   conductr-settings.branch-prefix  string: what new worktree branches start with, e.g. "calvin/"
//   conductr-settings.icons          { [repo key]: { kind: "icon" | "emoji" | "image", value } }
//   conductr-settings.scripts        { [repo key]: { setup?, archive? } }: overrides of the repo's
//                                  .conductor/settings.toml, run by conductr-worktree ("" runs nothing)
// A repo key is conductr-spaces': JSON [machine or null, absolute git common dir].
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Editor, EditorState, Popover } from "gpui-base";
import { props, closeOverlay, openOverlay, theme, shared, setShared, spaces, panes, exec, readTextFile, appHome, settings } from "herdr";
import { repoKey } from "./repo-key.js";
import { repoScripts } from "./scripts.js";

const ICONS = "conductr-settings.icons";
const SCRIPTS = "conductr-settings.scripts";
const SCRIPT_KINDS = [["setup", "Setup script", "Runs when a new worktree is created"], ["archive", "Archive script", "Runs before a worktree is removed"]];
const PR_PROMPT = "conductr-settings.pr-prompt";
const MAIN_BRANCHES = "conductr-settings.main-branches";
const BRANCH_PREFIX = "conductr-settings.branch-prefix";
const DEFAULT_PR_PROMPT = "Create a draft pull request for this branch. Commit anything uncommitted, push the branch, write a short title and a description from the commits and the diff, then give me the link.";
const DEFAULT_BRANCHES = ["main", "master", "main-dev"];
const HERE = "mods/conductr-settings";
// Hidden: Herdr reloads a mod when a file in its folder changes, which would reset the dialog.
const IMAGES = `${HERE}/.images`;
// ponytail: grids draw at most this many matches (no virtual list: its rows can't hold one click per cell); search finds the rest.
const SHOWN = 360;
const TABS = [["icons", "Icons"], ["emoji", "Emoji"], ["favicon", "Favicon"], ["upload", "Upload"]];
const IMAGE = /\.(svg|png|jpe?g|gif|webp)$/i;

const base = (path) => path.replace(/\/+$/, "").split("/").pop();

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A repo's main checkout from its git common dir (a bare repo has none).
const topOf = (common) => common.endsWith("/.git") ? common.slice(0, -5) : null;

export default class Settings extends View {
  init(_props, cx) {
    this.section = props()?.repo ?? "general"; // "general", or a repo key
    this.page = "general"; // a repo's page: "general" | "scripts"
    this.expanded = new Set(props()?.repo ? [props().repo] : []); // repos whose pages show in the nav
    this.repos = [];
    this.picking = false;
    this.tab = "icons";
    this.icons = [];
    this.emoji = [];
    this.avatar = null; // { key, preview } (preview null: none) for the open repo, null while loading
    this.note = "";
    this.handle = cx.focus_handle();
    this.handle.focus();

    this.prPrompt = TextareaState.new({ value: shared(PR_PROMPT) || DEFAULT_PR_PROMPT, placeholder: DEFAULT_PR_PROMPT, rows: 4 });
    this.prPrompt.on("change", () => setShared(PR_PROMPT, this.prPrompt.value().trim() || null));
    this.branches = InputState.new({ value: (shared(MAIN_BRANCHES) ?? DEFAULT_BRANCHES).join(", "), placeholder: DEFAULT_BRANCHES.join(", ") });
    this.branches.on("change", () => {
      const names = this.branches.value().split(/[\s,]+/).filter(Boolean);
      setShared(MAIN_BRANCHES, names.length ? names : null);
    });
    this.prefix = InputState.new({ value: shared(BRANCH_PREFIX) ?? "", placeholder: "yourname/" });
    this.prefix.on("change", () => setShared(BRANCH_PREFIX, this.prefix.value().trim() || null));
    this.search = InputState.new({ placeholder: "Search" });
    this.search.on("change", (_e, cx) => cx.notify());

    cx.spawn(async (cx) => {
      const [icons, emoji] = await Promise.all([`${HERE}/icons.json`, `${HERE}/emoji.json`].map((file) => readTextFile(`${appHome()}/${file}`).catch(() => null)));
      this.icons = JSON.parse(icons ?? "[]");
      this.emoji = JSON.parse(emoji ?? "[]");
      this.repos = await this.findRepos();
      this.loadScripts(cx);
      cx.notify();
    });
  }

  async close() {
    for (const editor of Object.values(this.editors ?? {})) editor.release();
    await exec("rm", ["-rf", `${appHome()}/${IMAGES}/.preview`]);
  }

  // Every repo a space is in, once: { key, name, top, dir, on }.
  async findRepos() {
    const found = await Promise.all(spaces().map(async (s) => {
      const folder = place(s);
      if (!folder) return null;
      const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on: s.machine }).catch(() => null);
      if (r?.code !== 0) return null;
      const common = r.stdout.replace(/\n$/, "");
      const top = topOf(common);
      return { key: repoKey(s.machine, common), name: top ? base(top) : base(common).replace(/\.git$/, ""), top, dir: top ?? common, on: s.machine ?? null };
    }));
    const byKey = new Map(found.filter(Boolean).map((repo) => [repo.key, repo]));
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  select(section, cx, page = "general") {
    this.scriptMenu = null;
    this.section = section;
    this.page = page;
    this.picking = false;
    this.note = "";
    this.loadScripts(cx);
    cx.notify();
  }

  // The open repo's scripts: what its settings.toml says, and an editor for each, showing the override if any.
  loadScripts(cx) {
    for (const editor of Object.values(this.editors ?? {})) editor.release();
    this.editors = null;
    const repo = this.repos.find((r) => r.key === this.section);
    if (!repo) return;
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${repo.dir}/.conductor/settings.toml`, { on: repo.on }).catch(() => null);
      if (this.section !== repo.key) return;
      this.fromRepo = repoScripts(text);
      const t = theme(), overrides = shared(SCRIPTS)?.[repo.key] ?? {};
      this.editors = Object.fromEntries(SCRIPT_KINDS.map(([kind]) => {
        const editor = EditorState.new({ language: "bash", value: overrides[kind] ?? this.fromRepo[kind] ?? "", soft_wrap: true, folding: false,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, variable: t.ansi4 } });
        editor.on("change", () => this.saveScript(repo.key, kind, editor.value()));
        return [kind, editor];
      }));
      cx.notify();
    });
  }

  // Back to the repo's script: the override goes, and the editor shows the repo's text again.
  resetScript(key, kind, cx) {
    this.scriptMenu = null;
    this.editors[kind].set_value(this.fromRepo[kind] ?? "");
    this.saveScript(key, kind, this.fromRepo[kind] ?? "");
    cx.notify();
  }

  // Text the same as the repo's is no override; anything else is, empty too (it runs nothing).
  saveScript(key, kind, value) {
    const all = shared(SCRIPTS) ?? {};
    const { [kind]: _old, ...rest } = all[key] ?? {};
    const mine = value.trim() === (this.fromRepo[kind] ?? "").trim() ? rest : { ...rest, [kind]: value };
    const { [key]: _gone, ...others } = all;
    setShared(SCRIPTS, Object.keys(mine).length ? { ...others, [key]: mine } : others);
  }

  openTab(tab, cx) {
    this.tab = tab;
    this.note = "";
    this.search.set_value("");
    if (tab === "favicon") this.loadAvatar(cx);
    cx.notify();
  }

  // The GitHub owner's avatar of the repo's origin, downloaded into .preview so image() can draw it.
  loadAvatar(cx) {
    const repo = this.repos.find((r) => r.key === this.section);
    if (!repo || this.avatar?.key === repo.key) return;
    this.avatar = null;
    cx.spawn(async (cx) => {
      const dir = `${appHome()}/${IMAGES}/.preview`;
      const remote = await exec("git", ["remote", "get-url", "origin"], { cwd: repo.dir, on: repo.on }).catch(() => null);
      const owner = remote?.stdout.match(/github\.com[:/]([^/]+)\//)?.[1];
      let preview = null;
      if (owner) {
        const name = `${Date.now()}-github.png`;
        await exec("mkdir", ["-p", dir]);
        const got = await exec("curl", ["-sfL", "-o", `${dir}/${name}`, `https://github.com/${owner}.png?size=96`]).catch(() => null);
        if (got?.code === 0) preview = name;
      }
      this.avatar = { key: repo.key, preview };
      cx.notify();
    });
  }

  setIcon(key, icon) {
    const all = shared(ICONS) ?? {};
    const old = all[key];
    if (old?.kind === "image" && old.value !== icon?.value) exec("rm", ["-f", `${appHome()}/${IMAGES}/${old.value}`]);
    const { [key]: _gone, ...rest } = all;
    setShared(ICONS, icon ? { ...rest, [key]: icon } : rest);
  }

  // Copies an image into .images/ and makes it the repo's icon (`from: "github"` marks the avatar).
  importImage(key, source, cx, from) {
    cx.spawn(async (cx) => {
      const name = `${Date.now()}.${source.split(".").pop().toLowerCase()}`;
      await exec("mkdir", ["-p", `${appHome()}/${IMAGES}`]);
      const copied = await exec("cp", [source, `${appHome()}/${IMAGES}/${name}`]);
      if (copied.code !== 0) this.note = copied.stderr.trim() || "Could not copy the image.";
      else { this.setIcon(key, { kind: "image", value: name, ...(from ? { from } : {}) }); this.picking = false; }
      cx.notify();
    });
  }

  upload(key, cx) {
    cx.spawn(async (cx) => {
      const r = await exec("osascript", ["-e", 'POSIX path of (choose file of type {"public.image"} with prompt "Choose an icon")'], { timeout: 600000 });
      const path = r.stdout.trim();
      if (r.code !== 0 || !path) return; // cancelled
      if (!IMAGE.test(path)) { this.note = "Use a PNG, JPEG, GIF, WebP or SVG image."; cx.notify(); return; }
      this.importImage(key, path, cx);
    });
  }

  key(e, cx) {
    if (e.key !== "escape") return;
    cx.stop_propagation();
    if (this.scriptMenu) { this.scriptMenu = null; cx.notify(); }
    else if (this.picking) { this.picking = false; cx.notify(); } else closeOverlay(props().overlay);
  }

  // A repo's icon as the sidebar draws it, at `size`.
  preview(repo, size, t) {
    const icon = shared(ICONS)?.[repo.key];
    const box = h_flex().size(size).flex_none().rounded(size * 0.28).items_center().justify_center();
    if (icon?.kind === "image") return box.child(image(`${IMAGES}/${icon.value}`).size(size).rounded(size * 0.28));
    if (icon?.kind === "emoji") return box.text_size(size * 0.72).child(icon.value);
    if (icon?.kind === "icon") return box.bg(t.raised).text_color(t.foreground).child(svg(`${HERE}/lucide/${icon.value}.svg`).size(size * 0.66));
    return box.bg(t.raised).text_size(size * 0.58).font_bold().text_color(t.foreground).child([...repo.name][0]?.toUpperCase() ?? "?");
  }

  field(title, hint, control, t) {
    return v_flex().gap(4).pb(22)
      .child(div().text_size(13).font_medium().text_color(t.foreground).child(title))
      .child(div().text_size(12).text_color(t.muted).child(hint))
      .child(div().pt(8).child(control));
  }

  input(state, t) {
    return div().w(320).h(34).px(10).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
      .child(Input.new(state).w_full().text_size(12.5).text_color(t.foreground));
  }

  general(t) {
    return v_flex()
      .child(this.field("PR prompt", "What Create PR sends to a new Claude tab. A skill like /my-pr-skill works too. Empty: the default.",
        div().w(420).p(8).rounded(8).border_1().border_color(t.input).bg(t.background).child(Textarea.new(this.prPrompt).text_size(12.5).text_color(t.foreground)), t))
      .child(this.field("Branch prefix", "What new worktree branches start with, like yourname/.", this.input(this.prefix, t), t))
      .child(this.field("Main branches", "Branches without a Create PR button, comma separated.", this.input(this.branches, t), t))
      .child(this.field("Setup", "Programs, resume hooks for Claude Code and Codex, and herdr-core's restore_screen.",
        div().id("run-setup").w(150).h(32).flex().items_center().justify_center().rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5)
          .cursor_pointer().hover((s) => s.bg(t.hover)).child("Run setup again")
          .on_click(() => { closeOverlay(props().overlay); openOverlay({ mod: "conductr-setup", kind: "dialog", modal: true, width: 600, height: 680 }); }), t));
  }

  grid(repo, t) {
    const query = this.search.value().trim().toLowerCase();
    const cell = (id, child, tip, action) => div().id(id).size(38).flex_none().rounded(8).flex().items_center().justify_center()
      .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tip).on_click(action).child(child);
    const pick = (icon) => (_e, cx) => { this.setIcon(repo.key, icon); this.picking = false; cx.notify(); };
    const matches = this.tab === "icons"
      ? this.icons.filter(([name, tags]) => !query || name.includes(query) || tags.includes(query))
      : this.emoji.filter(([, name]) => !query || name.includes(query));
    const cells = matches.slice(0, SHOWN).map(this.tab === "icons"
      ? ([name]) => cell(`icon-${name}`, svg(`${HERE}/lucide/${name}.svg`).size(18).text_color(t.muted), name, pick({ kind: "icon", value: name }))
      : ([emoji, name]) => cell(`emoji-${name}`, div().text_size(20).child(emoji), name, pick({ kind: "emoji", value: emoji })));
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(40).px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/workspace-chrome/search.svg").size(13).text_color(t.dim))
        .child(Input.new(this.search).flex_1().text_size(12.5).text_color(t.foreground)))
      .child(div().id(`grid-${this.tab}`).flex_1().min_h(0).overflow_y_scrollbar().p(8)
        .child(h_flex().flex_wrap().gap(2).children(cells))
        .when(matches.length > SHOWN, (el) => el.child(div().p(8).text_size(11.5).text_color(t.dim).child(`${matches.length - SHOWN} more: search to find them.`)))
        .when(matches.length === 0, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("Nothing matches."))));
  }

  favicon(repo, t) {
    const centered = v_flex().flex_1().items_center().justify_center().gap(14);
    if (!this.avatar || this.avatar.key !== repo.key) return centered.child(div().text_size(12).text_color(t.dim).child("Looking for the GitHub avatar…"));
    if (!this.avatar.preview) return centered.child(div().text_size(12).text_color(t.dim).child("This repo has no GitHub remote."));
    const using = shared(ICONS)?.[repo.key]?.from === "github";
    return centered
      .child(image(`${IMAGES}/.preview/${this.avatar.preview}`).size(56).rounded(12))
      .child(div().id("use-avatar").h(32).px(14).flex().items_center().rounded(8).bg(t.raised).text_size(12.5)
        .text_color(using ? t.muted : t.foreground)
        .when(!using, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88))
          .on_click((_e, cx) => this.importImage(repo.key, `${appHome()}/${IMAGES}/.preview/${this.avatar.preview}`, cx, "github")))
        .child(using ? "Using GitHub avatar" : "Use GitHub avatar"));
  }

  picker(repo, t) {
    return v_flex().w(440).h(330).mt(8).rounded(10).border_1().border_color(t.border).bg(t.popover).overflow_hidden()
      .child(h_flex().px(8).gap(2).border_b(1).border_color(t.border).children(TABS.map(([id, label]) => {
        const on = id === this.tab;
        return div().id(`tab-${id}`).px(10).py(9).text_size(12.5).cursor_pointer()
          .text_color(on ? t.foreground : t.muted).border_b(2).border_color(on ? t.accent : "#00000000")
          .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.openTab(id, cx)).child(label);
      })))
      .child(this.tab === "icons" || this.tab === "emoji" ? this.grid(repo, t)
        : this.tab === "favicon" ? this.favicon(repo, t)
        : v_flex().flex_1().items_center().justify_center().gap(12)
          .child(div().id("upload").h(32).px(14).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.raised)
            .text_size(12.5).cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => this.upload(repo.key, cx)).child("Choose image…"))
          .child(div().text_size(11.5).text_color(t.dim).child("A PNG, JPEG, GIF, WebP or SVG image.")));
  }

  // A repo's row opens or closes its pages; opening shows its General.
  toggleRepo(key, cx) {
    if (this.expanded.has(key)) { this.expanded.delete(key); return cx.notify(); }
    this.expanded.add(key);
    this.select(key, cx);
  }

  repoPage(repo, t) {
    const icon = shared(ICONS)?.[repo.key];
    const button = div().id("icon-button").size(44).rounded(10).border_1().border_color(this.picking ? t.accent : t.input)
      .flex().items_center().justify_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.picking = !this.picking;
        if (this.picking) this.openTab(this.tab, cx); else cx.notify();
      })
      .child(this.preview(repo, 24, t));
    const control = v_flex()
      .child(h_flex().gap(12).items_center().child(button)
        .when(Boolean(icon), (el) => el.child(div().id("icon-reset").text_size(12).text_color(t.muted).cursor_pointer()
          .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.setIcon(repo.key, null); cx.notify(); }).child("Reset"))))
      .when(this.picking, (el) => el.child(this.picker(repo, t)))
      .when(Boolean(this.note), (el) => el.child(div().pt(8).text_size(11.5).text_color(t.ansi1).child(this.note)));
    const where = repo.top ?? repo.dir;
    const location = h_flex().gap(8)
      .child(h_flex().w(380).h(34).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
        .child(svg("mods/workspace-chrome/folder.svg").size(14).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(settings().font_family).text_color(t.foreground).child(where)))
      .when(!repo.on, (el) => el.child(div().id("reveal").h(34).px(12).flex().items_center().rounded(8).border_1().border_color(t.input)
        .bg(t.raised).text_size(12.5).cursor_pointer().hover((s) => s.opacity(0.88))
        .on_click(() => exec("open", [where])).child("Open in Finder")));
    return v_flex()
      .child(this.field("Location", repo.on ? `The main checkout, on ${repo.on}.` : "The main checkout.", location, t))
      .child(this.field("Icon", "Shown next to the repository name in the sidebar.", control, t));
  }

  scripts(repo, t) {
    const overrides = shared(SCRIPTS)?.[repo.key] ?? {};
    return v_flex().pb(28)
      .child(div().pb(18).text_size(12).text_color(t.muted).child("Commands that run when worktrees are created or removed. They get HERDR_ROOT_PATH and HERDR_WORKSPACE_PATH."))
      .child(!this.editors ? div().text_size(12).text_color(t.dim).child("Loading…") : v_flex().gap(20).children(SCRIPT_KINDS.map(([kind, title, hint]) => {
        const source = kind in overrides ? (this.fromRepo[kind] !== undefined ? "Overriding your repo's settings.toml" : "")
          : this.fromRepo[kind] !== undefined ? "Set by your repo's settings.toml" : "";
        const overriding = kind in overrides && this.fromRepo[kind] !== undefined;
        // Popover owns the press, an outside click and Esc, and draws above the editors.
        const gear = Popover.new(`script-menu-${kind}`).anchor("bottom_left").open(this.scriptMenu === kind)
          .on_open_change((open, cx) => { this.scriptMenu = open ? kind : null; cx.notify(); })
          .trigger(div().size(24).rounded(6).flex().items_center().justify_center().cursor_pointer()
            .text_color(t.muted).when(this.scriptMenu === kind, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .child(svg("mods/workspace-chrome/settings.svg").size(14)))
          .content(v_flex().mt(4).w(140).p(4).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_md()
            .child(div().id(`script-reset-${kind}`).h(28).px(8).flex().items_center().rounded(6).text_size(12.5).cursor_pointer()
              .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.resetScript(repo.key, kind, cx)).child("Reset")));
        return v_flex().gap(4)
          .child(h_flex().gap(8).items_center().child(div().text_size(13).font_medium().child(title))
            .when(Boolean(source), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(source)))
            .when(overriding, (el) => el.child(gear)))
          .child(div().text_size(12).text_color(t.muted).child(hint))
          .child(div().mt(8).h(84).rounded(8).border_1().border_color(t.input).bg(t.background).overflow_hidden()
            .child(Editor.new(this.editors[kind]).size_full()));
      })));
  }

  render() {
    const t = theme();
    const repo = this.repos.find((r) => r.key === this.section);
    const navRow = (id, child, on, action) => h_flex().id(id).h(30).px(8).gap(8).items_center().rounded(7).text_size(12.5)
      .cursor_pointer().text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(on ? t.selected : t.hover)).on_click(action).children(child);
    const pages = [["general", "General", "sliders-horizontal"], ["scripts", "Scripts", "file-code"]];
    const title = this.section === "general" ? "General" : repo ? pages.find(([id]) => id === this.page)[1] : "";
    const repoNav = (r) => v_flex().gap(2)
      .child(navRow(`nav-${r.key}`, [this.preview(r, 16, t), div().truncate().child(r.name)], false, (_e, cx) => this.toggleRepo(r.key, cx)))
      .when(this.expanded.has(r.key), (el) => el.child(v_flex().ml(15).pl(6).gap(2).border_l(1).border_color(t.border).children(
        pages.map(([id, label, icon]) => navRow(`nav-${r.key}-${id}`, [svg(`${HERE}/lucide/${icon}.svg`).size(14), label],
          r.key === this.section && id === this.page, (_e, cx) => this.select(r.key, cx, id))))));
    return h_flex().id("conductr-settings").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().bg(t.popover).text_color(t.foreground)
      .child(v_flex().w(210).h_full().flex_none().p(10).gap(2).bg(t.chrome).border_r(1).border_color(t.border)
        .child(div().px(8).pt(4).pb(10).text_size(14).font_semibold().child("Conductr settings"))
        .child(navRow("nav-general", [svg("mods/workspace-chrome/settings.svg").size(14), "General"], this.section === "general", (_e, cx) => this.select("general", cx)))
        .child(div().px(8).pt(16).pb(6).text_size(11).text_color(t.dim).child("Repositories"))
        .child(div().id("nav-repos").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().gap(2).children(
          this.repos.map(repoNav)))))
      .child(v_flex().flex_1().min_w(0).h_full()
        .child(h_flex().h(52).px(24).flex_none().items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().text_size(15).font_semibold().child(title))
          .child(div().id("close").size(28).rounded(7).flex().items_center().justify_center().cursor_pointer()
            .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close")
            .on_click(() => closeOverlay(props().overlay)).child(svg("mods/workspace-chrome/x.svg").size(15))))
        .child(div().id("page").flex_1().min_h(0).overflow_y_scrollbar().px(24).pt(20)
          .child(this.section === "general" ? this.general(t)
            : repo ? (this.page === "scripts" ? this.scripts(repo, t) : this.repoPage(repo, t))
            : div().text_size(12).text_color(t.dim).child("Loading…"))));
  }
}
