// Add space's Recents: `ls -dt …/.git/index` lines (newest first) as repo folders, without the repos
// already open (their folders) and at most `limit` of them.
export function recentRepos(listing, open, limit = 7) {
  return listing.split("\n").filter(Boolean).map((index) => index.replace(/\/\.git\/index$/, ""))
    .filter((folder) => !open.has(folder)).slice(0, limit);
}
