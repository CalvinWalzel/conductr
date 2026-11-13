// The @ menu's ranking: fuzzy matches over paths (folders end in "/"), scored like fzf: matches in a
// row, at word starts and in the file name count most. search.mjs runs it in node; QuickJS is too slow.

const LIMIT = 50;
const BOUNDARY = "/_-. ";

export function entry(path) {
  const dir = path.endsWith("/");
  const trimmed = dir ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf("/") + 1;
  return { path, dir, name: trimmed.slice(cut), folder: trimmed.slice(0, cut) };
}

// Positions of the query's letters in text, taken earliest-first or latest-first.
function positions(text, query, fromEnd) {
  const found = [];
  if (fromEnd) {
    let at = query.length - 1;
    for (let index = text.length - 1; index >= 0 && at >= 0; index--) if (text[index] === query[at]) { found.unshift(index); at--; }
    return at < 0 ? found : null;
  }
  let at = 0;
  for (let index = 0; index < text.length && at < query.length; index++) if (text[index] === query[at]) { found.push(index); at++; }
  return at === query.length ? found : null;
}

function score(text, hits, nameStart) {
  let total = 0;
  hits.forEach((index, order) => {
    total += 1;
    if (order > 0 && hits[order - 1] === index - 1) total += 4;
    if (index === 0 || BOUNDARY.includes(text[index - 1])) total += 3;
    if (index >= nameStart) total += 1;
  });
  return total;
}

export function match(path, query) {
  const text = path.toLowerCase();
  const q = query.toLowerCase();
  const nameStart = text.replace(/\/$/, "").lastIndexOf("/") + 1;
  let best = null;
  for (const fromEnd of [false, true]) {
    const hits = positions(text, q, fromEnd);
    if (!hits) return null;
    const value = score(text, hits, nameStart);
    if (!best || value > best.score) best = { score: value, hits };
  }
  return best;
}

export function rankFiles(paths, query) {
  const q = query.replace(/^\//, "");
  if (!q) {
    return paths.filter((path) => !path.replace(/\/$/, "").includes("/"))
      .sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b))
      .slice(0, LIMIT).map((path) => ({ path, hits: [] }));
  }
  const scored = [];
  for (const path of paths) {
    const found = match(path, q);
    if (found) scored.push({ path, hits: found.hits, score: found.score });
  }
  return scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length).slice(0, LIMIT)
    .map(({ path, hits }) => ({ path, hits }));
}
