// What crosses the wire between two builds is versioned in parts
// (README.md, "Wire samples"). The core is what any link needs: the
// hello and the byte channels (modules/link.ts), the frame encoding,
// the failure union (errors.ts) and the hub's wire (hubProtocol.ts).
// Two builds link only on the same core, and the hub's floor is it.
// Every other module another build calls names a version of its own
// (defineContract), and a call into one the two builds hold at
// different versions is refused alone (link.ts, outdatedCall).
export const CORE_VERSION = 21;

// A mirror runs on sync's calls (its follower takes the bundles sync
// receives), so the two change as one.
export const MIRROR_VERSION = 1;
