// A repo's key in shared state (conductr-settings' icons and scripts, conductr-spaces' git info): the
// machine it is on (null: this computer) and its absolute git common dir, so every checkout of a
// repo shares one key. Each mod that needs it has a copy; conductr-spaces/repo-key.check.mjs keeps
// the copies the same.
export const repoKey = (machine, commonDir) => JSON.stringify([machine ?? null, commonDir]);
