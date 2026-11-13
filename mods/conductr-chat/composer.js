// The message box under a chat, and the Create screen's: its `/` and `@` menus, attachments, the model
// and effort menu, plan mode and the send button. The host says what it is attached to:
// { dir(), cwd(), state() (events.js' models, model, effort, mode, commands), busy(), send(cx),
//   stop(cx), setMode(mode, cx), escape?(cx), placeholder }.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, Scrollbar, TextareaState, Textarea, Popover, HoverCard } from "gpui-base";
import { exec, appHome } from "herdr";
import { entry } from "./files.js";
import { messageParts, attachmentName } from "./parts.js";

const MENU_SIZE = 50;
const ROW = 26;
const SHOWN_ROWS = 12;
// Prefers Homebrew's node over a version manager's shim, which starts slowly.
const NODE = 'n=/opt/homebrew/bin/node; [ -x "$n" ] || n=node; exec "$n" "$@"';
// The folder's files, and each folder above one ("app/views/"), one per line.
const LIST = 'git ls-files -co --exclude-standard | awk \'{ print; n = split($0, p, "/"); s = ""; '
  + 'for (i = 1; i < n; i++) { s = s p[i] "/"; if (!(s in seen)) { seen[s] = 1; print s } } }\' > "$1.new" && mv "$1.new" "$1"';
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const EFFORT_NAMES = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
// The textarea's own bindings (Enter, arrows, Tab) run before any on_key_down, so these keys are
// bound over them, in a context that only the composer's textarea is in. A later binding wins.
const KEYS = ["up", "down", "tab", "enter", "escape", "shift-tab", "cmd-/", "cmd-shift-/", "left", "right", "cmd-u"];
const EFFORT_ROW = { effort: true };

// Best matches first: a prefix, then a substring, then the letters in order.
function rank(items, query, text) {
  const q = query.toLowerCase();
  const scored = [];
  for (const item of items) {
    const name = text(item).toLowerCase();
    let score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : -1;
    if (score < 0) {
      let at = 0;
      for (const letter of q) { at = name.indexOf(letter, at) + 1; if (!at) break; }
      score = at ? 2 : -1;
    }
    if (score >= 0) scored.push([score, name.length, item]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, MENU_SIZE).map((entry) => entry[2]);
}

// The text in runs, marking the given positions of a longer string that starts `offset` before it.
function runsAt(text, offset, hits) {
  const runs = [];
  for (let index = 0; index < text.length; index++) {
    const hit = hits.has(offset + index);
    const last = runs[runs.length - 1];
    if (last?.hit === hit) last.text += text[index];
    else runs.push({ text: text[index], hit });
  }
  return runs;
}

// The text in runs, marking what the query matched: the substring, else its letters in order.
function marks(text, query) {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const hits = new Array(text.length).fill(false);
  const at = q ? lower.indexOf(q) : -1;
  if (at >= 0) hits.fill(true, at, at + q.length);
  else {
    let from = 0;
    for (const letter of q) {
      const index = lower.indexOf(letter, from);
      if (index < 0) break;
      hits[index] = true;
      from = index + 1;
    }
  }
  const runs = [];
  for (let index = 0; index < text.length; index++) {
    const last = runs[runs.length - 1];
    if (last?.hit === hits[index]) last.text += text[index];
    else runs.push({ text: text[index], hit: hits[index] });
  }
  return runs;
}

// An attachment's chip ({ image, path, name }): an icon and the name. With `remove`, the icon turns
// into an × that removes it while `hovered`; without, a click opens the file in its own app. An image's chip shows the image on hover, on the side
// of `y` (the chip's place in the window) with more room, and fits there: a card that does not fit
// is pushed back into the window, over the chip. Its height is set, as an image has none until it loads.
export function attachmentChip(t, id, attachment, { hovered = false, remove, y = 0 } = {}) {
  const removing = hovered && Boolean(remove);
  const icon = removing ? "mods/workspace-chrome/x.svg" : `mods/conductr-settings/lucide/${attachment.image ? "file-image" : "file"}.svg`;
  const chip = h_flex().id(id).h(22).items_center().rounded(6).border(1).border_color(t.border).text_size(12)
    .child(div().id(`${id}-icon`).w(22).h_full().flex().items_center().justify_center()
      .child(svg(icon).size(13).text_color(removing ? t.foreground : attachment.image ? t.ansi2 : t.dim))
      .when(Boolean(remove), (el) => el.cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); remove(cx); })))
    .child(div().w(1).h_full().bg(t.border))
    .child(div().px(6).text_color(t.foreground).child(attachment.name))
    .when(!remove && Boolean(attachment.path), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => { exec("open", [attachment.path]); }));
  if (!attachment.image || !attachment.path?.startsWith(`${appHome()}/`)) return chip;
  const above = y;
  const below = window.viewport_size().height - y - 22;
  const height = Math.max(80, Math.min(240, Math.max(above, below) - 24));
  return HoverCard.new(`${id}-preview`).anchor(above > below ? "bottom_left" : "top_left").open_delay(200).trigger(chip)
    .content(div().when(above > below, (el) => el.mb(6)).when(above <= below, (el) => el.mt(6)).p(4).rounded(8).border(1)
      .border_color(t.border).bg(t.popover)
      .child(image(attachment.path.slice(appHome().length + 1)).w(320).h(height).rounded(6)));
}

