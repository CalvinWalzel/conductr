// A read-only file viewer pane, one per tab. The Files and Source Control panels say what it shows:
// shared("conductr-viewer")[props().tab] = { file, on, diff? }, so a new click reuses this pane.
// With diff ({ root, path, head, fresh }) it shows the whole file with its uncommitted changes
// marked, long unchanged stretches folded (click to open) and syntax colored (highlight.js).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Scrollbar, v_virtual_list } from "gpui-base";
import { props, shared, exec, readTextFile, theme, settings, nextCommand, openOverlay } from "herdr";
import { tokens, colors, languageOf } from "./highlight.js";
import { diffRows, fold } from "./diff.js";
import { column, rowRange, selectedText, selectAll } from "./selection.js";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
// Reads write nothing under .git, so the Source Control folder watch stays quiet.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

const MAX_LINES = 20000;
// Up to this many rows are drawn as plain rows, which take handlers: drag selects lines. Longer
// diffs use a virtual list, whose rows can't (click and shift-click still select).
const PLAIN_ROWS = 1500;
// Where a line's text starts in its row: the 4px bar, 36px gutter, 2px break and 10px padding.
const TEXT_START = 52;

async function diffLines({ file, on, diff: { root, path, head, fresh } }) {
  if (fresh) {
    const text = await readTextFile(file, { on }).catch(() => null);
    if (text === null) return ["Cannot preview this file (binary, too large, or unreadable)"];
    if (text.includes("\0")) return ["Binary file · no text diff"];
    const lines = text.slice(0, 400000).replace(/\n$/, "").split("\n");
    return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
  }
  const r = await exec("git", [...READ, "diff", ...(head ? ["HEAD"] : []), "--unified=999999", "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
  if (r.code !== 0) throw new Error(r.stderr);
  const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((line) => line.startsWith("@@"));
  return first < 0 ? [r.stdout.includes("Binary files") ? "Binary file changed" : "No changes"] : all.slice(first);
}

export default class Viewer extends View {
  init(_props, cx) {
    this.shown = null;
    this.handle = cx.focus_handle();
    // One character of the diff font, measured in render (11px JetBrains Mono until then).
    this.characterWidth = 6.6;
    // "conductr-viewer.select-all", from the diff's right-click menu (conductr-menu).
    cx.spawn(async (cx) => {
      for (;;) {
        if (await nextCommand() === "select-all" && this.rows) { this.selection = selectAll(this.rows); this.handle.focus(); cx.notify(); }
      }
    });
    // A diff follows edits to its file; the panel's own refresh only reaches its list.
    cx.timer.every(5000, (cx) => { const target = this.target(); if (target?.diff && JSON.stringify(target) === this.shown) this.loadDiff(target, cx); });
  }

  target() { return shared("conductr-viewer")?.[props()?.tab] ?? null; }

  // Text selection by character (selection.js): drag across plain rows, shift-click extends; ⌘C
  // copies, ⌘A selects all, Escape clears. By index into this.rows, so it clears whenever the rows
  // change. A virtual list's rows can't hold handlers (its renderer runs inside layout), so there a
  // click (through on_item_click) selects its whole line instead.
  click(key, cx) {
    const [kind, value] = key.split(":");
    if (kind === "fold") {
      this.open.add(Number(value));
      this.rows = fold(this.all, this.open);
      this.selection = null;
    } else {
      const index = Number(value), end = { row: index, column: this.rows[index].text.length };
      this.selection = { anchor: this.shift && this.selection ? this.selection.anchor : { row: index, column: 0 }, head: end };
    }
    this.handle.focus();
    cx.notify();
  }

  // A plain row's handlers: a fold opens on click; a line starts or extends a drag selection at
  // the character under the pointer.
  handlers(element, row, index) {
    if (row.kind === "fold") return element.id(`fold-${row.id}`).on_click((_e, cx) => this.click(`fold:${row.id}`, cx));
    const at = (event) => ({ row: index, column: column((event.local_position?.x ?? 0) - TEXT_START, this.characterWidth, row.text.length) });
    return element.id(`line-${index}`)
      .on_mouse_down("left", (event, cx) => {
        this.handle.focus();
        const point = at(event);
        this.selection = { anchor: event.modifiers.shift && this.selection ? this.selection.anchor : point, head: point };
        this.selecting = true;
        cx.notify();
      })
      .on_mouse_move((event, cx) => {
        if (!this.selecting) return;
        const point = at(event);
        if (point.row === this.selection.head.row && point.column === this.selection.head.column) return;
        this.selection.head = point;
        cx.notify();
      });
  }

  rowKey(index) {
    const row = this.rows[index];
    return row.kind === "fold" ? `fold:${row.id}` : `line:${index}`;
  }
  copySelection(cx) {
    if (this.selection) cx.write_to_clipboard(selectedText(this.rows, this.selection));
  }

  keys(event, cx) {
    if (event.modifiers.platform && event.key === "c") this.copySelection(cx);
    else if (event.modifiers.platform && event.key === "a") this.selection = selectAll(this.rows);
    else if (event.key === "escape") this.selection = null;
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  load(target, cx) {
    this.code?.release();
    this.code = null;
    this.rows = null;
    this.diffText = null;
    this.open = new Set();
    this.selection = null;
    this.error = null;
    const key = this.shown = JSON.stringify(target);
    if (!target) return;
    if (target.diff) return this.loadDiff(target, cx);
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(target.file, { on: target.on });
        if (key !== this.shown) return;
        if (text === null) { this.error = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.error = "Binary file · no text preview"; return; }
        const t = theme(), ext = target.file.includes(".") ? target.file.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch {
        if (key === this.shown) this.error = "Cannot preview this file (binary, too large, or unreadable)";
      } finally { cx.notify(); }
    });
  }

  loadDiff(target, cx) {
    const key = JSON.stringify(target);
    cx.spawn(async (cx) => {
      try {
        const lines = (await diffLines(target)).slice(0, MAX_LINES).map((line) => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line);
        const text = lines.join("\n");
        if (key !== this.shown || text === this.diffText) return;
        this.diffText = text;
        this.all = diffRows(lines).filter((row) => row.kind !== "@");
        this.language = languageOf(target.diff.path ?? target.file);
        this.rows = fold(this.all, this.open);
        this.selection = null;
        this.diffWidth = this.all.reduce((width, row) => Math.max(width, (row.text.length + 1) * 7 + 50), 300);
        cx.notify();
      } catch {
        if (key === this.shown && !this.rows) { this.error = "Cannot preview this diff (too large or unreadable)"; cx.notify(); }
      }
    });
  }

  diffRow(row, index, t) {
    const { kind, number, text } = row;
    if (kind === "fold") return h_flex().w_full().h(20).flex_none().items_center().bg(t.raised).text_color(t.dim)
      .cursor_pointer().hover((s) => s.text_color(t.foreground))
      .child(div().w(42).flex_none().flex().justify_center().child(svg("mods/conductr-chrome/chevron-down.svg").size(12)))
      .child(div().pl(10).child(`${row.count} unmodified lines`));
    // Added and removed lines, measured from Conductor's diff: a 4px bar, the line number on a ~11%
    // tint, a 2px untinted break, then the content on a ~16% tint.
    const tint = kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : null;
    const shade = (el, alpha) => (tint ? el.bg(tint + alpha) : el);
    return h_flex().w_full().h(20).flex_none()
      .child(div().w(4).h_full().flex_none().when(Boolean(tint), (e) => e.bg(tint)))
      .child(shade(div().w(36).h_full().pr(8).flex_none().flex().items_center().justify_end(), "1c")
        .text_color(tint ? t.foreground : t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(2).h_full().flex_none())
      .child(shade(div().flex_1().min_w(0).h_full().pl(10).flex().items_center(), "28").child(this.highlighted(row, t, rowRange(this.selection, index, row.text.length))));
  }

  // A diff line's text as colored tokens (worked out once per row). The selection is a rectangle
  // painted behind the text, so the text never re-flows while it moves; past the line break it
  // covers one more character.
  highlighted(row, t, range) {
    if (!row.kind) return div().truncate().child(row.text);
    const palette = colors(t);
    row.tokens ??= this.language ? tokens(row.text, this.language) : [{ text: row.text, kind: null }];
    const text = h_flex().whitespace_nowrap().children(row.tokens.map((token) => div().flex_none().text_color(token.kind ? palette[token.kind] : t.foreground).child(token.text)));
    const width = range ? Math.min(range.end, row.text.length + 1) - range.start : 0;
    return div().relative().h_full().flex().items_center()
      .when(width > 0, (line) => line.child(div().absolute().top(0).bottom(0).left(range.start * this.characterWidth).w(width * this.characterWidth).bg(t.selection)))
      .child(text);
  }

  render(cx) {
    const t = theme();
    const target = this.target();
    if (JSON.stringify(target) !== this.shown) this.load(target, cx);
    // The pane header (conductr-pane) shows which file this is.
    const root = v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground);
    if (!this.rows) return root.child(this.code ? Editor.new(this.code).flex_1().min_h(0)
      : div().p(12).text_size(12).text_color(t.dim).child(this.error || (target ? "Loading…" : "Click a file in the Files panel")));
    const frame = div().id("viewer-diff-root").flex_1().min_h(0).relative().track_focus(this.handle)
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "conductr-menu", kind: "popup", width: 180, props: { tab: "viewer", target: { text: this.selection ? selectedText(this.rows, this.selection) : "" } } });
      })
      .on_key_down((event, cx) => this.keys(event, cx)).on_modifiers_changed((event) => { this.shift = event.modifiers.shift; })
      .on_mouse_up("left", () => { this.selecting = false; }).font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
      // 100 characters, invisible, in the diff's font: their width gives one character's.
      .child(div().id("viewer-measure").absolute().top(0).left(0).opacity(0).whitespace_nowrap().child("0".repeat(100))
        .on_size_change((size) => { if (size.width > 0) this.characterWidth = size.width / 100; }));
    if (this.rows.length <= PLAIN_ROWS) return root.child(frame.child(div().id("viewer-diff-plain").size_full().overflow_scrollbar()
      .child(v_flex().w_full().min_w(this.diffWidth).children(this.rows.map((row, index) => this.handlers(this.diffRow(row, index, t), row, index))))));
    return root.child(frame
      .child(div().id("viewer-diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("viewer-diff", this.rows.length, 20, (index) => this.rowKey(index),
          (range) => this.rows.slice(range.start, range.end).map((row, offset) => this.diffRow(row, range.start + offset, t))).on_item_click((key, cx) => this.click(key, cx)).size_full())))
      .child(Scrollbar.vertical("viewer-diff").viewport_from_layout().absolute().inset_0()));
  }
}
