// First-start setup, a dialog: checks the programs the conductr mods use, asks before it changes
// anything outside Herdr (the resume hooks of Claude Code and Codex, herdr-core's restore_screen),
// and sets the branch prefix and PR prompt. conductr-chrome opens it while conductr-setup.done is
// unset; Settings opens it again. Shared state:
//   conductr-setup.done  { hooks: ["claude", "codex"] }: conductr-chrome keeps those hooks current
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared, exec, appHome } from "herdr";

const DONE = "conductr-setup.done";
const PREFIX = "conductr-settings.branch-prefix";
const PR_PROMPT = "conductr-settings.pr-prompt";
// conductr-settings and conductr-tabs have the same default.
const DEFAULT_PR_PROMPT = "Create a draft pull request for this branch. Commit anything uncommitted, push the branch, write a short title and a description from the commits and the diff, then give me the link.";
const CORE_CONFIG = "$HOME/.config/herdr-core/config.toml";

// [program, what needs it, how to get it, required]
const TOOLS = [
  ["git", "worktrees, branches and changes", "xcode-select --install", true],
  ["gh", "PR status, checks and Create PR", "brew install gh && gh auth login", true],
  ["jq", "chats and session restore", "brew install jq", true],
  ["python3", "installing the resume hooks", "xcode-select --install", true],
  ["claude", "chats and Claude tabs", "npm install -g @anthropic-ai/claude-code", true],
  ["codex", "Codex tabs (optional)", "npm install -g @openai/codex", false],
];
const AGENTS = [["claude", "Claude Code", "~/.claude/settings.json"], ["codex", "Codex", "~/.codex/hooks.json"]];

const sh = (script) => exec("sh", ["-c", script]).catch(() => ({ code: 1, stdout: "", stderr: "" }));

export default class Setup extends View {
  init(_props, cx) {
    this.tools = null; // { [program]: true | false }, null while checking
    this.ghLogin = null;
    this.agents = {}; // { claude: true } for each agent this machine has, checked by default
    this.restoreScreen = true;
    this.hasRestoreScreen = false;
    this.error = null;
    this.saving = false;
    this.prefix = InputState.new({ value: shared(PREFIX) ?? "", placeholder: "yourname/" });
    this.prompt = TextareaState.new({ value: shared(PR_PROMPT) || DEFAULT_PR_PROMPT, rows: 4 });
    cx.spawn(async (cx) => {
      const found = await Promise.all(TOOLS.map(([name]) => sh(`command -v ${name}`)));
      this.tools = Object.fromEntries(TOOLS.map(([name], i) => [name, found[i].code === 0]));
      if (this.tools.gh) this.ghLogin = (await sh("gh auth status")).code === 0;
      const dirs = await Promise.all(AGENTS.map(([agent]) => sh(`test -d "$HOME/.${agent}"`)));
      const wanted = shared(DONE)?.hooks;
      AGENTS.forEach(([agent], i) => { if (dirs[i].code === 0) this.agents[agent] = wanted ? wanted.includes(agent) : true; });
      this.hasRestoreScreen = (await sh(`grep -q '^restore_screen *= *true' "${CORE_CONFIG}"`)).code === 0;
      if (!shared(PREFIX)) {
        const user = (await sh("id -un")).stdout.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
        if (user && !this.prefix.value()) this.prefix.set_value(`${user}/`);
      }
      cx.notify();
    });
  }

  async save(cx) {
    this.saving = true;
    this.error = null;
    cx.notify();
    const hooks = Object.keys(this.agents).filter((agent) => this.agents[agent]);
    const mod = `${appHome()}/mods/conductr-chrome`;
    if (hooks.length) {
      const r = await exec("/usr/bin/python3", ["-I", `${mod}/install-hooks.py`, `${mod}/session-label.sh`, ...hooks]).catch((error) => ({ code: 1, stderr: String(error) }));
      if (r.code !== 0) this.error = `Couldn't add the resume hooks: ${r.stderr.trim()}`;
    }
    if (this.restoreScreen && !this.hasRestoreScreen) {
      const r = await sh(`mkdir -p "$HOME/.config/herdr-core" && printf 'restore_screen = true\\n' >> "${CORE_CONFIG}"`);
      if (r.code !== 0) this.error = "Couldn't write ~/.config/herdr-core/config.toml.";
    }
    setShared(PREFIX, this.prefix.value().trim() || null);
    const prompt = this.prompt.value().trim();
    setShared(PR_PROMPT, prompt && prompt !== DEFAULT_PR_PROMPT ? prompt : null);
    this.saving = false;
    if (this.error) return cx.notify();
    setShared(DONE, { hooks });
    closeOverlay(props().overlay);
  }