export class Composer {
  constructor(cx, host) {
    this.host = host;
    this.attached = 0;
    this.menu = null;
    this.menuScroll = ScrollHandle.new();
    this.searches = 0;
    // A model or effort picked here applies from the next message on, so it waits here.
    this.pending = {};
    cx.bind_keys(KEYS.map((keystroke, index) => ({ keystroke, action: `chat-key-${index}`, context: "ConductrChat > Input" })));
    this.box = TextareaState.new({ placeholder: host.placeholder });
    this.box.set_auto_grow(4, 12);
    this.box.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.box.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.box.on("change", (_e, cx) => this.typed(cx));
    this.box.on("paste_other", (_e, cx) => this.paste(cx));
  }

  // The message. `parts` is the text and images in order (parts.js); `text` has every chip's text
  // inline: an image's path, a file's @path.
  message() {
    return { parts: messageParts(this.box.content()), text: this.box.value().trim(), pending: this.pending };
  }

  clear() {
    this.box.set_value("");
    this.menu = null;
    this.pending = {};
  }

  take() {
    const message = this.message();
    this.clear();
    return message;
  }

  // Lists the files again on the next `@`, as for a new folder.
  relist() {
    this.listedAt = 0;
    this.listing = null;
  }

  cycleMode(cx) {
    this.host.setMode(this.host.state().mode === "plan" ? "auto" : "plan", cx);
  }

  // The latest models by alias (opus, sonnet, ...); the current one is matched by its full name.
  models() {
    return this.host.state().models.filter((model) => model.value !== "default" && !model.value.startsWith("claude-"));
  }

  current() {
    const state = this.host.state();
    return this.pending.model ?? state.models.find((model) => model.value !== "default" && model.resolvedModel === state.model);
  }

  effort() {
    return this.pending.effort ?? this.host.state().effort;
  }

  efforts() {
    return this.current()?.supportedEffortLevels ?? EFFORTS;
  }

  setModel(model, cx) {
    this.pending.model = model.resolvedModel === this.host.state().model ? undefined : model;
    cx.notify();
  }

  setEffort(effort, cx) {
    this.pending.effort = effort === this.host.state().effort ? undefined : effort;
    cx.notify();
  }

  cycleEffort(cx) {
    const efforts = this.efforts();
    this.setEffort(efforts[(efforts.indexOf(this.effort()) + 1) % efforts.length], cx);
  }

  // The `/` menu while the message is a command name; the `@` menu while the last word starts with @.
  typed(cx) {
    const text = this.box.value();
    const command = text.match(/^\/(\S*)$/);
    const file = text.match(/(^|\s)@(\S*)$/);
    const search = ++this.searches;
    if (command) {
      const items = rank(this.host.state().commands, command[1], (item) => item.name);
      const query = command[1];
      this.menu = items.length ? { items, index: 0, label: (item) => `/${item.name}`,
        about: (item) => (item.description ?? "").split("\n")[0],
        runs: (item) => query && { label: marks(`/${item.name}`, query) },
        choose: (item, cx) => this.insert(0, `/${item.name} `, cx) } : null;
    } else if (file) {
      // Ranked in node: QuickJS is too slow for a whole repository. The menu keeps its last
      // results until the new ones arrive; results for older text are dropped.
      if (this.menu && !this.menu.files) this.menu = null;
      this.findFiles(file[2], text.length - file[2].length - 1, search, cx);
    } else this.menu = null;
    if (this.menu && !file) this.menuScroll.scroll_to_item(0);
    cx.notify();
  }

