// Clone GitHub repo dialog, from Add space's Open GitHub project (conductr-menu). Props: { pick }.
// Clones into <location>/<repo name>, then adds it as a space, or with `pick` hands the folder to
// the Create screen (shared "conductr-create.add").

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, exec, home, appHome, pickFolder, run, shared, setShared } from "herdr";

const REPOS = "conductr-clone.repos"; // the last list GitHub gave, shown at once while it's asked again
const LOCATION = "conductr-clone.location";
const AVATARS = "mods/conductr-clone/.avatars";
const LIST = "user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member";

// The repo's folder name in a GitHub URL or owner/name.
const nameOf = (url) => url.trim().replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() ?? "";

export default class Clone extends View {
  init(_props, cx) {
    this.repos = shared(REPOS) ?? [];
    this.query = "";
    this.error = "";
    this.focus = "url";
    const field = (key, value, placeholder) => {
      const input = InputState.new({ value, placeholder });
      input.on("focus", (_e, cx) => { this.focus = key; cx.notify(); });
      input.on("submit", (_e, cx) => this.clone(cx));
      return input;
    };
    this.url = field("url", "", "https://github.com/user/repo.git");
    this.url.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
    this.search = field("search", "", "Search repositories…");
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); cx.notify(); });
    this.location = field("location", shared(LOCATION) ?? `${home()}/src`, "");
    this.handle = cx.focus_handle();
    this.url.focus();
    cx.timer.after(100, () => this.url.focus());
    cx.spawn(async (cx) => {
      const r = await exec("gh", ["api", LIST, "--jq", ".[] | {name: .full_name, about: .description, owner: .owner.login, avatar: .owner.avatar_url}"]).catch(() => null);
      if (r?.code !== 0) { if (!this.repos.length) this.error = "Couldn't list your GitHub repos (gh api)."; return cx.notify(); }
      this.repos = r.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      setShared(REPOS, this.repos);
      cx.notify();
      // Each owner's avatar, fetched once into a hidden folder (not a mod reload).
      const owners = [...new Map(this.repos.map((repo) => [repo.owner, repo.avatar])).entries()];
      await exec("mkdir", ["-p", `${appHome()}/${AVATARS}`]);
      for (const [owner, url] of owners) {
        const file = `${appHome()}/${AVATARS}/${owner}.png`;
        await exec("sh", ["-c", '[ -s "$1" ] || curl -fsSL -o "$1" "$2"', "x", file, `${url}&s=64`]);
      }
      this.avatars = true;
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  async browse(cx) {
    const folder = await pickFolder({ prompt: "Clone into" });
    if (folder) this.location.set_value(folder);
    cx.notify();
  }

  clone(cx) {
    if (this.busy) return;
    const url = this.url.value().trim();
    const name = nameOf(url);
    if (!url || !name) { this.error = "Type a repository URL or pick a repo."; return cx.notify(); }
    const location = this.location.value().trim().replace(/^~(?=\/|$)/, home()).replace(/\/+$/, "");
    const folder = `${location}/${name}`;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", '[ ! -e "$2" ] || { echo "$2 already exists." >&2; exit 1; }; mkdir -p "$(dirname "$2")" && git clone -- "$1" "$2"', "x", url, folder], { timeout: 600_000 })
        .catch((error) => ({ code: 1, stderr: String(error) }));
      this.busy = false;
      if (r.code !== 0) { this.error = ((r.stderr || r.stdout) ?? "git clone failed.").trim().split("\n").pop(); return cx.notify(); }
      setShared(LOCATION, location);
      if (props().pick) setShared("conductr-create.add", { folder, at: Date.now() });
      else run("space.new", { folder, machine: "" });
      this.close();
    });
  }

  input(state, key, t) {
    return Input.new(state).h(36).px(12).items_center().rounded(8).border(1).border_color(this.focus === key ? t.accent : t.input)
      .bg(t.background).text_color(t.foreground);
  }

  render() {
    const t = theme();
    const shown = this.repos.filter((repo) => !this.query || `${repo.name} ${repo.about ?? ""}`.toLowerCase().includes(this.query)).slice(0, 50);
    const label = (text) => div().pt(6).text_size(13).font_semibold().text_color(t.foreground).child(text);
    const avatar = (repo) => this.avatars
      ? image(`${AVATARS}/${repo.owner}.png`).size(24).rounded(6).flex_none()
      : div().size(24).rounded(6).flex_none().bg(t.raised);
    const row = (repo, index) => h_flex().id(`repo-${index}`).flex_none().gap(12).px(12).py(8).items_center().cursor_pointer()
      .when(index > 0, (el) => el.border_t(1).border_color(t.border))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.url.set_value(`https://github.com/${repo.name}.git`); this.error = ""; this.url.focus(); cx.notify(); })
      .child(avatar(repo))
      .child(v_flex().min_w(0).flex_1()
        .child(div().truncate().text_size(13).text_color(t.foreground).child(repo.name))
        .when(Boolean(repo.about), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(repo.about))));
    const button = (id, text, primary, onClick) => h_flex().id(id).h(36).px(14).gap(8).items_center().rounded(8).cursor_pointer().text_size(13)
      .when(primary, (el) => el.bg(this.busy ? t.raised : t.foreground).text_color(this.busy ? t.dim : t.background).hover((s) => s.opacity(0.85)))
      .when(!primary, (el) => el.border(1).border_color(t.input).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => onClick(cx))
      .children([].concat(text));
    return v_flex().id("clone").track_focus(this.handle).size_full().p(20).gap(8).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.close(); cx.stop_propagation(); }
        else if (e.key === "enter" && e.modifiers.platform) { this.clone(cx); cx.stop_propagation(); }
      })
      .child(div().pb(4).text_size(18).font_semibold().text_color(t.foreground).child("Clone GitHub repo"))
      .child(label("Repository URL"))
      .child(this.input(this.url, "url", t))
      .child(label("Recent repos"))
      .child(this.input(this.search, "search", t))
      .child(v_flex().id("repos").h(200).flex_none().overflow_y_scrollbar().rounded(8).border(1).border_color(t.border)
        .children(shown.map(row))
        .when(shown.length === 0, (el) => el.child(div().p(12).text_color(t.dim).child(this.repos.length ? "No matching repos." : "Loading your repos…"))))
      .child(label("Location"))
      .child(h_flex().gap(8).child(div().flex_1().child(this.input(this.location, "location", t)))
        .child(button("browse", "Browse", false, (cx) => cx.spawn(async (cx) => this.browse(cx)))))
      .child(div().flex_1())
      .child(h_flex().gap(12).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.blocked).child(this.error))
        .child(button("go", [this.busy ? "Cloning…" : "Clone repo", div().text_color(this.busy ? t.dim : t.background).child("⌘↵")], true, (cx) => this.clone(cx))));
  }
}
