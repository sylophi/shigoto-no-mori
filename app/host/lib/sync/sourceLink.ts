// How commits cross between devices: a SOURCE LINK, one byte channel
// (shared/remote/channels.ts) between the device holding a
// worktree (the source) and the device that wants its commits (the
// destination). Whichever of the two opened the channel, the
// conversation on it is the same: the destination asks, the source
// answers, one question at a time.
//
//   destination to source, one JSON line per message:
//     {"ask":"tip","branch":b}      the branch's tip, or null
//     {"ask":"capture"}             a fresh capture of the worktree's
//                                   uncommitted state (sm dirty capture)
//     {"ask":"clone"}               the repo's default branch and remote
//     {"ask":"bundle","refs":[..],"haves":[..]}
//     {"progress":{..}}             the landing's progress, unanswered
//   source to destination:
//     {"ok":answer} or {"error":"message"}
//     {"bundle":{"bytes":n}}        then exactly n raw bytes
//
// Three calls open one, each on the device whose grant gates it
// (packages/contracts/src/modules/sync.ts): openSource (a pull, and the git
// follower fetching: the destination opens the source's link),
// receiveWorktree (a send: the source opens a link on the destination,
// which lands the worktree asking back over it) and receiveBundle (the
// git follower pushing). So the device asked always holds the grant,
// and neither end ever needs the other's.
//
// Bundles are built and unpacked by the CLI (`sm bundle create` and
// `sm bundle unpack`), refs landing only under refs/shigomori/, in a
// temp dir (mkdtemp, 0700) of their own that the ask removes whatever
// happens. The channel is the flow control end to end: the sender
// waits once its queue is full, and the receiver takes a piece only
// once the bytes are on disk. A link whose other end goes away (a
// reset, a revoked grant, the device link dropping) fails whatever is
// waiting on it.
import { mkdtemp, open as openFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { pickCloneUrl } from "@shared/cloneUrl";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { runTraced, traced, withParentSpan } from "@host/lib/util/trace";
import {
  type SyncCapture,
  SyncCaptureSchema,
  SyncBundleRefSchema,
  SyncPullProgressSchema,
  SyncPullWorktreePayloadSchema,
} from "@shigomori/contracts/modules/sync";
import { CHANNEL_MAX_WRITE_BYTES } from "@shigomori/contracts/modules/link";
import type { ChannelEndpoint, ChannelHandle } from "@shared/remote/channels";
import type { HandlerContext } from "@shared/ipc/transport";
import {
  CommitHashSchema,
  GitRefNameSchema,
  type Project,
} from "@shigomori/contracts/schemas";
import { strict } from "@shigomori/contracts/schemas/strict";
import {
  bundleCreate,
  bundleUnpack,
  dirtyCapture,
} from "@host/lib/engineCalls";
import type { PeerSyncApi } from "@host/ipc/peerSync";
import { refTip, treeOf } from "@host/lib/git/refs";
import { listRemoteEntries } from "@host/lib/git/remotes";
import { mintHexId } from "@host/lib/hexId";
import { primaryRefOf } from "@host/lib/projects";
import { requireChannels } from "@host/socket/channelStreams";
import { MoveStepError, step, unwrapStep } from "./moves";

// ---- The link: JSON lines and raw bytes over one channel.

export const LINK_GONE = "the other device went away mid-transfer";
// A message is a line of JSON, and none is anywhere near this: a line
// that is, is a broken peer.
const MAX_LINE_BYTES = 1 << 20;

export type Link = {
  // The next message, or null once the other end ended cleanly.
  read(): Promise<unknown>;
  // Exactly `bytes` raw bytes, each piece handed to `sink`. A piece is
  // taken only once the sink resolved, so a slow disk slows the
  // sender.
  readBytes(
    bytes: number,
    sink: (piece: Buffer) => Promise<void>,
  ): Promise<void>;
  write(message: unknown): Promise<void>;
  writeBytes(bytes: Uint8Array): Promise<void>;
  // Ends this direction once what is queued has gone.
  end(): void;
  // Tears the channel down now, failing whatever waits on it.
  reset(): void;
  // Aborted once the OTHER end reset the link (a sender that gave up,
  // its cancel or its caller gone), or it was gone before this end
  // attached. A landing run over a link a peer opened runs under it,
  // so the sender's cancel reaches it without a word of its own. A
  // clean end leaves it alone, and so does this end's own reset: a
  // landing that fails and tears the link down is reporting its own
  // failure, not a cancel.
  closed: AbortSignal;
};

export function attachLink(
  attach: (endpoint: ChannelEndpoint) => ChannelHandle,
): Link {
  // Bytes the other end sent that nothing has read yet, each with the
  // callback that takes it: at most a window's worth, since the other
  // end waits on the ones not taken.
  const pending: { data: Buffer; consumed: () => void }[] = [];
  let ended = false;
  let failure: Error | null = null;
  let arrived: (() => void) | null = null;
  const writable = new Set<{
    resolve: () => void;
    reject: (e: Error) => void;
  }>();
  const wake = (): void => {
    const waiting = arrived;
    arrived = null;
    waiting?.();
  };
  const closed = new AbortController();
  const fail = (error: Error): void => {
    failure ??= error;
    wake();
    for (const waiter of writable) waiter.reject(failure);
    writable.clear();
  };
  const handle = attach({
    onData(data, consumed) {
      pending.push({
        data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
        consumed,
      });
      wake();
    },
    onEnd() {
      ended = true;
      wake();
    },
    onReset() {
      closed.abort();
      fail(new Error(LINK_GONE));
    },
    onWritable() {
      for (const waiter of writable) waiter.resolve();
      writable.clear();
    },
  });
  if (!handle.open) {
    closed.abort();
    fail(new Error(LINK_GONE));
  }
  // Resolves once something arrives, the other end ends, or the link
  // fails. One reader at a time: each side of a link is one loop.
  const arrival = (): Promise<void> =>
    new Promise((resolve) => {
      arrived = resolve;
    });

  async function writeBytes(bytes: Uint8Array): Promise<void> {
    if (failure !== null) throw failure;
    if (!handle.open) throw new Error(LINK_GONE);
    // A false return queued the bytes past the window: they go as the
    // far end takes what is ahead, and the next write waits for that.
    if (handle.write(bytes)) return;
    await new Promise<void>((resolve, reject) => {
      writable.add({ resolve, reject });
    });
  }

  return {
    async read() {
      const parts: Buffer[] = [];
      let size = 0;
      for (;;) {
        if (failure !== null) throw failure;
        const head = pending[0];
        if (head === undefined) {
          if (ended) {
            if (size === 0) return null;
            throw new Error("the other device ended the transfer mid-message");
          }
          // oxlint-disable-next-line no-await-in-loop -- the reader waits for bytes
          await arrival();
          continue;
        }
        const newline = head.data.indexOf(0x0a);
        const take = newline === -1 ? head.data.length : newline + 1;
        parts.push(head.data.subarray(0, take));
        size += take;
        if (take === head.data.length) {
          pending.shift();
          head.consumed();
        } else {
          head.data = head.data.subarray(take);
        }
        if (newline !== -1) {
          return JSON.parse(
            Buffer.concat(parts, size)
              .subarray(0, size - 1)
              .toString("utf8"),
          ) as unknown;
        }
        if (size > MAX_LINE_BYTES) {
          throw new Error("the other device sent an oversized message");
        }
      }
    },
    async readBytes(bytes, sink) {
      let left = bytes;
      while (left > 0) {
        if (failure !== null) throw failure;
        const head = pending[0];
        if (head === undefined) {
          if (ended) {
            throw new Error("the other device ended the transfer mid-bundle");
          }
          // oxlint-disable-next-line no-await-in-loop -- the reader waits for bytes
          await arrival();
          continue;
        }
        const take = Math.min(left, head.data.length);
        const whole = take === head.data.length;
        const piece = head.data.subarray(0, take);
        if (whole) pending.shift();
        else head.data = head.data.subarray(take);
        // oxlint-disable-next-line no-await-in-loop -- one piece on disk before the next
        await sink(piece);
        if (whole) head.consumed();
        left -= take;
      }
    },
    write: (message) =>
      writeBytes(Buffer.from(`${JSON.stringify(message)}\n`, "utf8")),
    writeBytes,
    end: () => handle.end(),
    reset() {
      handle.reset();
      fail(new Error(LINK_GONE));
    },
    closed: closed.signal,
  };
}

// The host's end of a link a peer opened (the calls in the header),
// attached before the handler does any work: the channel must be one
// this connection can hold (requireChannels), and nothing is sent on it
// until the peer's first question, or until the open resolved.
export function attachLinkFarEnd(ctx: HandlerContext, channelId: string): Link {
  const channels = requireChannels(ctx, channelId);
  return attachLink((endpoint) => channels.attach(channelId, endpoint));
}

// This device's end of a link to a peer, attached BEFORE the call that
// opens the peer's end is sent, so the peer's first bytes always find
// it. The call's rejection resets it, and so does a cancel while it
// waits (peerSource's release, through `onAttached`).
async function openLink(
  peer: Pick<PeerSyncApi, "channels">,
  open: (channelId: string) => Promise<unknown>,
  onAttached: (link: Link) => void = () => {},
): Promise<Link> {
  const channelId = mintHexId();
  const mux = await peer.channels();
  const link = attachLink((endpoint) => mux.attach(channelId, endpoint));
  onAttached(link);
  try {
    await open(channelId);
  } catch (error) {
    link.reset();
    throw error;
  }
  return link;
}

// ---- The messages, validated at both ends: what a peer sends flows
// into git argv and into strict progress schemas here.

const AskSchema = Schema.Union([
  strict(
    Schema.Struct({
      ask: Schema.Literal("tip"),
      branch: SyncPullWorktreePayloadSchema.struct.fields.branch,
    }),
  ),
  strict(Schema.Struct({ ask: Schema.Literal("capture") })),
  strict(Schema.Struct({ ask: Schema.Literal("clone") })),
  strict(
    Schema.Struct({
      ask: Schema.Literal("bundle"),
      refs: Schema.Array(SyncBundleRefSchema).check(
        Schema.isBetweenLength(1, 64),
      ),
      haves: Schema.Array(CommitHashSchema).check(Schema.isMaxLength(256)),
    }),
  ),
]);
const progressFields = SyncPullProgressSchema.struct.fields;
const ProgressFrameSchema = strict(
  Schema.Struct({
    step: progressFields.step,
    bytes: progressFields.bytes,
    totalBytes: progressFields.totalBytes,
    createPhase: progressFields.createPhase,
  }),
);
export type ProgressFrame = typeof ProgressFrameSchema.Type;
const RequestSchema = Schema.Union([
  AskSchema,
  strict(Schema.Struct({ progress: ProgressFrameSchema })),
]);

export const BundleAnswerSchema = strict(
  Schema.Struct({
    bundle: strict(Schema.Struct({ bytes: Schema.Natural })),
  }),
);
const AnswerSchema = Schema.Union([
  strict(Schema.Struct({ ok: Schema.Unknown })),
  strict(Schema.Struct({ error: Schema.String })),
  BundleAnswerSchema,
]);
const TipAnswerSchema = strict(
  Schema.Struct({
    commit: Schema.NullOr(CommitHashSchema),
  }),
);
const CloneFactsSchema = strict(
  Schema.Struct({
    branch: GitRefNameSchema,
    remoteUrl: Schema.NullOr(Schema.String),
  }),
);
type CloneFacts = typeof CloneFactsSchema.Type;
const decodeRequest = Schema.decodeUnknownSync(RequestSchema);
const decodeAnswer = Schema.decodeUnknownSync(AnswerSchema);
const decodeTipAnswer = Schema.decodeUnknownSync(TipAnswerSchema);
const decodeCapture = Schema.decodeUnknownSync(SyncCaptureSchema);
const decodeCloneFacts = Schema.decodeUnknownSync(CloneFactsSchema);

// Where a fetched branch lands: never the branch itself.
export function incomingRefFor(branch: string): string {
  return `refs/shigomori/incoming/${branch}`;
}

// Where a fetched ref lands: capture and index refs keep their name,
// branch refs land under refs/shigomori/incoming/<branch>. Never a
// local branch: `sm bundle unpack` enforces the refs/shigomori/
// destination fail-closed, this mapping just picks the names.
function landingRefspec(ref: string): string {
  const dst = ref.startsWith("refs/shigomori/")
    ? ref
    : incomingRefFor(ref.slice("refs/heads/".length));
  return `${ref}:${dst}`;
}

// Byte progress for a caller that reports it, coalesced to about half
// a percent or 100ms between reports (every frame is an IPC round trip
// and a render), and always once more at the end.
function coalescedProgress(
  totalBytes: number,
  onProgress: ((bytes: number, totalBytes: number) => void) | undefined,
): (bytes: number) => void {
  let lastMark = 0;
  let lastAt = Date.now();
  return (bytes) => {
    if (onProgress === undefined) return;
    const mark = Math.floor((bytes / Math.max(1, totalBytes)) * 200);
    const now = Date.now();
    const final = bytes >= totalBytes;
    if (!final && mark === lastMark && now - lastAt < 100) return;
    lastMark = mark;
    lastAt = now;
    onProgress(bytes, totalBytes);
  };
}

// ---- The source's side.

// What a source knows about its own worktree, read locally: the
// answers its end of a link gives, and what a send's teardown checks
// the source against (it is this device's own worktree then).
// A question asked with a `signal` tears the link down when it fires,
// so the question fails at once instead of waiting on the answer.
export type SourceFacts = {
  tip(branch: string, signal?: AbortSignal): Promise<string | null>;
  capture(signal?: AbortSignal): Promise<SyncCapture>;
};

export function localSource(project: Project, worktreeId: string): SourceFacts {
  return {
    tip: (branch) => refTip(project.path, `refs/heads/${branch}`),
    capture: async () => {
      const capture = await dirtyCapture(project, worktreeId);
      if (!capture.captured || capture.commit === undefined) {
        return { captured: false };
      }
      return {
        captured: true,
        commit: capture.commit,
        tree: await treeOf(project.path, capture.commit),
      };
    },
  };
}

// A link that died with a bundle half sent cannot carry an answer: its
// failure ends the serving and resets the link.
class BrokenLink extends Error {}

async function sendBundle(
  link: Link,
  project: Project,
  refs: readonly string[],
  haves: readonly string[],
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sm-sync-"));
  try {
    const path = join(dir, "transfer.bundle");
    // Only the byte count travels back. The CLI also reports the refs
    // it resolved, but that list is computed against the repo AFTER
    // `git bundle create` silently dropped any have-covered ref, so it
    // can name refs the bundle lacks.
    const { bytes } = await bundleCreate(project, path, [...refs], [...haves]);
    const file = await openFile(path, "r");
    try {
      await link.write({ bundle: { bytes } });
      for (let offset = 0; offset < bytes;) {
        // A buffer per piece: the channel holds on to what it could not
        // send yet.
        const piece = Buffer.allocUnsafe(
          Math.min(CHANNEL_MAX_WRITE_BYTES, bytes - offset),
        );
        // oxlint-disable-next-line no-await-in-loop -- pieces go in order
        const { bytesRead } = await file.read(piece, 0, piece.length, offset);
        if (bytesRead === 0) throw new Error("the bundle shrank while sending");
        // oxlint-disable-next-line no-await-in-loop -- the channel's window
        await link.writeBytes(piece.subarray(0, bytesRead));
        offset += bytesRead;
      }
    } catch (error) {
      throw new BrokenLink(errorMessageOf(error));
    } finally {
      await file.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// One question, answered on the link.
async function answerAsk(
  link: Link,
  project: Project,
  facts: SourceFacts,
  ask: typeof AskSchema.Type,
): Promise<void> {
  switch (ask.ask) {
    case "tip":
      await link.write({ ok: { commit: await facts.tip(ask.branch) } });
      return;
    case "capture":
      await link.write({ ok: await facts.capture() });
      return;
    case "clone":
      await link.write({ ok: await cloneFactsOf(project) });
      return;
    case "bundle":
      await sendBundle(link, project, ask.refs, ask.haves);
      return;
  }
}

// The source's end of a link: answers every question until the other
// end is done, then ends its own direction. A question it cannot
// answer is answered with the error (the first one is kept on
// `failure`, so a caller whose run failed can tell its own trouble
// from the other device's). A malformed message, or a bundle cut off
// halfway, resets the link and rejects.
export async function serveSource(
  link: Link,
  project: Project,
  worktreeId: string,
  opts: {
    onProgress?: (frame: ProgressFrame) => void;
    failure?: { error?: unknown };
  } = {},
): Promise<void> {
  const facts = localSource(project, worktreeId);
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one question at a time
      const message = await link.read();
      if (message === null) {
        link.end();
        return;
      }
      const request = decodeRequest(message);
      if ("progress" in request) {
        opts.onProgress?.(request.progress);
        continue;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- one question at a time
        await traced("SourceLink.answer", { ask: request.ask }, () =>
          answerAsk(link, project, facts, request),
        );
      } catch (error) {
        if (error instanceof BrokenLink) throw error;
        if (opts.failure !== undefined) opts.failure.error ??= error;
        // oxlint-disable-next-line no-await-in-loop -- one question at a time
        await link.write({ error: errorMessageOf(error) });
      }
    }
  } catch (error) {
    link.reset();
    throw error;
  }
}

// The clone's two questions: the branch the source's checkout is
// measured against (what a clone is made of) and where it was cloned
// from (the remote the clone gets, by the clone payload's own rule,
// shared/cloneUrl.ts).
async function cloneFactsOf(project: Project): Promise<CloneFacts> {
  const [branch, remotes] = await Promise.all([
    primaryRefOf(project),
    listRemoteEntries(project.path),
  ]);
  return { branch, remoteUrl: pickCloneUrl(remotes) };
}

// For the Promise callers below: a failure as its step threw it.
const runStep = <A>(effect: Effect.Effect<A, MoveStepError>) =>
  runTraced(effect.pipe(Effect.mapError(unwrapStep)));

// A send's or a push's source end: this device opens a link on the
// peer through `openOnPeer` (the call that makes the peer ask over it) and
// answers the peer's questions until the call resolves. A run that
// failed on this side's own answer fails with that, not the peer's echo
// of it. The link ends with the answer, and is torn down when the call
// fails or the move is interrupted, which fails the wait at once: the
// peer's landing runs under the link (Link.closed) and stops with it.
// An answer already on its way when the interrupt came is a landing
// that finished, which `onLate` gets to undo.
export const offer = <T>(
  peer: Pick<PeerSyncApi, "channels">,
  project: Project,
  worktreeId: string,
  openOnPeer: (channelId: string) => Promise<T>,
  onProgress?: (frame: ProgressFrame) => void,
  onLate?: (answer: T) => unknown,
) =>
  Effect.gen(function* () {
    const channelId = mintHexId();
    const mux = yield* step(() => peer.channels());
    const link = yield* Effect.acquireRelease(
      Effect.sync(() =>
        attachLink((endpoint) => mux.attach(channelId, endpoint)),
      ),
      // The peer ends its side as its call resolves. Once this side's
      // queue drains the channel is complete.
      (opened, exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit)) opened.reset();
          opened.end();
        }),
    );
    // Only this side's own answers count as its failure: a link the
    // peer tore down as its run failed is that run's news, which the
    // call brings.
    const failure: { error?: unknown } = {};
    void serveSource(link, project, worktreeId, { onProgress, failure }).catch(
      () => {},
    );
    // The peer's call continues the move's trace.
    const span = yield* Effect.option(Effect.currentSpan);
    const answering = withParentSpan(span, () => openOnPeer(channelId));
    // Not a step: the peer's answer cannot be cut short, so an
    // interrupt stops waiting at once and hands a late one to `onLate`.
    return yield* Effect.tryPromise({
      try: () => answering,
      catch: (cause) => new MoveStepError({ cause }),
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          if (onLate !== undefined) answering.then(onLate).catch(() => {});
        }),
      ),
      Effect.mapError((error) =>
        failure.error === undefined
          ? error
          : new MoveStepError({ cause: failure.error }),
      ),
    );
  }).pipe(Effect.scoped);

