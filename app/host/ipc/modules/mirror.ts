// Host side of continuous worktree mirroring (packages/contracts/src/
// modules/mirror.ts): the sessions this device runs
// (host/mirror/sessions.ts) and what it serves a peer mirroring from
// here (host/mirror/serving.ts).
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import type { HandlerContext } from "@shared/ipc/transport";
import type { ViewHandlers } from "@shigomori/contracts/types";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import * as Views from "@host/lib/Views";
import type { HostServices } from "@host/process/services";
import { MirrorEngine } from "@host/mirror/MirrorEngine";
import {
  applyServedGitState,
  servedGitState,
  serveStream,
} from "@host/mirror/serving";
import {
  mirrorList,
  pauseOrResume,
  reopenMirror,
  startMirrorFrom,
  startMirrorTo,
  stopMirror,
} from "@host/mirror/sessions";

export const mirrorViews: ViewHandlers<typeof mirrorContract, HostServices> = {
  watch: () =>
    Views.view(
      "mirror:watch",
      () => mirrorList(),
      Views.pushed(mirrorContract, "changed"),
    ),
};

export const mirrorHandlers = {
  list: () => mirrorList(),
  startTo: (input, ctx) => startMirrorTo(input, ctx),
  startFrom: (input, ctx) => startMirrorFrom(input, ctx),
  stop: ({ session, force }) => stopMirror(session, force === true),
  pause: ({ session }) => pauseOrResume(session, "pause"),
  resume: ({ session }) => pauseOrResume(session, "resume"),
  setIgnores: ({ session, ignoreMode, ignores }) =>
    reopenMirror(session, ignoreMode, ignores),
  history: ({ localWorktreeId }) =>
    Effect.map(MirrorEngine, (engine) => ({
      events: engine.history(localWorktreeId),
    })),
  openStream: (input, ctx: HandlerContext) => serveStream(input, ctx),
  gitState: (input) => servedGitState(input),
  applyGitState: (input) => applyServedGitState(input),
} satisfies EffectHandlers<typeof mirrorContract, HandlerContext, HostServices>;