  listFiles() {
    const fresh = this.listedAt && Date.now() - this.listedAt < 60000;
    if (!fresh) {
      this.listedAt = Date.now();
      const listing = exec("sh", ["-c", LIST, "x", `${this.host.dir()}/files.txt`], { cwd: this.host.cwd() });
      // Only the first list is waited for; later ones refresh it behind the scenes.
      this.listing ??= listing;
    }
    return this.listing;
  }

  findFiles(query, start, search, cx) {
    cx.spawn(async (cx) => {
      await this.listFiles();
      const found = await exec("sh", ["-c", NODE, "x", `${appHome()}/mods/conductr-chat/search.mjs`, `${this.host.dir()}/files.txt`, query]);
      if (search !== this.searches) return;
      let results = [];
      try { results = JSON.parse(found.stdout); } catch { /* no results */ }
      const items = results.map((result) => ({ ...entry(result.path), hits: new Set(result.hits) }));
      this.menu = items.length ? { files: true, items, index: 0, label: (item) => item.name, about: (item) => item.folder,
        runs: (item) => ({ label: runsAt(item.name, item.folder.length, item.hits), about: runsAt(item.folder, 0, item.hits) }),
        icon: (item) => (item.dir ? "mods/conductr-files/folder.svg" : "mods/conductr-files/file.svg"),
        choose: (item, cx) => this.insert(start, `@${item.path} `, cx) } : null;
      this.menuScroll.scroll_to_item(0);
      cx.notify();
    });
  }

  // Replaces the text from `start` to the end, keeping the chips before it.
  insert(start, text, cx) {
    this.box.set_selected_range({ start, end: this.box.value().length });
    this.box.replace(text);
    this.menu = null;
    this.box.focus();
    cx.notify();
  }

  pick(item, cx) {
    const menu = this.menu;
    if (item === EFFORT_ROW) menu.sub = { index: Math.max(0, this.efforts().indexOf(this.effort())) };
    else {
      this.menu = null;
      menu.choose(item, cx);
    }
    cx.notify();
  }

  modelMenu() {
    const models = this.models();
    const current = this.current();
    const items = this.current()?.supportsEffort === false ? models : [...models, EFFORT_ROW];
    this.menu = this.menu?.kind === "models" || !models.length ? null : { kind: "models", width: 200, items,
      index: Math.max(0, models.indexOf(current)),
      label: (item) => (item === EFFORT_ROW ? "Effort" : item.displayName),
      about: (item) => (item === EFFORT_ROW ? EFFORT_NAMES[this.effort()] ?? "" : ""),
      check: (item) => item === this.current(),
      choose: (model, cx) => this.setModel(model, cx),
      hint: "⌘⇧/  Cycle effort" };
    this.box.focus();
  }

  // A menu opened from a chip closes on a press outside it; that press may be on the chip itself.
  dismiss(cx) {
    this.dismissed = { kind: this.menu?.kind, at: Date.now() };
    this.menu = null;
    cx.notify();
  }

  toggle(kind, open, cx) {
    const dismissed = this.dismissed;
    this.dismissed = null;
    if (dismissed?.kind !== kind || Date.now() - dismissed.at > 500) open();
    cx.notify();
  }

