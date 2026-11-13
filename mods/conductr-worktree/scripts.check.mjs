// node scripts.check.mjs: checks reading setup and archive scripts, and that conductr-settings' copy is the same.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoScripts } from "./scripts.js";

const toml = `[env]
setup = "not this one"

[scripts]
setup = "bin/setup && echo \\"done\\""
archive = 'rm -rf tmp'
run = "ignored"

[other]
archive = "not this one"`;
assert.deepEqual(repoScripts(toml), { setup: 'bin/setup && echo "done"', archive: "rm -rf tmp" });
assert.deepEqual(repoScripts(null), {});
assert.deepEqual(repoScripts("[scripts]\nsetup = \"unclosed"), {});
const mine = readFileSync(new URL("./scripts.js", import.meta.url), "utf8");
assert.equal(readFileSync(new URL("../conductr-settings/scripts.js", import.meta.url), "utf8"), mine, "conductr-settings/scripts.js differs");
console.log("scripts ok");
