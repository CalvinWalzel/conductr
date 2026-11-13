// A chat with a headless Claude Code. The backend (run.sh) runs in a terminal pane behind this
// zoomed pane; they talk through files in props().dir: this pane appends to in.jsonl, Claude
// appends events to out.jsonl. Props: { dir, cwd }, or { create: true } for the Create screen (create.js).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, TextView, Popover, HoverCard } from "gpui-base";
import { exec, run, props, theme, appHome, terminals, panes, focused, openOverlay, shared, setShared } from "herdr";
import { emptyState, fold } from "./events.js";
import { card, frame } from "./cards.js";
import { Composer, attachmentChip } from "./composer.js";
import { sendArgs, blocks, bubble } from "./parts.js";
import { Create, CLAUDE } from "./create.js";

const SHOWN = 150;
// The chat is a centered column, like Conductor's: it fills a narrow pane and stops growing at this.
const COLUMN = 900;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const clock = (date) => `${date.getHours() % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")} ${date.getHours() < 12 ? "AM" : "PM"}`;
const day = (date) => `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}, ${clock(date)}`;
const count = (number) => String(number ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function took(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

export default class Chat extends View {
  init(_props, cx) {
    if (props()?.create) {
      this.create = new Create(cx);
      return;
    }
    this.dir = props()?.dir;
    this.cwd = props()?.cwd;
    this.state = emptyState();
    this.lines = 0;
    this.answered = new Set();
    this.open = {};
    this.picks = {};
    this.files = null;
    // Sent messages Claude has not echoed back yet; shown at once, dropped as their echo arrives.
    this.sent = [];
    this.copied = null;
    this.actions = null;
    this.pinned = true;
    this.scroll = ScrollHandle.new();
    this.composer = new Composer(cx, {
      placeholder: "Ask to make changes, @mention files, run /commands",
      dir: () => this.dir,
      cwd: () => this.cwd,
      state: () => this.state,
      busy: () => this.busy(),
      send: (cx) => this.send(cx),
      stop: (cx) => this.stop(cx),
      setMode: (mode, cx) => this.setMode(mode, cx),
    });
    // ⌘L anywhere in the chat moves the keyboard to the composer. The keyboard reaches the chat only
    // through this handle, which takes it when the pane is focused.
    this.paneFocus = cx.focus_handle();
    cx.bind_keys([
      { keystroke: "cmd-l", action: "chat-focus", context: "ConductrChatPane" },
      { keystroke: "cmd-shift-backspace", action: "chat-cancel", context: "ConductrChatPane" },
    ]);
    if (!this.dir) return;
    cx.spawn(async (cx) => {
      const sent = await exec("grep", ["-o", '"request_id":"[^"]*"', `${this.dir}/in.jsonl`]);
      for (const match of sent.stdout.matchAll(/"request_id":"([^"]*)"/g)) this.answered.add(match[1]);
      await this.control({ subtype: "initialize" });
      await this.control({ subtype: "get_settings" });
      // ponytail: polls; watchFolder does not report files under the app's data folder.
      for (;;) {
        try {
          await this.pull(cx);
          await this.seen(cx);
          this.arrive();
        } catch (error) { this.error = String(error); cx.notify(); }
        await cx.sleep(700);
      }
    });
  }

  async pull(cx) {
    const read = await exec("tail", ["-n", `+${this.lines + 1}`, `${this.dir}/out.jsonl`]);
    const end = read.stdout.lastIndexOf("\n");
    if (end < 0) return;
    const lines = read.stdout.slice(0, end).split("\n");
    const first = this.lines + 1;
    this.lines += lines.length;
    lines.forEach((line, offset) => {
      const count = this.state.items.length;
      let event = null;
      try {
        event = JSON.parse(line);
        // run.sh stamps each event; a backend started before it did is stamped here, when seen live.
        if (this.loaded && event && typeof event === "object" && !event.conductr_at) event.conductr_at = Date.now() / 1000;
        fold(this.state, event, first + offset);
      } catch { /* not JSON: skip it */ }
      if (this.state.items[count]?.kind === "user") this.sent.shift();
      // A message stopped before Claude echoed it never will be.
      if (event?.type === "result") this.sent = [];
    });
    this.loaded = true;
    // The Create screen offers the models and commands a chat last reported.
    const claude = { models: this.state.models, commands: this.state.commands };
    if (claude.models.length && JSON.stringify(claude) !== JSON.stringify(shared(CLAUDE))) setShared(CLAUDE, claude);
    if (this.pinned) this.scroll.scroll_to_item(this.bottom ?? 0);
    cx.notify();
  }

  backend() {
    return terminals().find((terminal) => terminal.argv?.includes(this.dir));
  }

  // The pane Herdr focuses gets its keyboard here, unless the composer already has it.
  arrive() {
    const address = this.backend()?.address;
    const tab = address && panes().find((candidate) => candidate.terminal === address)?.tab;
    const me = panes().find((candidate) => candidate.mod === "conductr-chat" && candidate.tab === tab);
    const shown = Boolean(me?.focused && focused()?.pane === me.pane);
    if (shown && !this.shown && !this.composer.typing) this.paneFocus.focus();
    this.shown = shown;
  }

  // Herdr keeps "done" until the backend pane is looked at, and it sits behind this zoomed pane.
  // Focusing it counts as a look; the zoom keeps this pane on screen. Only panes()
  // knows "done"; terminals() has the core's word.
  async seen(cx) {
    const address = this.backend()?.address;
    const pane = address && panes().find((candidate) => candidate.terminal === address);
    if (pane?.status !== "done") return;
    const me = panes().find((candidate) => candidate.mod === "conductr-chat" && candidate.tab === pane.tab);
    if (!me?.focused || focused()?.pane !== me.pane) return;
    const typing = this.composer.typing;
    // Both in one tick, so no frame shows the terminal in between.
    run("pane.focus", { pane: pane.pane });
    run("pane.focus", { pane: me.pane });
    // Herdr hands the pane its keyboard after this tick; the composer takes it back if it had it.
    await cx.sleep(50);
    if (typing) this.composer.box.focus();
  }

  // ponytail: a note goes into out.jsonl next to Claude's own appends; one short line per write.
  append(message, file = "in.jsonl") {
    return exec("sh", ["-c", 'printf "%s\\n" "$1" >> "$2"', "x", JSON.stringify(message), `${this.dir}/${file}`]);
  }

  control(request) {
    return this.append({ type: "control_request", request_id: `c${Date.now()}`, request });
  }

  // A deny carries what the user typed, if anything; it shows in the timeline as their message.
  answer(ask, response, cx) {
    const typed = response.behavior === "deny" && this.composer.box.value().trim();
    this.answered.add(ask.id);
    this.composer.box.set_value("");
    cx.notify();
    cx.spawn(async () => {
      if (typed) await this.append({ type: "conductr_note", text: typed }, "out.jsonl");
      await this.append({ type: "control_response", response: { subtype: "success", request_id: ask.id, response } });
    });
  }

  // From send until the turn's result; Claude's own events lag behind the send.
  busy() {
    return this.state.working || this.sent.length > 0;
  }

  waiting() {
    return this.state.asks.filter((ask) => !this.answered.has(ask.id));
  }

  send(cx) {
    const composer = this.composer;
    const text = composer.box.value().trim();
    if (!text) return;
    // Claude waits on its open requests and runs nothing else, so a message answers them: it denies
    // them with the message as feedback, as typing at a Claude Code prompt does.
    const asks = this.waiting();
    if (asks.length && !composer.box.tokens().some((span) => span.token.id.startsWith("img-"))) {
      for (const ask of asks) this.answer(ask, { behavior: "deny", message: text }, cx);
      this.pinned = true;
      return;
    }
    const { parts, pending } = composer.take();
    this.sent.push({ kind: "user", ...bubble(blocks(parts)) });
    this.pinned = true;
    this.scroll.scroll_to_item(this.bottom + 1);
    cx.notify();
    cx.spawn(async () => {
      if (pending.model) await this.control({ subtype: "set_model", model: pending.model.value });
      if (pending.effort) await this.control({ subtype: "apply_flag_settings", settings: { effortLevel: pending.effort } });
      await exec("sh", [`${appHome()}/mods/conductr-chat/send.sh`, this.dir, ...sendArgs(parts)]);
    });
  }

  setMode(mode, cx) {
    this.state.mode = mode;
    cx.notify();
    cx.spawn(async () => { await this.control({ subtype: "set_permission_mode", mode }); });
  }

  stop(cx) {
    cx.spawn(async () => { await this.control({ subtype: "interrupt" }); });
  }

  item(t, item, index) {
    switch (item.kind) {
      case "user":
        // The copy button shows on hover, over the bubble's top right corner.
        return h_flex().id(`ur-${index}`).justify_end().pt(10)
          .on_hover((hovered, cx) => { this.hovered = hovered ? index : this.hovered === index ? null : this.hovered; cx.notify(); })
          .child(div().relative().max_w(640).px(12).py(8).rounded(10).bg(t.raised).text_color(t.foreground)
            .when(Boolean(item.attachments?.length), (el) => el.child(h_flex().flex_wrap().gap(6).when(Boolean(item.text), (el) => el.mb(6))
              .children(item.attachments.map((attachment, at) => attachmentChip(t, `ua-${index}-${at}`, attachment, { y: window.mouse_position().y })))))
            .when(Boolean(item.text), (el) => el.child(TextView.markdown(`u-${index}`, item.text).selectable(true)))
            .when(this.hovered === index, (el) => el.child(div().absolute().top(-12).right(10)
              .child(this.copyButton(t, `uc-${index}`, item.text, "Copy message").bg(t.background)))));
      case "turn":
        return this.footer(t, item, index);
      case "agent":
        return div().text_color(t.foreground).child(TextView.markdown(`a-${index}`, item.text).selectable(true));
      case "thinking": case "call": case "failure":
        return this.entry(t, item, index);
      case "stopped":
        return h_flex().child(div().px(8).py(3).rounded(5).border(1).border_color(t.border)
          .font_family(t.typography?.mono ?? "Menlo").text_size(11).text_color(t.muted).child("INTERRUPTED BY USER"));
      case "error":
        return div().text_size(12).text_color(t.blocked).child(item.text);
      case "plan":
        return this.plan(t, item);
    }
    return div();
  }

  copy(key, text, cx) {
    this.copied = key;
    cx.notify();
    cx.spawn(async (cx) => {
      await exec("sh", ["-c", 'printf "%s" "$1" | pbcopy', "x", text]);
      await cx.sleep(1500);
      if (this.copied === key) { this.copied = null; cx.notify(); }
    });
  }

  iconButton(t, id, icon, open = false) {
    return div().id(id).size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
      .when(open, (el) => el.bg(t.hover).text_color(t.foreground))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .child(svg(icon).size(14));
  }

  copyButton(t, id, text, label) {
    const done = this.copied === id;
    return this.iconButton(t, id, done ? "mods/workspace-chrome/check.svg" : "mods/conductr-chat/copy.svg")
      .tooltip(done ? "Copied" : label).on_click((_e, cx) => this.copy(id, text, cx));
  }

  // Under a finished turn: how long it took and when, copy the final message, and more actions.
  footer(t, item, index) {
    const end = item.at ? new Date(item.at * 1000) : null;
    const start = end && new Date(end.getTime() - item.duration);
    const model = this.state.models.find((candidate) => candidate.value !== "default" && candidate.resolvedModel === item.model)?.displayName
      ?? item.model ?? "Claude";
    const line = (label, value) => h_flex().justify_between().gap(24).child(div().text_color(t.muted).child(label)).child(div().child(value));
    const details = v_flex().mb(6).w(300).p(12).gap(6).rounded(8).border_1().border_color(t.border).bg(t.popover).text_size(12)
      .text_color(t.foreground)
      .child(div().font_semibold().child(`${model} via Claude Code`))
      .when(Boolean(start), (el) => el.child(div().child(`${day(start)} → ${day(end)}`)))
      .child(line("Fast mode", item.fast === "on" ? "On" : "Off"))
      .child(div().h(1).bg(t.border).my(2))
      .child(line("Input", count(item.tokens.input)))
      .child(line("Output", count(item.tokens.output)))
      .child(line("Cache read", count(item.tokens.read)))
      .child(line("Cache write", count(item.tokens.write)));
    const when = HoverCard.new(`tw-${index}`).anchor("bottom_left").open_delay(300)
      .trigger(div().px(4).py(2).rounded(5).text_size(12).text_color(t.dim).hover((s) => s.bg(t.hover))
        .child(end ? `${took(item.duration)} · ${clock(end)}` : took(item.duration)))
      .content(details);
    const key = `ta-${index}`;
    const action = (id, icon, label, onClick) => h_flex().id(id).h(30).px(8).gap(8).items_center().rounded(6).text_size(12.5)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick)
      .child(svg(icon).size(14).text_color(t.muted)).child(label);
    const more = Popover.new(key).anchor("top_left").open(this.actions === key)
      .on_open_change((open, cx) => { this.actions = open ? key : null; cx.notify(); })
      .trigger(this.iconButton(t, `${key}-more`, "mods/conductr-chat/more.svg", this.actions === key).tooltip("More actions"))
      .content(v_flex().mt(4).p(4).rounded(8).border_1().border_color(t.border).bg(t.popover)
        .child(action(`${key}-fork`, "mods/conductr-chat/fork.svg", "Fork to new tab", (_e, cx) => {
          this.actions = null;
          this.fork(item, false, cx);
          cx.notify();
        }))
        .child(action(`${key}-tree`, "mods/workspace-chrome/git-branch.svg", "Fork to new worktree", (_e, cx) => {
          this.actions = null;
          this.fork(item, true, cx);
          cx.notify();
        })));
    return h_flex().mt(-6).gap(2).items_center().ml(-4)
      .child(when)
      .child(this.copyButton(t, `tc-${index}`, item.text, "Copy final message"))
      .child(more);
  }

  // A new chat that continues from the end of this turn on a copy of the session: in a tab of this
  // space, or as the first tab of a new worktree's space (the worktree dialog asks for its branch).
  // ponytail: a worktree dialog closed without one leaves the prepared chat folder behind.
  fork(item, worktree, cx) {
    const mods = `${appHome()}/mods/conductr-chat`;
    const at = [this.dir, String(item.line), item.uuid ?? ""];
    const space = focused()?.space ?? "";
    if (!worktree) return exec("sh", [`${mods}/new.sh`, space, this.cwd, ...at]);
    cx.spawn(async () => {
      const dir = (await exec("sh", [`${mods}/prepare.sh`, ...at])).stdout.trim();
      if (dir) openOverlay({ mod: "conductr-worktree", kind: "dialog", width: 440, height: 260,
        props: { space, action: "new", tab: "Chat", argv: ["sh", `${mods}/run.sh`, dir] } });
    });
  }

  planOf(ask) {
    return ask.tool === "ExitPlanMode" && this.state.items.some((item) => item.kind === "plan" && item.id === ask.toolUseId);
  }

  // A plan stays where Claude proposed it; its buttons show while Claude waits on it.
  plan(t, item) {
    const ask = this.waiting().find((candidate) => candidate.toolUseId === item.id);
    if (ask) return card(t, ask, this.picks, {
      answer: (response, cx) => this.answer(ask, response, cx),
      feedback: () => this.composer.box.value().trim(),
      notify: (cx) => cx.notify(),
    });
    const status = { approved: "Plan approved", revised: "Plan, revised below" }[item.outcome] ?? "Plan";
    const body = v_flex().max_h(420).overflow_y_scrollbar().id(`plan-${item.id}`)
      .child(TextView.markdown(`pm-${item.id}`, item.plan).selectable(true));
    return frame(t, t.border, status, body, []);
  }

  // A row of a turn's work: thinking, a tool call or a failed call. The icon turns into + on hover
  // and − while open; open shows the thinking, or the command and its output.
  entry(t, item, index) {
    const key = `e-${index}`;
    const open = Boolean(this.open[key]);
    const failure = item.kind === "failure";
    const thinking = item.kind === "thinking";
    const icon = open ? "mods/workspace-chrome/minus.svg" : this.hoverRow === key ? "mods/workspace-chrome/plus.svg"
      : thinking ? "mods/conductr-chat/brain.svg" : failure ? "mods/conductr-chat/error.svg"
        : item.name === "Bash" ? "mods/conductr-pane/terminal.svg"
          : ["Grep", "Glob", "WebSearch"].includes(item.name) ? "mods/workspace-chrome/search.svg" : "mods/conductr-files/file.svg";
    const title = thinking ? "Thinking" : failure ? "Error" : item.title;
    const detail = thinking || failure ? item.text.split("\n").find((line) => line.trim()) ?? "" : this.relative(item.detail);
    const mono = failure || item.mono;
    const output = item.kind === "call" ? this.state.results[item.id] : null;
    const row = h_flex().id(key).h(30).px(6).gap(8).items_center().rounded(6).cursor_pointer()
      .when(open || this.hoverRow === key, (el) => el.bg(t.hover))
      .on_hover((hovered, cx) => { this.hoverRow = hovered ? key : this.hoverRow === key ? null : this.hoverRow; cx.notify(); })
      .on_click((_e, cx) => { this.open[key] = !open; cx.notify(); })
      .child(svg(icon).size(14).flex_none().text_color(failure ? t.blocked : t.muted))
      .child(div().flex_none().text_color(failure ? t.blocked : t.foreground).child(title))
      .when(Boolean(detail) && !open, (el) => el.child(div().min_w(0).max_w(520).truncate().px(6).py(1).rounded(5)
        .bg(t.raised).text_size(12).text_color(failure ? t.blocked : t.muted)
        .when(Boolean(mono), (el) => el.font_family(t.typography?.mono ?? "Menlo")).child(detail)));
    const body = thinking || failure ? div().pl(28).text_color(t.muted).child(TextView.markdown(`${key}-text`, item.text).selectable(true))
      : v_flex().ml(6).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface).text_size(12)
        .child(TextView.markdown(`${key}-code`, "```\n" + (item.detail ? `> ${item.detail}\n` : "")
          + (output ?? "").slice(0, 6000) + "\n```").selectable(true));
    return v_flex().gap(4).child(row).when(open, (el) => el.child(body));
  }

  relative(path) {
    return this.cwd && path?.startsWith(`${this.cwd}/`) ? path.slice(this.cwd.length + 1) : path ?? "";
  }

  // A finished turn's work before its final message folds into one row once it is longer than this.
  group(t, work, key) {
    const open = Boolean(this.open[key]);
    const calls = work.filter((entry) => entry.item.kind === "call").length;
    const messages = work.filter((entry) => entry.item.kind === "thinking" || entry.item.kind === "agent").length;
    const label = [calls && `${calls} tool call${calls === 1 ? "" : "s"}`, messages && `${messages} message${messages === 1 ? "" : "s"}`]
      .filter(Boolean).join(", ");
    const shell = work.some((entry) => entry.item.name === "Bash");
    return v_flex().gap(4)
      .child(h_flex().id(key).gap(6).items_center().py(2).cursor_pointer().text_color(this.hoverRow === key || open ? t.foreground : t.muted)
        .on_hover((hovered, cx) => { this.hoverRow = hovered ? key : this.hoverRow === key ? null : this.hoverRow; cx.notify(); })
        .on_click((_e, cx) => { this.open[key] = !open; cx.notify(); })
        .child(svg(`mods/workspace-chrome/${open ? "chevron-down" : "chevron-right"}.svg`).size(13))
        .child(label)
        .when(shell, (el) => el.child(svg("mods/conductr-pane/terminal.svg").size(13))))
      .when(open, (el) => el.children(work.map((entry) => this.item(t, entry.item, entry.index))));
  }

  // Each finished turn's work (between its message and its final reply) that is long enough to fold.
  groups(items) {
    const folded = new Map();
    let from = -1;
    items.forEach((item, index) => {
      if (item.kind === "user") from = index;
      if (item.kind !== "turn" || from < 0) return;
      let last = index - 1;
      while (last > from && items[last].kind !== "agent") last--;
      const work = [];
      for (let at = from + 1; at < (last > from ? last : index); at++) work.push({ item: items[at], index: at });
      if (work.length > 3 && work.every((entry) => ["thinking", "call", "failure", "agent"].includes(entry.item.kind))) {
        folded.set(work[0].index, work);
      }
      from = -1;
    });
    return folded;
  }


  render(cx) {
    if (this.create) return this.create.render(cx);
    const t = theme();
    const state = this.state;
    const composer = this.composer;
    const asks = state.asks.filter((ask) => !this.answered.has(ask.id));
    const busy = this.busy();
    const start = Math.max(0, state.items.length - SHOWN);
    const folded = this.groups(state.items);
    const hidden = new Set([...folded.values()].flatMap((work) => work.map((entry) => entry.index)));
    const rows = [];
    for (let index = start; index < state.items.length; index++) {
      if (folded.has(index)) rows.push(this.group(t, folded.get(index), `g-${index}`));
      else if (!hidden.has(index)) rows.push(this.item(t, state.items[index], index));
    }
    this.sent.forEach((item, index) => rows.push(this.item(t, item, `sent-${index}`)));
    for (const ask of asks.filter((ask) => !this.planOf(ask))) {
      rows.push(card(t, ask, this.picks, {
        answer: (response, cx) => this.answer(ask, response, cx),
        feedback: () => this.composer.box.value().trim(),
        notify: (cx) => cx.notify(),
      }));
    }
    if (busy && !asks.length) rows.push(h_flex().gap(6).items_center().text_size(12).text_color(t.dim)
      .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)).child("Working…"));
    if (!rows.length) {
      const folder = (this.cwd ?? "").split("/").filter(Boolean).pop() ?? "~";
      rows.push(div().text_size(13).text_color(t.muted).child(`New chat in /${folder}.`));
    }
    rows.push(div().h(1));
    this.bottom = rows.length - 1;

    const timeline = v_flex().id("timeline").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll)
      .px(24).py(16).gap(12).text_size(13)
      .on_scroll_wheel((event, cx) => { if (event.delta.y > 0 && this.pinned) { this.pinned = false; cx.notify(); } })
      // One wrapper per row, so scroll_to_item still counts rows.
      .children(rows.map((row) => div().w_full().max_w(COLUMN - 24).mx_auto().child(row)));

    return v_flex().id("root").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .key_context("ConductrChatPane").track_focus(this.paneFocus)
      .on_action("chat-focus", (_e, cx) => { composer.box.focus(); cx.notify(); })
      .on_action("chat-cancel", (_e, cx) => { if (this.busy()) this.stop(cx); })
      .on_drop((event, cx) => composer.drop(event.paths ?? [], cx))
      .child(timeline)
      .when(!this.pinned, (el) => el.child(h_flex().justify_center().pb(4).child(
        div().id("jump").px(10).py(3).rounded(10).bg(t.raised).text_size(11).text_color(t.muted).child("Jump to latest")
          .on_click((_e, cx) => { this.pinned = true; this.scroll.scroll_to_item(this.bottom); cx.notify(); }))))
      .when(Boolean(composer.menu), (el) => el.child(div().px(12).mb(4).child(composer.menuView(t).w_full().max_w(COLUMN).mx_auto())))
      .child(div().px(12).pb(12).child(composer.view(t, { hint: "⌘L to focus", error: this.error }).max_w(COLUMN).mx_auto()));
  }
}
