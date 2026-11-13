// node files.check.mjs: checks the @ menu's ranking.
import assert from "node:assert/strict";
import { entry, rankFiles } from "./files.js";

const paths = ["app/", "app/controllers/", "app/controllers/api/", "app/controllers/api/v2/", "app/controllers/api/v2/users/",
  "app/controllers/api/v2/users_controller.rb", "app/controllers/api/v2/users/password_controller.rb",
  "app/controllers/api/v2/abuse_reports_controller.rb", "client/src/apple.ts", "README.md"];
const top = (query) => rankFiles(paths, query).map((result) => result.path);
assert.equal(top("app/controlleruserscontroller")[0], "app/controllers/api/v2/users_controller.rb");
assert.equal(top("app/controlleruserscontroller")[1], "app/controllers/api/v2/users/password_controller.rb");
assert.equal(top("users_controller")[0], "app/controllers/api/v2/users_controller.rb");
assert.equal(top("app")[0], "app/");
assert.deepEqual(top(""), ["app/", "README.md"]);
assert.deepEqual(rankFiles(paths, "readme")[0].hits, [0, 1, 2, 3, 4, 5]);
assert.deepEqual(entry("app/views/app/"), { path: "app/views/app/", dir: true, name: "app", folder: "app/views/" });
console.log("files ok");
