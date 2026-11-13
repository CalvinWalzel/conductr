// A popup of the CPU and memory that Herdr and everything running in it use, opened from the
// memory pill in conductr-chrome. Rows are Herdr's own processes, then each space's terminals with
// their process trees. The header buttons hide the terminals, drop the space groups, flatten
// the trees and copy the table.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, exec, appHome, spaces, panes, terminals } from "herdr";

const EVERY = 2000;
const LIMIT = 9;
const ROW = 28;
const LIST = 440;
const ROOTS = ["Herdr", "herdr-core"];

const formatMemory = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const formatCpu = (percent) => `${percent.toFixed(1)}%`;

const flatten = (node) => node.process ? [{ ...node, children: [] }, ...node.children.flatMap(flatten)] : node.children.flatMap(flatten);

// A group (Herdr, a space) or a terminal adds up every process under it; a process shows its own use.
const total = (node) => node.process ? node : flatten(node).reduce(
  (sum, process) => ({ cpu: sum.cpu + process.cpu, memory: sum.memory + process.memory }), { cpu: 0, memory: 0 });

export default class ConductrResources extends View {
  init(_props, cx) {
    this.sampler = `${appHome()}/mods/conductr-resources/sample.py`;
    this.previous = null;
    this.processes = null;
    this.terminalPids = new Map();
    this.collapsed = new Set();
    this.terminalsShown = true;
    this.grouped = true;
    this.tree = true;
    this.sort = "memory";
    this.showAll = false;
    // A slow sample (the first one asks every terminal for its pid) must not overlap the next.
    const refresh = (cx) => {
      if (this.busy) return;
      this.busy = true;
      cx.spawn(async (cx) => {
        try { await this.refresh(); this.error = null; } catch (error) { this.error = String(error); }
        this.busy = false;
        cx.notify();
      });
    };
    // CPU is use since the last sample, so take a second one soon after the first.
    refresh(cx);
    cx.timer.after(500, refresh);
    cx.timer.every(EVERY, refresh);
  }

  async refresh() {
    await this.findTerminalPids();
    const r = await exec("/usr/bin/python3", ["-I", this.sampler, ...ROOTS]);
    if (r.code !== 0) throw new Error(r.stderr.trim());
    const sample = JSON.parse(r.stdout);
    const before = new Map((this.previous?.processes ?? []).map((row) => [row[0], row[4]]));
    const elapsed = this.previous ? sample.now - this.previous.now : 0;
    this.processes = sample.processes.map(([pid, ppid, name, args, cpuTime, memory]) => ({
      pid, ppid, name, args, memory,
      cpu: elapsed > 0 && before.has(pid) ? Math.max(0, (cpuTime - before.get(pid)) / elapsed * 100) : 0,
    }));
    this.previous = sample;
  }

  // terminals() has no pids; `hc get` does. A terminal keeps its pid, so each is asked once.
  async findTerminalPids() {
    const missing = terminals().filter((terminal) =>
      !terminal.address.includes("/") && terminal.state === "live" && !this.terminalPids.has(terminal.address));
    await Promise.all(missing.map(async (terminal) => {
      const got = await exec("hc", ["get", terminal.address, "--json"]).catch(() => null);
      const pid = got?.code === 0 ? JSON.parse(got.stdout).pid : null;
      if (pid) this.terminalPids.set(terminal.address, pid);
    }));
  }

  model() {
    const byPid = new Map(this.processes.map((process) => [process.pid, { ...process, process: true, id: `p${process.pid}`, label: process.name, children: [] }]));
    for (const node of byPid.values()) byPid.get(node.ppid)?.children.push(node);

    const tabs = new Map(spaces().flatMap((space) => space.tabs.map((tab) => [tab.id, { space, tab }])));
    const paneOf = new Map(panes().filter((pane) => pane.terminal).map((pane) => [pane.terminal, pane]));
    const terminalNodes = new Map();
    for (const terminal of terminals()) {
      const shell = byPid.get(this.terminalPids.get(terminal.address));
      if (!shell) continue;
      const place = tabs.get(terminal.labels?.["herdr.tab"]);
      const tabName = place ? (place.tab.named ? place.tab.name : `Tab ${place.tab.name}`) : terminal.name ?? terminal.address;
      const program = paneOf.get(terminal.address)?.program;
      terminalNodes.set(shell.pid, {
        id: `t${terminal.address}`, label: program?.name && !program.shell ? `${tabName} · ${program.name}` : tabName,
        space: place?.space, children: [shell],
      });
    }

    // Herdr's own processes keep their trees, minus the terminals, which go to their spaces.
    const strip = (node) => ({ ...node, children: node.children.filter((child) => !terminalNodes.has(child.pid)).map(strip) });
    const herdrRoots = [...byPid.values()].filter((node) => !byPid.has(node.ppid)).map(strip);
    const groups = [{ id: "gherdr", label: "Herdr", children: herdrRoots }];
    if (this.terminalsShown) {
      for (const space of spaces()) {
        const children = [...terminalNodes.values()].filter((node) => node.space?.id === space.id);
        if (children.length) groups.push({ id: `g${space.id}`, label: space.name, children });
      }
      const loose = [...terminalNodes.values()].filter((node) => !node.space);
      if (loose.length) groups.push({ id: "gother", label: "Other terminals", children: loose });
    }

    let top = groups;
    if (!this.tree) top = top.map((group) => ({ ...group, children: flatten(group) }));
    if (!this.grouped) top = top.flatMap((group) => group.children);
    return { top, totals: total({ children: groups }) };
  }

  sorted(nodes) {
    const key = this.sort;
    return [...nodes].sort((a, b) => total(b)[key] - total(a)[key]);
  }

