// node diff.check.mjs: diff rows are numbered right and long unchanged stretches fold.
import assert from "node:assert/strict";
import { diffRows, fold } from "./diff.js";

const context = (from, count) => Array.from({ length: count }, (_, index) => ` line ${from + index}`);
// 10 unchanged, 1 changed, 12 unchanged, 1 added, 10 unchanged.
const lines = ["@@ -1,33 +1,33 @@", ...context(1, 10), "-old 11", "+new 11", ...context(12, 12), "+added 24", ...context(25, 10)];
const rows = diffRows(lines).filter((row) => row.kind !== "@");
assert.deepEqual(rows.slice(10, 12).map((row) => [row.kind, row.number]), [["-", 11], ["+", 11]]);
assert.equal(rows.at(-1).number, 34);

const shown = (open = new Set()) => fold(rows, open).map((row) => (row.kind === "fold" ? `fold:${row.count}` : `${row.kind}${row.number}`));
// The first stretch keeps 3 lines before the change, the middle 3 on each side, the last 3 after.
assert.deepEqual(shown(), ["fold:7", " 8", " 9", " 10", "-11", "+11", " 12", " 13", " 14", "fold:6", " 21", " 22", " 23", "+24", " 25", " 26", " 27", "fold:7"]);
// Opening a fold (by its first line number) shows that stretch whole.
assert.equal(shown(new Set([12])).filter((row) => row.startsWith("fold")).length, 2);
// A stretch that would hide a single line stays open.
assert.deepEqual(fold(diffRows(["@@ -1,8 +1,8 @@", "+a", ...context(2, 7), "+b"]), new Set()).filter((row) => row.kind === "fold"), []);
console.log("diff ok");
