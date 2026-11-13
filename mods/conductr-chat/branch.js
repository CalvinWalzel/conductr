// A new worktree's branch from the Create screen's message: its first words, else "work".
export function branchBase(message, prefix) {
  const words = message.toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 6).join("-").slice(0, 40).replace(/-+$/, "");
  return prefix + (words || "work");
}

// The first of base, base-2, base-3, … that `taken` says is free.
export async function freeBranch(base, taken) {
  let branch = base;
  for (let n = 2; await taken(branch); n++) branch = `${base}-${n}`;
  return branch;
}