  // A key bound over the textarea; cx.propagate() hands it back to the textarea.
  key(stroke, cx) {
    const menu = this.menu;
    const sub = menu?.sub;
    const efforts = this.efforts();
    if (sub && (stroke === "up" || stroke === "down")) {
      sub.index = (sub.index + (stroke === "up" ? -1 : 1) + efforts.length) % efforts.length;
    } else if (sub && (stroke === "tab" || stroke === "enter")) {
      this.setEffort(efforts[sub.index], cx);
      this.menu = null;
    } else if (sub && (stroke === "escape" || stroke === "left")) {
      menu.sub = null;
    } else if (menu && stroke === "right" && menu.items[menu.index] === EFFORT_ROW) {
      this.pick(EFFORT_ROW, cx);
    } else if (menu && (stroke === "up" || stroke === "down")) {
      menu.index = (menu.index + (stroke === "up" ? -1 : 1) + menu.items.length) % menu.items.length;
      this.menuScroll.scroll_to_item(menu.index);
    } else if (menu && (stroke === "tab" || stroke === "enter")) {
      this.pick(menu.items[menu.index], cx);
    } else if (menu && stroke === "escape") {
      this.menu = null;
    } else if (stroke === "shift-tab") {
      this.cycleMode(cx);
    } else if (stroke === "cmd-/") {
      this.modelMenu();
    } else if (stroke === "left" || stroke === "right") {
      return cx.propagate();
    } else if (stroke === "cmd-shift-/") {
      this.cycleEffort(cx);
    } else if (stroke === "cmd-u") {
      this.chooseFile(cx);
    } else if (stroke === "enter") {
      this.host.send(cx);
    } else if (stroke === "escape" && this.host.busy()) {
      this.host.stop(cx);
    } else if (stroke === "escape" && this.host.escape) {
      this.host.escape(cx);
    } else return cx.propagate();
    cx.notify();
  }

  // A chip at the cursor. An image is copied into the chat's folder first, so it outlives the
  // original; its chip's text is the copy's path. Any other file's chip is its @path.
  attach(path, cx) {
    const label = path.split("/").pop();
    if (!IMAGE.test(path)) return this.chip({ id: `file-${++this.attached}`, text: `@${path}`, label }, cx);
    cx.spawn(async (cx) => {
      const copy = `${this.host.dir()}/attached-${Date.now()}-${label}`;
      if ((await exec("cp", [path, copy])).code === 0) this.chip({ id: `img-${++this.attached}`, text: copy, label }, cx);
    });
  }

  // A space follows the chip, so the words around it stay apart.
  chip(token, cx) {
    this.box.replace_with_token(token);
    this.box.replace(" ");
    this.box.focus();
    cx.notify();
  }

  remove(id, cx) {
    const span = this.box.tokens().find((span) => span.token.id === id);
    if (!span) return;
    this.box.set_selected_range(span.range);
    this.box.replace("");
    this.hovered = null;
    cx.notify();
  }

  paste(cx) {
    cx.spawn(async (cx) => {
      const path = `${this.host.dir()}/pasted-${Date.now()}.png`;
      const saved = await exec("osascript", ["-l", "JavaScript", `${appHome()}/mods/conductr-chat/paste-image.jxa`, path]);
      if (saved.stdout.trim()) this.chip({ id: `img-${++this.attached}`, text: path, label: attachmentName(path) }, cx);
    });
  }

  // The system's file picker.
  chooseFile(cx) {
    cx.spawn(async (cx) => {
      const picked = await exec("osascript", ["-e", 'POSIX path of (choose file with prompt "Add attachment")']).catch(() => null);
      const path = picked?.code === 0 ? picked.stdout.trim() : "";
      if (path) this.attach(path, cx);
    });
  }

  drop(paths, cx) {
    for (const path of paths) this.attach(path, cx);
    this.box.focus();
    cx.notify();
  }

  // A chip: its icon, which turns into an × to remove it while hovered, and its name. An image's
  // chip shows the image on hover.
  chipView(t, span) {
    const { id, text, label } = span.token;
    return attachmentChip(t, `chip-${id}`, { image: id.startsWith("img-"), path: text, name: label ?? text },
      { hovered: this.hovered === id, remove: (cx) => this.remove(id, cx), y: this.hoveredAt?.y });
  }

