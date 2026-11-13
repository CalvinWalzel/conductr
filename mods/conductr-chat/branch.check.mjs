// node branch.check.mjs: checks the Create screen's branch names.
import assert from "node:assert/strict";
import { branchBase, freeBranch } from "./branch.js";

assert.equal(branchBase("Fix the login bug on Safari, please!", "calvin/"), "calvin/fix-the-login-bug-on-safari");
assert.equal(branchBase("", "calvin/"), "calvin/work");
assert.equal(branchBase("¿¡ !!", "calvin/"), "calvin/work");
assert.equal(branchBase("a".repeat(30) + " " + "b".repeat(30), ""), "a".repeat(30) + "-" + "b".repeat(9));
assert.equal(branchBase("trailing word-break " + "x".repeat(19) + " y", "").endsWith("-"), false);
const taken = new Set(["calvin/work", "calvin/work-2"]);
assert.equal(await freeBranch("calvin/work", async (name) => taken.has(name)), "calvin/work-3");
assert.equal(await freeBranch("calvin/new", async (name) => taken.has(name)), "calvin/new");
console.log("branch ok");
