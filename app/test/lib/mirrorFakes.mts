// The mirror engine's stand-ins the mirror proofs share: a session as
// the daemon reports one (file-sync/engine.go's state line), and the
// mirror engine (host/mirror/MirrorEngine.ts) with nothing behind it, for a
// check to fill in with what it is about.
import type { MirrorSessionRaw } from "@shigomori/contracts/modules/mirror";
import * as Effect from "effect/Effect";
import type { MirrorEngine } from "../../host/mirror/MirrorEngine.ts";

type MirrorEndpoint = MirrorSessionRaw["local"];

// One end of a session: connected and scanned, holding nothing.
export const mirrorEndpoint = (
  fields: Partial<MirrorEndpoint> = {},
): MirrorEndpoint => ({
  connected: true,
  scanned: true,
  directories: 0,
  files: 0,
  symbolicLinks: 0,
  totalFileSize: 0,
  problems: [],
  excludedProblems: 0,
  ...fields,
});

// A watching session with nothing in it, named `session`, both ends
// idle, unless `fields` says otherwise.
export const rawMirrorSession = (
  fields: Pick<MirrorSessionRaw, "session"> & Partial<MirrorSessionRaw>,
): MirrorSessionRaw => ({
  name: fields.session,
  labels: {},
  localRoot: "",
  deviceId: "",
  projectId: "",
  worktreeId: "",
  remoteRoot: "",
  paused: false,
  ignores: [],
  createdAt: 0,
  status: "watching",
  statusText: "",
  successfulCycles: 0,
  conflicts: [],
  excludedConflicts: 0,
  local: mirrorEndpoint(),
  remote: mirrorEndpoint(),
  ...fields,
});

const notHere = () => Effect.die(new Error("not in this check"));

// A running daemon with no sessions, no git verdicts and no history,
// whose calls a check does not make die. `impl` replaces what the check
// is about.
export const inertMirrorImpl = (
  impl: Partial<MirrorEngine["Service"]> = {},
): MirrorEngine["Service"] => ({
  status: Effect.succeed("running"),
  failure: Effect.succeed(undefined),
  sessions: Effect.succeed([]),
  create: notHere,
  recreate: notHere,
  terminate: notHere,
  pause: notHere,
  resume: notHere,
  gitStatus: () => undefined,
  refreshGit: () => Effect.succeed(undefined),
  history: () => [],
  noteEvent: () => {},
  forgetHistory: () => {},
  moveHistory: () => {},
  localProjectChanged: () => {},
  peerProjectChanged: () => {},
  peerWorktreeChanged: () => {},
  leaveAccount: Effect.void,
  ...impl,
});