  menuView(t) {
    const menu = this.menu;
    const panel = (el) => el.p(4).rounded(8).border(1).border_color(t.border).bg(t.popover);
    const row = (id, selected, onClick) => h_flex().id(id).gap(10).px(8).py(4).rounded(5).text_size(12).items_center()
      .when(selected, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click(onClick);
    const check = svg("mods/workspace-chrome/check.svg").size(12).text_color(t.foreground);
    const marked = (runs, text, base) => (!runs ? div().text_color(base).child(text)
      : h_flex().children(runs.map((run) => div().text_color(run.hit ? t.foreground : base).child(run.text))));
    // A list that scrolls needs a set height; one that only has a maximum grows past it and is clipped.
    const scrolls = !menu.width;
    // Rows end before the bar, which always shows when there is more to scroll to.
    const more = scrolls && menu.items.length > SHOWN_ROWS;
    const list = v_flex()
      .when(scrolls, (el) => el.id("menu-rows").size_full().overflow_y_scroll().track_scroll(this.menuScroll))
      .when(more, (el) => el.pr(12))
      .children(menu.items.map((item, index) => {
        const runs = menu.runs?.(item);
        const effort = item === EFFORT_ROW;
        const line = row(`m-${index}`, index === menu.index || (effort && Boolean(menu.sub)), (_e, cx) => this.pick(item, cx))
          .on_hover((hovered, cx) => {
            if (!hovered || !menu.width) return;
            menu.index = index;
            if (effort) this.pick(item, cx); else menu.sub = null;
            cx.notify();
          })
          .when(Boolean(menu.icon), (el) => el.child(svg(menu.icon(item)).size(13).flex_none().text_color(t.dim)))
          .when(scrolls, (el) => el.h(ROW).py(0).rounded(0).px(12))
          .child(marked(runs?.label, menu.label(item), runs?.label ? t.dim : t.foreground).flex_none())
          .when(Boolean(runs?.about), (el) => el.child(marked(runs.about, "", t.dim).min_w(0).overflow_hidden()))
          .when(!runs?.about, (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).when(effort, (el) => el.text_right()).child(menu.about(item))))
          .when(effort, (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(12).text_color(t.dim)))
          .when(Boolean(menu.check?.(item)), (el) => el.child(check));
        return effort ? v_flex().mt(4).pt(4).border_t(1).border_color(t.border).child(line) : line;
      }));
    const rows = !scrolls ? list : v_flex().relative().h(Math.min(menu.items.length, SHOWN_ROWS) * ROW).child(list)
      .when(more, (el) => el.child(div().absolute().top(0).bottom(0).right(3).w(6).opacity(0.6)
        .child(Scrollbar.vertical("menu-rows").mode("always").size_full())));
    // GPUI clips to the box, not its rounded corners, so the rows stay clear of them.
    const main = panel(v_flex()).when(scrolls, (el) => el.px(0).py(4).overflow_hidden())
      .when(Boolean(menu.width), (el) => el.w(menu.width)).child(rows)
      .when(Boolean(menu.hint), (el) => el.child(div().px(8).pt(6).pb(2).text_size(11).text_color(t.dim).child(menu.hint)));
    const efforts = this.efforts();
    const sub = menu.sub && panel(v_flex()).w(160).mb(menu.hint ? 22 : 0).children(efforts.map((effort, index) =>
      row(`e-${effort}`, index === menu.sub.index, (_e, cx) => { this.setEffort(effort, cx); this.menu = null; cx.notify(); })
        .child(div().flex_1().text_color(t.foreground).child(EFFORT_NAMES[effort]))
        .when(effort === this.effort(), (el) => el.child(check))));
    return h_flex().id("menu").items_end().gap(4)
      .when(Boolean(menu.width), (el) => el.on_mouse_down_out((_e, cx) => this.dismiss(cx)))
      .child(main.when(!menu.width, (el) => el.flex_1().min_w(0).overflow_hidden()))
      .when(Boolean(sub), (el) => el.child(sub));
  }