// The same for a Promise caller (the git follower's push).
export const offerSource = <T>(
  peer: Pick<PeerSyncApi, "channels">,
  project: Project,
  worktreeId: string,
  openOnPeer: (channelId: string) => Promise<T>,
): Promise<T> => runStep(offer(peer, project, worktreeId, openOnPeer));

// ---- The destination's side.

type UnpackTarget = Project | { path: string };

export type WorktreeSource = SourceFacts & {
  cloneFacts(signal?: AbortSignal): Promise<CloneFacts>;
  // Asks for a bundle of `refs` thinned by `haves`, writes it to a temp
  // file as it arrives and unpacks it into `into`, every ref under
  // refs/shigomori/ (landingRefspec). Byte progress once with 0 when
  // the size is known, then coalesced.
  fetch(input: {
    refs: readonly string[];
    haves: readonly string[];
    into: UnpackTarget;
    onProgress?: (bytes: number, totalBytes: number) => void;
    signal?: AbortSignal;
  }): Promise<{ fetched: { ref: string; commit: string }[] }>;
  // A progress frame for the source's side to relay (a send's, over the
  // link the source opened). Never awaited: progress is presence, and a
  // lost frame changes nothing.
  report(frame: ProgressFrame): void;
};

// The destination's questions over a link: one a peer opened here (a
// send's, a push's), or a pull's, opened on first use (its refusals are
// this device's own and come before any question).
function askSource(linkOrOpen: Link | (() => Promise<Link>)): WorktreeSource {
  const opened =
    typeof linkOrOpen === "function" ? linkOrOpen : async () => linkOrOpen;
  const linkOf = async (signal: AbortSignal | undefined) => {
    const link = await opened();
    if (signal?.aborted) link.reset();
    else signal?.addEventListener("abort", () => link.reset(), { once: true });
    return link;
  };
  async function answer(
    link: Link,
    message: unknown,
  ): Promise<typeof AnswerSchema.Type> {
    await link.write(message);
    const reply = await link.read();
    if (reply === null) throw new Error(LINK_GONE);
    const parsed = decodeAnswer(reply);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed;
  }
  async function ask<T>(
    message: unknown,
    decodeOk: (ok: unknown) => T,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const parsed = await answer(await linkOf(signal), message);
    if (!("ok" in parsed))
      throw new Error("the other device answered out of turn");
    return decodeOk(parsed.ok);
  }
  return {
    tip: async (branch, signal) =>
      (await ask({ ask: "tip", branch }, decodeTipAnswer, signal)).commit,
    capture: (signal) => ask({ ask: "capture" }, decodeCapture, signal),
    cloneFacts: (signal) => ask({ ask: "clone" }, decodeCloneFacts, signal),
    async fetch({ refs, haves, into, onProgress, signal }) {
      const link = await linkOf(signal);
      const parsed = await answer(link, { ask: "bundle", refs, haves });
      if (!("bundle" in parsed)) {
        throw new Error("the other device answered out of turn");
      }
      const { bytes } = parsed.bundle;
      onProgress?.(0, bytes);
      const report = coalescedProgress(bytes, onProgress);
      const dir = await mkdtemp(join(tmpdir(), "sm-sync-recv-"));
      try {
        const path = join(dir, "incoming.bundle");
        const file = await openFile(path, "w");
        try {
          let received = 0;
          await link.readBytes(bytes, async (piece) => {
            await file.write(piece);
            received += piece.length;
            report(received);
          });
        } finally {
          await file.close();
        }
        return await bundleUnpack(into, path, refs.map(landingRefspec));
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
    // Queued on the channel at once, so a frame reported just before
    // the landing returns still goes ahead of the link's end. A pull's
    // link has nothing to relay to: its progress is this device's own.
    report(frame) {
      if (typeof linkOrOpen === "function") return;
      void linkOrOpen.write({ progress: frame }).catch(() => {});
    },
  };
}

// A peer's source for the length of the scope: the link opens on the
// first question (sync:openSource on the peer), ends with the scope,
// and is torn down when the scope fails or is interrupted, so a source
// still sending a bundle stops and the question waiting on it fails.
export const peerSource = (
  peer: Pick<PeerSyncApi, "channels" | "openSource">,
  worktree: { projectId: string; worktreeId: string },
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let opened: Promise<Link> | undefined;
      let attached: Link | undefined;
      const source = askSource(
        () =>
          (opened ??= openLink(
            peer,
            (channelId) => peer.openSource({ ...worktree, channelId }),
            (link) => {
              attached = link;
            },
          )),
      );
      return { source, attached: () => attached };
    }),
    // A cancel must not wait on a peer that never answered the open,
    // so the link goes as soon as it is attached.
    ({ attached }, exit) =>
      Effect.sync(() => {
        const link = attached();
        if (Exit.isSuccess(exit)) link?.end();
        else link?.reset();
      }),
  ).pipe(Effect.map(({ source }) => source));

