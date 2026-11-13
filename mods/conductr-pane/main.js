// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "conductr-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, shared, terminals, exec } from "herdr";

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// A conductr-chat tab: the chat pane over its hidden backend terminal pane (conductr-chat/run.sh <dir>).
function chatTab(p) {
  const mine = panes().filter((q) => q.tab === p.tab);
  const chat = mine.find((q) => q.mod === "conductr-chat");
  for (const backend of mine) {
    const argv = backend.terminal ? terminals().find((t) => t.address === backend.terminal)?.argv ?? [] : [];
    if (chat && argv.some((arg) => arg.endsWith("-chat/run.sh"))) return { chat, backend, dir: argv[argv.length - 1] };
  }
  return null;
}

// The same session in Claude's own terminal UI: run.sh stops the headless Claude on Ctrl+C and resumes it there.
async function toTerminal({ chat, backend, dir }) {
  await exec("touch", [`${dir}/to-terminal`]);
  await exec("hc", ["keys", backend.terminal, "ctrl+c"]);
  if (chat.zoomed) run("pane.zoom", { pane: chat.pane });
  run("pane.zoom", { pane: backend.pane });
  run("pane.focus", { pane: backend.pane });
}

// Back: leaving the terminal UI makes run.sh resume headless.
async function toChat({ chat, backend, dir }) {
  if ((await exec("test", ["-f", `${dir}/tui`])).code === 0) await exec("hc", ["send", backend.terminal, "/exit"]);
  if (backend.zoomed) run("pane.zoom", { pane: backend.pane });
  run("pane.zoom", { pane: chat.pane });
  run("pane.focus", { pane: chat.pane });
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  // `command` is a command name with its args, or a function to call.
  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        typeof command === "function" ? command() : run(command, args);
      })
      .child(svg(`mods/conductr-pane/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    // A conductr-viewer pane shows its file: the name, then the folder it's in.
    const viewed = p.mod === "conductr-viewer" ? shared("conductr-viewer")?.[p.tab]?.file : null;
    // A chat pane shows its backend's agent, folder and status.
    const chat = chatTab(p);
    const shown = p.mod === "conductr-chat" && chat ? chat.backend : p;
    const name = viewed ? viewed.split("/").pop()
      : ((shown.program?.agent || shown.program?.shell) && shown.program.name) || (shown === p ? p.title : "") || shown.program?.name || "shell";
    const where = viewed ? folder(viewed.slice(0, viewed.lastIndexOf("/"))) : folder(shown.cwd);
    const pic = icon(shown.program, 14, t.dim);
    const st = shown.status;
    const pane = p.pane;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(where))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered && Boolean(chat), el => el.child(p.mod === "conductr-chat"
        ? this.button(t, `ph-t-${pane}`, "terminal", () => toTerminal(chat))
        : this.button(t, `ph-c-${pane}`, "chat", () => toChat(chat))))
      .when(this.hovered && Boolean(chat), el => el.child(this.button(t, `ph-x-${pane}`, "close", "tab.close", { id: p.tab })))
      .when(this.hovered && !chat, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
