// The transfers running here (host/mirror/oneShot.ts), each a session
// labelled with a token of its own.
import * as Effect from "effect/Effect";
import { randomUUID } from "node:crypto";
import { type MirrorSessionRaw, transferTokenOf } from "../registry";

export type TransferTarget = {
  readonly deviceId: string;
  readonly worktreeId: string;
  // Whether the files go into the peer's worktree or come out of it.
  readonly transfer: "in" | "out";
};

export const makeTransfers = Effect.sync(() => {
  // Which transfer a session is, written into its mode
  // ("transfer-<token>"): one token per transfer, live from before its
  // create is sent until its pull has ended it. A transfer session whose
  // token is not live here has nobody waiting on it, and the host ends it
  // on sight, since no mirror surface would ever show it. That covers
  // every way one gets left behind: a quit or a crash mid-transfer (the
  // engine persists its sessions, and the next launch knows none of their
  // tokens), a create that was rejected after the engine had made the
  // session, and a terminate that failed. It never covers a transfer
  // still running, even on the snapshot that names the session before the
  // create's own reply lands, because the token is live first.
  // Each by the peer's worktree it runs against, which the gateway tells
  // the peer (transferInto).
  const liveTransfers = new Map<string, TransferTarget>();

  const beginTransfer = (target: TransferTarget): string => {
    const token = randomUUID();
    liveTransfers.set(token, target);
    return token;
  };

  // How a transfer running here meets the peer's worktree, or undefined
  // when none does (a live mirror's stream).
  const transferInto = (
    deviceId: string,
    worktreeId: string,
  ): "in" | "out" | undefined => {
    for (const target of liveTransfers.values()) {
      if (target.deviceId === deviceId && target.worktreeId === worktreeId) {
        return target.transfer;
      }
    }
    return undefined;
  };

  const endTransfer = (token: string): void => {
    liveTransfers.delete(token);
  };

  const isOrphanedTransfer = (raw: MirrorSessionRaw): boolean => {
    const token = transferTokenOf(raw.labels);
    return token !== null && !liveTransfers.has(token);
  };

  return { beginTransfer, transferInto, endTransfer, isOrphanedTransfer };
});
