// Auto-pull marks: a flat set of worktree ids the user has opted into
// fast-forwarding from their upstream whenever the app fetches
// (autoPullSweep.ts does the pulling). Meant for checkouts that only
// ever follow the remote, the primary checkout above all, so it stops
// drifting behind between visits. Stored in the global registry.json
// beside the shelf for the same reason: it is a per-user, per-machine
// choice, not a property of the repo. App-only: the CLI preserves the
// key without reading it, so the app drops the mark on its own delete
// and a mark left by an `sm rm` in a terminal matches nothing.
import { AUTO_PULL_KEY } from "../config/store";
import { makeRegistryIdSet } from "./registryIdSet";

export const autoPullMarks = makeRegistryIdSet(AUTO_PULL_KEY);

export const isAutoPull = autoPullMarks.has;
export const readAutoPullSet = autoPullMarks.readSet;
export const setAutoPull = autoPullMarks.set;
export const dropAutoPull = autoPullMarks.drop;
