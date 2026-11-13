// Asks before something destructive, e.g. "Discard file changes?". Opened as a dialog with props
// { title, detail, action?, danger?, command: { name, args } }. detail is markdown, so a path can be `code`.
// ⌘↵ confirms (runs the command), Esc cancels.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { run, props, closeOverlay, theme } from "herdr";

export default class Confirm extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  yes() {
    const p = props();
    closeOverlay(p.overlay);
    run(p.command.name, p.command.args ?? {});
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const button = (id, children, bg, fg, border, onClick) =>
      h_flex().id(id).h(32).px(12).gap(6).items_center().rounded(8).border_1().border_color(border).bg(bg).text_color(fg).cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).children(children);
    const danger = p.danger ? t.ansi1 : t.solid;
    return v_flex()
      .id("confirm")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter" && e.modifiers.platform) this.yes();
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .px(22)
      .py(20)
      .gap(10)
      .rounded(8)
      .bg(t.popover)
      .text_size(13)
      .child(div().text_size(17).font_semibold().text_color(t.foreground).child(p.title ?? "Are you sure?"))
      .child(div().id("detail").flex_1().min_h(0).overflow_y_scrollbar().text_color(t.muted).child(TextView.markdown("detail", p.detail ?? "").text_color(t.muted)))
      .child(
        h_flex()
          .justify_end()
          .gap(8)
          .text_size(13)
          .child(button("no", ["Cancel"], t.background, t.foreground, t.input, () => closeOverlay(props().overlay)))
          .child(button("yes", [p.action ?? "Confirm", div().text_size(12).opacity(0.8).child("⌘↵")], danger, p.danger ? "#ffffff" : t.solid_foreground, danger, () => this.yes())),
      );
  }
}
