// node selection.check.mjs: character selection maps pointers to columns, cuts tokens and copies.
import assert from "node:assert/strict";
import { column, order, rowRange, selectedText, selectAll } from "./selection.js";

assert.equal(column(-5, 6.6, 10), 0);
assert.equal(column(20, 6.6, 10), 3);
assert.equal(column(500, 6.6, 10), 10);

const rows = [{ kind: "+", text: "def call" }, { kind: "fold", count: 9 }, { kind: " ", text: " " }, { kind: "-", text: "  end" }];
// Dragging upwards orders the ends the same way.
const up = { anchor: { row: 3, column: 3 }, head: { row: 0, column: 4 } };
assert.deepEqual(order(up).from, { row: 0, column: 4 });
assert.deepEqual(rowRange(up, 0, 8), { start: 4, end: 9 });
assert.deepEqual(rowRange(up, 3, 5), { start: 0, end: 3 });
assert.equal(rowRange(up, 4, 5), null);
assert.equal(selectedText(rows, up), "call\n\n  e");
assert.equal(selectedText(rows, selectAll(rows)), "def call\n\n  end");
assert.equal(rowRange({ anchor: { row: 0, column: 2 }, head: { row: 0, column: 2 } }, 0, 8), null);

console.log("selection ok");