  rows(nodes, depth = 0, out = []) {
    for (const node of this.sorted(nodes)) {
      const open = !this.collapsed.has(node.id);
      out.push({ node, depth, open, folding: !node.process });
      if (open) this.rows(node.children, depth + 1, out);
    }
    return out;
  }

  copy(cx, top, totals) {
    const lines = [`CPU ${formatCpu(totals.cpu)}  Memory ${formatMemory(totals.memory)}`, "", "Name\tCPU\tMem"];
    const walk = (nodes, depth) => {
      for (const node of this.sorted(nodes)) {
        const sum = total(node);
        lines.push(`${"  ".repeat(depth)}${node.label}\t${formatCpu(sum.cpu)}\t${formatMemory(sum.memory)}`);
        walk(node.children, depth + 1);
      }
    };
    walk(top, 0);
    cx.write_to_clipboard(lines.join("\n"));
    this.copied = true;
    cx.notify();
    cx.timer.after(1500, (cx) => { this.copied = false; cx.notify(); });
  }

  tool(id, icon, tip, active, action) {
    const t = theme();
    return div().id(id).size(26).flex().items_center().justify_center().rounded(6).cursor_pointer().tooltip(tip)
      .text_color(active ? t.foreground : t.dim).when(active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(action).child(svg(`mods/conductr-resources/${icon}.svg`).size(15));
  }

  heading(id, label, key) {
    const t = theme();
    const active = this.sort === key;
    return h_flex().id(id).w(key === "cpu" ? 72 : 96).flex_none().justify_end().gap(3).cursor_pointer()
      .text_color(active ? t.foreground : t.dim).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.sort = key; cx.notify(); })
      .child(label).when(active, (el) => el.child(svg("mods/conductr-resources/chevron-down.svg").size(12)));
  }

  row({ node, depth, open, folding }) {
    const t = theme();
    const sum = total(node);
    const strong = folding && depth === 0;
    return h_flex().id(`row-${node.id}`).h(ROW).flex_none().px(14).items_center().rounded(6).text_size(13)
      .hover((s) => s.bg(t.hover))
      .when(folding, (el) => el.cursor_pointer().on_click((_e, cx) => {
        if (this.collapsed.has(node.id)) this.collapsed.delete(node.id); else this.collapsed.add(node.id);
        cx.notify();
      }))
      .when(Boolean(node.args), (el) => el.tooltip(node.args))
      .child(h_flex().flex_1().min_w(0).gap(4).items_center().pl(depth * 14)
        .child(div().w(12).flex_none().text_color(t.muted)
          .when(folding, (el) => el.child(svg(`mods/conductr-resources/chevron-${open ? "down" : "right"}.svg`).size(12))))
        .child(div().truncate().text_color(t.foreground).when(strong, (el) => el.font_semibold()).child(node.label)))
      .child(div().w(72).flex_none().text_right().text_color(sum.cpu >= 0.05 ? t.foreground : t.dim).child(formatCpu(sum.cpu)))
      .child(div().w(96).flex_none().text_right().text_color(t.muted).child(formatMemory(sum.memory)));
  }

  render() {
    const t = theme();
    const panel = v_flex().w_full().bg(t.popover).border_1().border_color(t.border).rounded(10).shadow_md().overflow_hidden();
    if (!this.processes) {
      return panel.p(16).text_size(13).text_color(t.muted).child(this.error ? `Couldn't read processes: ${this.error}` : "Measuring…");
    }
    const { top, totals } = this.model();
    const rows = this.rows(top);
    const shown = this.showAll ? rows : rows.slice(0, LIMIT);
    return panel
      .child(v_flex().px(16).pt(14).pb(12).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().items_center().justify_between()
          .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("RESOURCES"))
          .child(h_flex().gap(2)
            .child(this.tool("terminals", "terminal", this.terminalsShown ? "Hide terminal processes" : "Include terminal processes", this.terminalsShown,
              (_e, cx) => { this.terminalsShown = !this.terminalsShown; cx.notify(); }))
            .child(this.tool("group", "layers", this.grouped ? "Ungroup processes" : "Group processes", this.grouped,
              (_e, cx) => { this.grouped = !this.grouped; cx.notify(); }))
            .child(this.tool("tree", "tree", this.tree ? "Switch to flat view" : "Switch to tree view", this.tree,
              (_e, cx) => { this.tree = !this.tree; cx.notify(); }))
            .child(this.tool("copy", "copy", this.copied ? "Copied" : "Copy resource usage", Boolean(this.copied),
              (_e, cx) => this.copy(cx, top, totals)))))
        .child(h_flex().gap(5).text_size(14).items_baseline()
          .child(div().text_color(t.muted).child("CPU")).child(div().text_color(t.foreground).child(formatCpu(totals.cpu)))
          .child(div().ml(4).text_color(t.muted).child("Memory")).child(div().text_color(t.foreground).child(formatMemory(totals.memory)))))
      .child(h_flex().h(30).px(14).items_center().text_size(12.5).text_color(t.dim)
        .child(div().flex_1().pl(16).child("Name"))
        .child(this.heading("sort-cpu", "CPU", "cpu"))
        .child(this.heading("sort-memory", "Mem", "memory")))
      // A fixed height: with only max_h the list grows to fit its rows, the panel clips it and nothing scrolls.
      .child(v_flex().id("rows").flex_none().h(Math.min(shown.length * ROW + 4, LIST)).overflow_y_scrollbar().px(2).pb(4).children(shown.map((row) => this.row(row))))
      .when(rows.length > LIMIT, (el) => el.child(h_flex().id("show-all").h(34).justify_center().items_center().border_t(1).border_color(t.border)
        .text_size(12.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.showAll = !this.showAll; cx.notify(); })
        .child(this.showAll ? "Show less" : `Show all (${rows.length})`)));
  }
}
