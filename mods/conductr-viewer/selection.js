// Character selection in the diff: a selection is { anchor, head }, each { row, column }, with
// rows indexing the shown rows and columns counting characters. The diff font is monospace, so a
// pointer's x becomes a column by dividing by one character's width.

const blank = (row) => (row.text === " " ? "" : row.text);

// The pointer's column in a line of `length` characters, from its x past the text's start.
export function column(x, characterWidth, length) {
  return Math.max(0, Math.min(length, Math.round(x / characterWidth)));
}

// The selection with its earlier end first.
export function order({ anchor, head }) {
  const headFirst = head.row < anchor.row || (head.row === anchor.row && head.column < anchor.column);
  return headFirst ? { from: head, to: anchor } : { from: anchor, to: head };
}

// The selected columns of one row, [start, end), or null. An end past the line's length means the
// selection runs on past the line break.
export function rowRange(selection, index, length) {
  if (!selection) return null;
  const { from, to } = order(selection);
  if (index < from.row || index > to.row) return null;
  const start = index === from.row ? from.column : 0;
  const end = index === to.row ? to.column : length + 1;
  return end > start ? { start, end } : null;
}

// What ⌘C copies: the selected part of each line, fold rows left out.
export function selectedText(rows, selection) {
  const { from, to } = order(selection);
  const lines = [];
  for (let index = from.row; index <= to.row; index++) {
    const row = rows[index];
    if (!row || row.kind === "fold") continue;
    const text = blank(row);
    lines.push(text.slice(index === from.row ? from.column : 0, index === to.row ? to.column : text.length));
  }
  return lines.join("\n");
}

// Everything, from the first line's start to the last line's end.
export function selectAll(rows) {
  const last = rows.length - 1;
  return { anchor: { row: 0, column: 0 }, head: { row: last, column: blank(rows[last] ?? { text: "" }).length } };
}