  skip() {
    if (!shared(DONE)) setShared(DONE, { hooks: [] });
    closeOverlay(props().overlay);
  }

  render(cx) {
    const t = theme();
    const section = (title, hint, ...children) => v_flex().gap(8).pb(20)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child(title))
      .when(Boolean(hint), (el) => el.child(div().text_size(12).text_color(t.muted).child(hint)))
      .children(children);
    const check = (id, label, detail, on, toggle) => h_flex().id(id).gap(10).items_center().cursor_pointer()
      .on_click((_e, cx) => { toggle(); cx.notify(); })
      .child(div().size(16).flex_none().rounded(4).border_1().flex().items_center().justify_center()
        .border_color(on ? t.solid : t.input).bg(on ? t.solid : t.background)
        .when(on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(12).text_color(t.solid_foreground))))
      .child(div().text_size(12.5).text_color(t.foreground).child(label))
      .child(div().text_size(11.5).text_color(t.dim).truncate().child(detail));
    const tool = ([name, use, fix, required]) => {
      const ok = this.tools?.[name];
      const color = this.tools === null ? t.dim : ok ? t.ansi2 : required ? t.ansi1 : t.dim;
      const note = this.tools === null ? "checking…" : ok ? (name === "gh" && this.ghLogin === false ? "run: gh auth login" : use) : fix;
      return h_flex().gap(10).items_center().h(22)
        .child(div().size(8).flex_none().rounded(4).bg(color))
        .child(div().w(64).flex_none().text_size(12.5).font_medium().text_color(t.foreground).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(ok && !(name === "gh" && this.ghLogin === false) ? t.muted : t.foreground)
          .when(!ok && this.tools !== null, (el) => el.font_family("monospace")).child(note));
    };
    const button = (id, label, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().text_size(13)
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.background).text_color(primary ? t.solid_foreground : t.foreground)
      .cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action).child(label);
    const agents = AGENTS.filter(([agent]) => agent in this.agents);
    return v_flex().id("conductr-setup").size_full().bg(t.popover).text_color(t.foreground)
      .child(v_flex().px(24).pt(22).pb(14).gap(4).border_b(1).border_color(t.border)
        .child(div().text_size(17).font_semibold().child("Set up Conductr"))
        .child(div().text_size(12.5).text_color(t.muted).child("Nothing outside Herdr changes until you press Save. Settings opens this again.")))
      .child(div().id("setup-body").flex_1().min_h(0).overflow_y_scrollbar().px(24).pt(18)
        .child(section("Programs", null, v_flex().gap(4).children(TOOLS.map(tool))))
        .child(section("Resume after a restart", "Each Claude Code or Codex session labels its terminal, so it comes back after a reboot. This adds a SessionStart and SessionEnd hook and keeps a .bak-herdr copy of the file.",
          ...(agents.length ? agents.map(([agent, name, file]) => check(`hook-${agent}`, name, file, this.agents[agent], () => { this.agents[agent] = !this.agents[agent]; }))
            : [div().text_size(12).text_color(t.dim).child(this.tools === null ? "Checking…" : "Neither Claude Code nor Codex is set up here.")]),
          this.hasRestoreScreen ? div().text_size(12).text_color(t.dim).child("herdr-core already shows a terminal's last screen after a reboot.")
            : check("restore-screen", "Show the last screen after a reboot", "restore_screen in ~/.config/herdr-core/config.toml", this.restoreScreen, () => { this.restoreScreen = !this.restoreScreen; })))
        .child(section("Branch prefix", "New worktree branches start with it.",
          div().w(240).h(34).px(10).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
            .child(Input.new(this.prefix).w_full().text_size(12.5).text_color(t.foreground))))
        .child(section("PR prompt", "What Create PR sends to a new Claude tab. A skill like /my-pr-skill works too.",
          div().p(8).rounded(8).border_1().border_color(t.input).bg(t.background)
            .child(Textarea.new(this.prompt).text_size(12.5).text_color(t.foreground)))))
      .child(h_flex().px(24).py(14).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().text_size(12).text_color(t.ansi1).child(this.error ?? ""))
        .child(button("setup-skip", "Skip", false, () => this.skip()))
        .child(button("setup-save", this.saving ? "Saving…" : "Save", true, (_e, cx) => { if (!this.saving) cx.spawn(async (cx) => this.save(cx)); })));
  }
}
