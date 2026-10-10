// Host side of continuous worktree mirroring (packages/contracts/src/
// modules/mirror.ts): the sessions this device runs
// (host/mirror/sessions.ts) and what it serves a peer mirroring from
// here (host/mirror/serving.ts).
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers, ViewHandlers } from "@shigomori/contracts/types";
import * as Views from "@host/lib/views";
import type { HostServices } from "@host/process/services";
import { forgetMirrorInvitesOf } from "@host/mirror/invites";
import { engine } from "@host/mirror/registry";
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

export const mirrorViews: ViewHandlers<typeof mirrorContract, Views.Services> =
  {
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
  // The runner ended its mirror into a copy here and kept the copy:
  // the invitation goes, the worktree stays.
  release: ({ worktreeId }) => {
    forgetMirrorInvitesOf(worktreeId);
  },
  history: ({ localWorktreeId }) => ({
    events: engine().history(localWorktreeId),
  }),
  openStream: (input, ctx: HandlerContext) => serveStream(input, ctx),
  gitState: (input) => servedGitState(input),
  applyGitState: (input) => applyServedGitState(input),
} satisfies Handlers<typeof mirrorContract, HandlerContext, HostServices>;
