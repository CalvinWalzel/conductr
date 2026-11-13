// node repo-key.check.mjs: checks the repo key and that every mod's copy of repo-key.js is the same.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoKey } from "./repo-key.js";

assert.equal(repoKey(null, "/Users/me/src/swarm/.git"), '[null,"/Users/me/src/swarm/.git"]');
assert.equal(repoKey(undefined, "/r/.git"), repoKey(null, "/r/.git"));
assert.equal(repoKey("vps", "/r/.git"), '["vps","/r/.git"]');
const mine = readFileSync(new URL("./repo-key.js", import.meta.url), "utf8");
for (const mod of ["conductr-menu", "conductr-chat", "conductr-worktree", "conductr-settings"]) {
  assert.equal(readFileSync(new URL(`../${mod}/repo-key.js`, import.meta.url), "utf8"), mine, `${mod}/repo-key.js differs`);
}
console.log("repo-key ok");
