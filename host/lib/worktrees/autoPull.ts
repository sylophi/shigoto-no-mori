// Auto-pull marks: a flat set of worktree ids the user has opted into
// fast-forwarding from their upstream whenever the app fetches
// (autoPullSweep.ts does the pulling). Meant for checkouts that only
// ever follow the remote, the primary checkout above all, so it stops
// drifting behind between visits. Stored in the global registry.json
// beside the shelf for the same reason: it is a per-user, per-machine
// choice, not a property of the repo. Shared with the CLI, which seeds
// and retires marks as worktrees come and go (cli/state.go
// worktreeMarkKeys), so the app's own delete, which runs the CLI, has
// nothing to clean up.
import { AUTO_PULL_KEY } from "../config/store";
import { makeRegistryIdSet } from "./registryIdSet";

export const autoPullMarks = makeRegistryIdSet(AUTO_PULL_KEY);

export const isAutoPull = autoPullMarks.has;
export const readAutoPullSet = autoPullMarks.readSet;
export const setAutoPull = autoPullMarks.set;
export const dropAutoPull = autoPullMarks.drop;
