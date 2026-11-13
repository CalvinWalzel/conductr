// node recents.check.mjs: checks Add space's Recents.
import assert from "node:assert/strict";
import { recentRepos } from "./recents.js";

const listing = "/h/src/swarm/.git/index\n/h/src/infra/.git/index\n/h/src/stings/qa/.git/index\n";
assert.deepEqual(recentRepos(listing, new Set(["/h/src/swarm"])), ["/h/src/infra", "/h/src/stings/qa"]);
assert.deepEqual(recentRepos(listing, new Set(), 2), ["/h/src/swarm", "/h/src/infra"]);
assert.deepEqual(recentRepos("", new Set()), []);
console.log("recents ok");
