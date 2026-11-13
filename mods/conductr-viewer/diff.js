// Turns `git diff` output into numbered rows and folds long unchanged stretches.

// Text draws a tab as nothing: pad each to the next 4-column stop.
export const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Unchanged lines kept next to each change; longer unchanged stretches fold into one row.
export const CONTEXT = 3;

// The rows to draw: each unchanged stretch longer than the context around it becomes one fold
// row, unless it is in `open` (by its first line number). The file's first and last stretches
// keep context only on their changed side.
export function fold(rows, open) {
  const out = [];
  for (let start = 0; start < rows.length; ) {
    if (rows[start].kind !== " ") { out.push(rows[start++]); continue; }
    let end = start;
    while (end < rows.length && rows[end].kind === " ") end++;
    const before = start === 0 ? 0 : CONTEXT, after = end === rows.length ? 0 : CONTEXT, hidden = end - start - before - after;
    const id = rows[start].number;
    if (hidden > 1 && !open.has(id)) out.push(...rows.slice(start, start + before), { kind: "fold", count: hidden, id }, ...rows.slice(end - after, end));
    else out.push(...rows.slice(start, end));
    start = end;
  }
  return out;
}

// Numbers each diff line once, so a frame only draws the rows on screen.
export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}
