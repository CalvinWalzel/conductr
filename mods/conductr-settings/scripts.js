// The [scripts] table's setup and archive in a repo's .conductor/settings.toml. conductr-settings has
// a copy; scripts.check.mjs keeps the two the same.
// ponytail: single-line strings only, a TOML parser if multi-line scripts show up.
export function repoScripts(text) {
  const found = {};
  let inScripts = false;
  for (const line of (text ?? "").split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) { inScripts = header[1].trim() === "scripts"; continue; }
    const entry = inScripts && line.match(/^\s*(setup|archive)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/);
    if (!entry) continue;
    try { found[entry[1]] = entry[2][0] === "'" ? entry[2].slice(1, -1) : JSON.parse(entry[2]); } catch {}
  }
  return found;
}