// A source for the length of a Promise caller's `run`.
const withSource = <T>(
  acquire: Effect.Effect<WorktreeSource, never, Scope.Scope>,
  run: (source: WorktreeSource) => Promise<T>,
): Promise<T> =>
  runStep(
    acquire.pipe(
      Effect.flatMap((source) => step(() => run(source))),
      Effect.scoped,
    ),
  );

// The git follower's and the teardown's.
export const withPeerSource = <T>(
  peer: Pick<PeerSyncApi, "channels" | "openSource">,
  worktree: { projectId: string; worktreeId: string },
  run: (source: WorktreeSource) => Promise<T>,
): Promise<T> => withSource(peerSource(peer, worktree), run);

// A host handler's source over a link a peer opened, for the length of
// the scope: it ends with the scope, and is torn down when the scope
// fails or is interrupted.
export const linkSource = (link: Link) =>
  Effect.acquireRelease(
    Effect.sync(() => askSource(link)),
    (_, exit) =>
      Effect.sync(() => {
        if (Exit.isSuccess(exit)) link.end();
        else link.reset();
      }),
  );

// sync:receiveBundle's.
export const withLinkSource = <T>(
  link: Link,
  run: (source: WorktreeSource) => Promise<T>,
): Promise<T> => withSource(linkSource(link), run);
