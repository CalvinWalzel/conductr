// One image as large as fits in its overlay, keeping its shape: a click anywhere or Esc closes it.
// Opened as a frameless dialog with props { image, width, height } (a path under Herdr's folder and
// its size in pixels).
import { View, div, image } from "gpui-kit";
import { props, closeOverlay } from "herdr";

export default class Image extends View {
  init(_props, cx) {
    this.size = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  render() {
    const { image: path, width, height } = props() ?? {};
    const close = () => closeOverlay(props().overlay);
    const scale = this.size ? Math.min(this.size.width / width, this.size.height / height, 1) : 0;
    return div().id("conductr-image").size_full().flex().items_center().justify_center().cursor_pointer()
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_click(close)
      .when(scale > 0, (el) => el.child(image(path).w(width * scale).h(height * scale).rounded(10)));
  }
}
