// node search.mjs <list> <query>: the best @ menu matches in the list (one path per line), as JSON.
import { readFileSync } from "node:fs";
import { rankFiles } from "./files.js";

const [list, query = ""] = process.argv.slice(2);
process.stdout.write(JSON.stringify(rankFiles(readFileSync(list, "utf8").split("\n").filter(Boolean), query)));
