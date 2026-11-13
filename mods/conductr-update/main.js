// The Conductr update dialog: what changed in each release since this checkout's, from the
// changelog/<version>.md of each newer release, with Install (⌘↵) and Cancel (Esc). conductr-chrome finds the
// releases and installs; this only shows shared("conductr-chrome.update"):
//   { from: "v0.1.0" | null, to: "v0.3.0", notes: [{ version, date, blocks }] }, newest first, where a
//   block is { text } (markdown) or { image, width, height } (a path under Herdr's folder)
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, TextView, Scrollbar } from "gpui-base";
import { run, props, closeOverlay, theme, shared } from "herdr";

const UPDATE = "conductr-chrome.update";
// The release list's width inside the dialog: wider images shrink to it.
const WIDE = 500;

export default class Update extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  install() {
    closeOverlay(props().overlay);
    run("conductr-chrome.update");
  }

  render() {
    const t = theme();
    const update = shared(UPDATE);
    const button = (id, children, primary, onClick) => h_flex().id(id).h(32).px(12).gap(6).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.background).text_color(primary ? t.solid_foreground : t.foreground)
      .cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).children(children);
    const block = (version) => (b, index) => b.image
      ? image(b.image).w(Math.min(b.width, WIDE)).h(Math.min(b.width, WIDE) * b.height / b.width).rounded(8).my(4)
      : TextView.markdown(`release-${version}-${index}`, b.text).text_size(13).text_color(t.muted);
    const release = ({ version, date, blocks }) => v_flex().gap(8).pb(18)
      .child(h_flex().gap(8).items_baseline()
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child(version))
        .when(Boolean(date), (el) => el.child(div().text_size(12).text_color(t.dim).child(date))))
      .children(blocks?.length ? blocks.map(block(version)) : [div().text_size(13).text_color(t.dim).child("No notes.")]);
    const from = update?.from?.replace(/^v/, "");
    return v_flex().id("conductr-update").size_full().min_h(0).px(22).pt(20).pb(18).gap(14).rounded(8).bg(t.popover).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter" && e.modifiers.platform && update) this.install();
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation();
      })
      .child(v_flex().gap(4)
        .child(div().text_size(17).font_semibold().text_color(t.foreground).child("Conductr update"))
        .child(div().text_size(12.5).text_color(t.muted).child(!update ? "Conductr is up to date."
          : `${from ? `${from} → ` : ""}${update.to.replace(/^v/, "")}`)))
      .child(div().relative().flex_1().min_h(0).border_t(1).border_b(1).border_color(t.border)
        .child(v_flex().id("releases").size_full().overflow_y_scroll().pt(14).pr(16)
          .children((update?.notes ?? []).map(release)))
        .child(Scrollbar.vertical("releases").mode("always").absolute().inset_0()))
      .child(h_flex().justify_end().gap(8)
        .child(button("cancel", ["Cancel"], false, () => closeOverlay(props().overlay)))
        .when(Boolean(update), (el) => el.child(button("install", ["Install", div().text_size(12).opacity(0.8).child("⌘↵")], true, () => this.install()))));
  }
}