  // The box. `options`: { action (the button at its end; default: send, or stop while busy),
  // hint (shown at its top right while it doesn't have the keyboard), error, claude (false: no
  // model or plan mode controls), disabled (no typing) }.
  view(t, options = {}) {
    const state = this.host.state();
    const busy = this.host.busy();
    const claude = options.claude !== false;
    const model = this.current();
    const picker = h_flex().id("model").gap(6).px(8).py(3).rounded(6).items_center().text_size(12)
      .when(this.menu?.kind === "models", (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
      .tooltip("Change model  ⌘/")
      .child(div().text_color(t.foreground).child(model?.displayName ?? state.model ?? "Starting…"))
      .when(Boolean(model?.supportsEffort && this.effort()), (el) => el.child(div().text_color(t.dim).child(EFFORT_NAMES[this.effort()] ?? this.effort())))
      .child(svg("mods/workspace-chrome/chevron-down.svg").size(12).text_color(t.dim))
      .on_click((_e, cx) => this.toggle("models", () => this.modelMenu(), cx));
    const planning = claude && state.mode === "plan";
    // The + menu: plan mode (Exit plan mode, in the accent color, while on) and attachments.
    const option = (id, icon, label, keys, on, onClick) => h_flex().id(id).h(32).px(8).gap(10).items_center().rounded(7).text_size(13)
      .cursor_pointer().text_color(on ? t.accent : t.foreground).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.plus = false; onClick(cx); cx.notify(); })
      .child(svg(icon).size(15).text_color(on ? t.accent : t.muted))
      .child(div().flex_1().child(label))
      .child(div().text_size(12).text_color(t.dim).child(keys));
    const plus = Popover.new("plus").anchor("bottom_right").open(Boolean(this.plus))
      .on_open_change((open, cx) => { this.plus = open; cx.notify(); })
      .trigger(div().id("plus").size(28).flex().items_center().justify_center().rounded(6).cursor_pointer()
        .text_color(t.muted).when(Boolean(this.plus), (el) => el.bg(t.hover).text_color(t.foreground))
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .child(svg("mods/workspace-chrome/plus.svg").size(15)))
      .content(v_flex().mb(6).w(230).p(4).rounded(10).border_1().border_color(t.border).bg(t.popover)
        .when(claude, (el) => el.child(option("plus-plan", "mods/conductr-settings/lucide/map.svg", planning ? "Exit plan mode" : "Plan mode", "⇧Tab", planning, (cx) => this.cycleMode(cx))))
        .child(option("plus-attach", "mods/conductr-settings/lucide/paperclip.svg", "Add attachment", "⌘U", false, (cx) => this.chooseFile(cx))));
    // Stop while Claude works; otherwise send, dim until there is something to send.
    const ready = Boolean(this.box.value().trim());
    const action = options.action ?? div().id("action").size(28).flex().items_center().justify_center().rounded(6)
      .bg(busy || ready ? t.foreground : t.raised).text_color(busy || ready ? t.background : t.dim)
      .when(busy || ready, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)))
      .when(busy || ready, (el) => el.tooltip(busy ? "Cancel  ⌘⇧⌫" : "Send message  ↵"))
      .child(svg(`mods/conductr-chat/${busy ? "stop" : "arrow-up"}.svg`).size(16))
      // On press: the view redraws with every event while Claude works.
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        if (this.host.busy()) this.host.stop(cx); else this.host.send(cx);
      });

    // Plan mode tints the composer and lays fading diagonal stripes over its top, as Conductor does.
    return v_flex().id("composer").relative().w_full().p(8).gap(6).rounded(10).border(1)
      .border_color(t.input).bg(planning ? t.raised : t.background).overflow_hidden()
      .when(planning, (el) => el.child(svg("mods/conductr-chat/stripes.svg").absolute().top(1).left(1).w(1000).h(120)
        .text_color(t.accent).opacity(0.07)))
      .when(Boolean(options.hint) && !this.typing, (el) => el.child(div().absolute().top(10).right(12).text_size(11).text_color(t.dim).child(options.hint)))
      .child(KEYS.reduce((el, keystroke, index) => el.on_action(`chat-key-${index}`, (_e, cx) => this.key(keystroke, cx)),
        div().key_context("ConductrChat").child(Textarea.new(this.box).text_size(13).disabled(Boolean(options.disabled))
          .token((span) => this.chipView(t, span))
          .on_token_hover((event, cx) => {
            this.hovered = event.hovered ? event.token.id : this.hovered === event.token.id ? null : this.hovered;
            if (event.hovered) this.hoveredAt = event.bounds;
            cx.notify();
          }))))
      .child(h_flex().gap(2).items_center()
        .when(claude, (el) => el.child(picker))
        .when(Boolean(options.error), (el) => el.child(div().text_size(11).text_color(t.blocked).truncate().child(options.error)))
        .child(div().flex_1())
        .child(plus)
        .child(div().w(4))
        .child(action));
  }
}
