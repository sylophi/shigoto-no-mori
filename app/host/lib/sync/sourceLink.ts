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
import * as Fiber from "effect/Fiber";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import { pickCloneUrl } from "@shared/cloneUrl";
import { errorMessageOf } from "@shigomori/contracts/errors";
import {
  type SyncCapture,
  SyncCaptureSchema,
  SyncBundleRefSchema,
  SyncPullProgressSchema,
  SyncPullWorktreePayloadSchema,
} from "@shigomori/contracts/modules/sync";
import { CHANNEL_MAX_WRITE_BYTES } from "@shigomori/contracts/modules/link";
import type { ChannelEndpoint, ChannelHandle } from "@shigomori/contracts/link";
import type { HandlerContext } from "@shared/ipc/transport";
import {
  CommitHashSchema,
  GitRefNameSchema,
  type Project,
} from "@shigomori/contracts/schemas";
import { strict } from "@shigomori/contracts/schemas/strict";
import type * as Engine from "@host/lib/engine";
import * as Ops from "@host/lib/engineOps";
import { peerChannelsFor, peerSyncFor } from "@host/ipc/peerSync";
import { refTip, treeOf } from "@host/lib/git/refs";
import { listRemoteEntries } from "@host/lib/git/remotes";
import { mintHexId } from "@host/lib/hexId";
import { primaryRef } from "@host/lib/projects";
import { requireChannels } from "@host/socket/channelStreams";

// What the source's answers reach: the engine (its captures and
// bundles) and git.
type SourceServices = Engine.Services | ChildProcessSpawner.ChildProcessSpawner;

// ---- The link: JSON lines and raw bytes over one channel.

export const LINK_GONE = "the other device went away mid-transfer";
// A message is a line of JSON, and none is anywhere near this: a line
// that is, is a broken peer.
const MAX_LINE_BYTES = 1 << 20;

// What a link, or the other end over it, refused.
export class LinkError extends Schema.TaggedError<LinkError>()("LinkError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export type Link = {
  // The next message, or null once the other end ended cleanly.
  read: Effect.Effect<unknown, LinkError>;
  // Exactly `bytes` raw bytes, each piece handed to `sink`. A piece is
  // taken only once the sink is done with it, so a slow disk slows the
  // sender.
  readBytes<E, R>(
    bytes: number,
    sink: (piece: Buffer) => Effect.Effect<void, E, R>,
  ): Effect.Effect<void, LinkError | E, R>;
  write(message: unknown): Effect.Effect<void, LinkError>;
  writeBytes(bytes: Uint8Array): Effect.Effect<void, LinkError>;
  // Queues a message without waiting for the window, for what is
  // presence rather than state (a progress frame): one the link can't
  // take is dropped.
  post(message: unknown): void;
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
  let failure: LinkError | null = null;
  let arrived: (() => void) | null = null;
  const writable = new Set<() => void>();
  const wake = (): void => {
    const waiting = arrived;
    arrived = null;
    waiting?.();
  };
  const closed = new AbortController();
  const fail = (error: LinkError): void => {
    failure ??= error;
    wake();
    for (const waiter of writable) waiter();
    writable.clear();
  };
  const gone = () => new LinkError({ reason: LINK_GONE });
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
      fail(gone());
    },
    onWritable() {
      for (const waiter of writable) waiter();
      writable.clear();
    },
  });
  if (!handle.open) {
    closed.abort();
    fail(gone());
  }
  // Once something arrives, the other end ends, or the link fails.
  // One reader at a time: each side of a link is one loop.
  const arrival = Effect.callback<void>((resume) => {
    const waiting = () => resume(Effect.void);
    arrived = waiting;
    return Effect.sync(() => {
      if (arrived === waiting) arrived = null;
    });
  });
  // A false return queued the bytes past the window: they go as the far
  // end takes what is ahead, and the next write waits for that.
  const writeBytes = (bytes: Uint8Array): Effect.Effect<void, LinkError> =>
    Effect.suspend(() => {
      if (failure !== null) return Effect.fail(failure);
      if (!handle.open) return Effect.fail(gone());
      if (handle.write(bytes)) return Effect.void;
      return Effect.callback<void, LinkError>((resume) => {
        const waiting = () =>
          resume(failure === null ? Effect.void : Effect.fail(failure));
        writable.add(waiting);
        return Effect.sync(() => writable.delete(waiting));
      });
    });

  const read = Effect.gen(function* () {
    const parts: Buffer[] = [];
    let size = 0;
    for (;;) {
      if (failure !== null) return yield* failure;
      const head = pending[0];
      if (head === undefined) {
        if (ended) {
          if (size === 0) return null;
          return yield* new LinkError({
            reason: "the other device ended the transfer mid-message",
          });
        }
        yield* arrival;
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
        const line = Buffer.concat(parts, size)
          .subarray(0, size - 1)
          .toString("utf8");
        return yield* Effect.try({
          try: (): unknown => JSON.parse(line),
          catch: () =>
            new LinkError({ reason: "the other device sent a broken message" }),
        });
      }
      if (size > MAX_LINE_BYTES) {
        return yield* new LinkError({
          reason: "the other device sent an oversized message",
        });
      }
    }
  });

  const readBytes = <E, R>(
    bytes: number,
    sink: (piece: Buffer) => Effect.Effect<void, E, R>,
  ) =>
    Effect.gen(function* () {
      let left = bytes;
      while (left > 0) {
        if (failure !== null) return yield* failure;
        const head = pending[0];
        if (head === undefined) {
          if (ended) {
            return yield* new LinkError({
              reason: "the other device ended the transfer mid-bundle",
            });
          }
          yield* arrival;
          continue;
        }
        const take = Math.min(left, head.data.length);
        const whole = take === head.data.length;
        const piece = head.data.subarray(0, take);
        if (whole) pending.shift();
        else head.data = head.data.subarray(take);
        // One piece on disk before the next.
        yield* sink(piece);
        if (whole) head.consumed();
        left -= take;
      }
    });

  return {
    read,
    readBytes,
    write: (message) =>
      writeBytes(Buffer.from(`${JSON.stringify(message)}\n`, "utf8")),
    writeBytes,
    post(message) {
      if (failure !== null || !handle.open) return;
      handle.write(Buffer.from(`${JSON.stringify(message)}\n`, "utf8"));
    },
    end: () => handle.end(),
    reset() {
      handle.reset();
      fail(gone());
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
export type SourceFacts = {
  tip(branch: string): Effect.Effect<string | null, unknown, SourceServices>;
  capture: Effect.Effect<SyncCapture, unknown, SourceServices>;
};

export function localSource(project: Project, worktreeId: string): SourceFacts {
  return {
    tip: (branch) => refTip(project.path, `refs/heads/${branch}`),
    capture: Effect.gen(function* () {
      const capture = yield* Ops.dirtyCapture(project, worktreeId);
      if (!capture.captured || capture.commit === undefined) {
        return { captured: false };
      }
      return {
        captured: true,
        commit: capture.commit,
        tree: yield* treeOf(project.path, capture.commit),
      } satisfies SyncCapture;
    }),
  };
}

// A link that died with a bundle half sent cannot carry an answer: its
// failure ends the serving and resets the link.
class BrokenLink extends Schema.TaggedError<BrokenLink>()("BrokenLink", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

// A bundle's temp dir, removed whatever happens.
const inTempDir = <A, E, R>(
  prefix: string,
  use: (dir: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
    use,
    (dir) =>
      Effect.promise(() =>
        rm(dir, { recursive: true, force: true }).catch(() => {}),
      ),
  );

const sendBundle = (
  link: Link,
  project: Project,
  refs: readonly string[],
  haves: readonly string[],
) =>
  inTempDir("sm-sync-", (dir) =>
    Effect.gen(function* () {
      const path = join(dir, "transfer.bundle");
      // Only the byte count travels back. The engine also reports the
      // refs it resolved, but that list is computed against the repo
      // AFTER `git bundle create` silently dropped any have-covered ref,
      // so it can name refs the bundle lacks.
      const { bytes } = yield* Ops.bundleCreate(
        project,
        path,
        [...refs],
        [...haves],
      );
      yield* Effect.acquireUseRelease(
        Effect.promise(() => openFile(path, "r")),
        (file) =>
          Effect.gen(function* () {
            yield* link.write({ bundle: { bytes } });
            for (let offset = 0; offset < bytes;) {
              // A buffer per piece: the channel holds on to what it could
              // not send yet.
              const piece = Buffer.allocUnsafe(
                Math.min(CHANNEL_MAX_WRITE_BYTES, bytes - offset),
              );
              const { bytesRead } = yield* Effect.promise(() =>
                file.read(piece, 0, piece.length, offset),
              );
              if (bytesRead === 0) {
                return yield* new LinkError({
                  reason: "the bundle shrank while sending",
                });
              }
              yield* link.writeBytes(piece.subarray(0, bytesRead));
              offset += bytesRead;
            }
          }).pipe(
            Effect.mapError(
              (error) => new BrokenLink({ reason: errorMessageOf(error) }),
            ),
          ),
        (file) => Effect.promise(() => file.close()),
      );
    }),
  );

// One question, answered on the link.
const answerAsk = (
  link: Link,
  project: Project,
  facts: SourceFacts,
  ask: typeof AskSchema.Type,
) => {
  switch (ask.ask) {
    case "tip":
      return Effect.flatMap(facts.tip(ask.branch), (commit) =>
        link.write({ ok: { commit } }),
      );
    case "capture":
      return Effect.flatMap(facts.capture, (capture) =>
        link.write({ ok: capture }),
      );
    case "clone":
      return Effect.flatMap(cloneFactsOf(project), (clone) =>
        link.write({ ok: clone }),
      );
    case "bundle":
      return sendBundle(link, project, ask.refs, ask.haves);
  }
};

// The source's end of a link: answers every question until the other
// end is done, then ends its own direction. A question it cannot
// answer is answered with the error (the first one is kept on
// `failure`, so a caller whose run failed can tell its own trouble
// from the other device's). A malformed message, or a bundle cut off
// halfway, resets the link and fails.
export const serveSource = (
  link: Link,
  project: Project,
  worktreeId: string,
  opts: {
    onProgress?: (frame: ProgressFrame) => void;
    failure?: { error?: unknown };
  } = {},
) => {
  const facts = localSource(project, worktreeId);
  return Effect.gen(function* () {
    // One question at a time.
    for (;;) {
      const message = yield* link.read;
      if (message === null) {
        link.end();
        return;
      }
      const request = yield* Effect.try({
        try: () => decodeRequest(message),
        catch: () =>
          new LinkError({ reason: "the other device asked something else" }),
      });
      if ("progress" in request) {
        opts.onProgress?.(request.progress);
        continue;
      }
      yield* answerAsk(link, project, facts, request).pipe(
        Effect.withSpan("SourceLink.answer", {
          attributes: { ask: request.ask },
        }),
        Effect.catch((error): Effect.Effect<void, LinkError | BrokenLink> => {
          if (error instanceof BrokenLink) return Effect.fail(error);
          if (opts.failure !== undefined) opts.failure.error ??= error;
          return link.write({ error: errorMessageOf(error) });
        }),
      );
    }
  }).pipe(Effect.tapError(() => Effect.sync(() => link.reset())));
};

// The clone's two questions: the branch the source's checkout is
// measured against (what a clone is made of) and where it was cloned
// from (the remote the clone gets, by the clone payload's own rule,
// shared/cloneUrl.ts).
const cloneFactsOf = (project: Project) =>
  Effect.map(
    Effect.all([primaryRef(project), listRemoteEntries(project.path)], {
      concurrency: 2,
    }),
    ([branch, remotes]): CloneFacts => ({
      branch,
      remoteUrl: pickCloneUrl(remotes),
    }),
  );

// A send's or a push's source end: this device opens a link on the
// peer through `openOnPeer` (the call that makes the peer ask over it) and
// answers the peer's questions until the call resolves. A run that
// failed on this side's own answer fails with that, not the peer's echo
// of it. The link ends with the answer, and is torn down when the call
// fails or the move is interrupted, which fails the wait at once: the
// peer's landing runs under the link (Link.closed) and stops with it.
// The peer's answer itself is not cut short: an interrupt stops
// waiting at once, and an answer already on its way when it came is a
// landing that finished, which `onLate` gets to undo.
export const offer = <T, E, R, R2 = never>(
  deviceId: string,
  project: Project,
  worktreeId: string,
  openOnPeer: (channelId: string) => Effect.Effect<T, E, R>,
  onProgress?: (frame: ProgressFrame) => void,
  onLate?: (answer: T) => Effect.Effect<unknown, never, R2>,
) =>
  Effect.gen(function* () {
    const channelId = mintHexId();
    const mux = yield* peerChannelsFor(deviceId);
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
    yield* Effect.forkScoped(
      Effect.ignore(
        serveSource(link, project, worktreeId, { onProgress, failure }),
      ),
    );
    const answering = yield* Effect.forkDetach(openOnPeer(channelId));
    return yield* Fiber.join(answering).pipe(
      Effect.onInterrupt(() =>
        onLate === undefined
          ? Effect.void
          : Effect.asVoid(
              Effect.forkDetach(
                Fiber.join(answering).pipe(
                  Effect.flatMap(onLate),
                  Effect.ignore,
                ),
              ),
            ),
      ),
      Effect.mapError((error) =>
        failure.error === undefined ? error : failure.error,
      ),
    );
  }).pipe(Effect.scoped);

// ---- The destination's side.

type UnpackTarget = Project | { path: string };

export type WorktreeSource = SourceFacts & {
  cloneFacts: Effect.Effect<CloneFacts, unknown, SourceServices>;
  // Asks for a bundle of `refs` thinned by `haves`, writes it to a temp
  // file as it arrives and unpacks it into `into`, every ref under
  // refs/shigomori/ (landingRefspec). Byte progress once with 0 when
  // the size is known, then coalesced.
  fetch(input: {
    refs: readonly string[];
    haves: readonly string[];
    into: UnpackTarget;
    onProgress?: (bytes: number, totalBytes: number) => void;
  }): Effect.Effect<
    { fetched: { ref: string; commit: string }[] },
    unknown,
    SourceServices
  >;
  // A progress frame for the source's side to relay (a send's, over the
  // link the source opened). Never awaited: progress is presence, and a
  // lost frame changes nothing.
  report(frame: ProgressFrame): void;
};

// The destination's questions over a link: one a peer opened here (a
// send's, a push's), or a pull's, opened on first use (its refusals are
// this device's own and come before any question).
function askSource(
  linkOf: Effect.Effect<Link, unknown>,
  relay: ((frame: ProgressFrame) => void) | null,
): WorktreeSource {
  const answer = (link: Link, message: unknown) =>
    Effect.gen(function* () {
      yield* link.write(message);
      const reply = yield* link.read;
      if (reply === null) return yield* new LinkError({ reason: LINK_GONE });
      const parsed = yield* Effect.try({
        try: () => decodeAnswer(reply),
        catch: () =>
          new LinkError({ reason: "the other device answered out of turn" }),
      });
      if ("error" in parsed) {
        return yield* new LinkError({ reason: parsed.error });
      }
      return parsed;
    });
  const ask = <T>(message: unknown, decodeOk: (ok: unknown) => T) =>
    Effect.gen(function* () {
      const parsed = yield* answer(yield* linkOf, message);
      if (!("ok" in parsed)) {
        return yield* new LinkError({
          reason: "the other device answered out of turn",
        });
      }
      return yield* Effect.try({
        try: () => decodeOk(parsed.ok),
        catch: () =>
          new LinkError({ reason: "the other device answered out of turn" }),
      });
    });
  return {
    tip: (branch) =>
      Effect.map(
        ask({ ask: "tip", branch }, decodeTipAnswer),
        (tip) => tip.commit,
      ),
    capture: ask({ ask: "capture" }, decodeCapture),
    cloneFacts: ask({ ask: "clone" }, decodeCloneFacts),
    fetch: ({ refs, haves, into, onProgress }) =>
      Effect.gen(function* () {
        const link = yield* linkOf;
        const parsed = yield* answer(link, { ask: "bundle", refs, haves });
        if (!("bundle" in parsed)) {
          return yield* new LinkError({
            reason: "the other device answered out of turn",
          });
        }
        const { bytes } = parsed.bundle;
        onProgress?.(0, bytes);
        const report = coalescedProgress(bytes, onProgress);
        return yield* inTempDir("sm-sync-recv-", (dir) =>
          Effect.gen(function* () {
            const path = join(dir, "incoming.bundle");
            yield* Effect.acquireUseRelease(
              Effect.promise(() => openFile(path, "w")),
              (file) => {
                let received = 0;
                return link.readBytes(bytes, (piece) =>
                  Effect.promise(async () => {
                    await file.write(piece);
                    received += piece.length;
                    report(received);
                  }),
                );
              },
              (file) => Effect.promise(() => file.close()),
            );
            return yield* Ops.bundleUnpack(
              into,
              path,
              refs.map(landingRefspec),
            );
          }),
        );
      }),
    // Queued on the channel at once, so a frame reported just before
    // the landing returns still goes ahead of the link's end. A pull's
    // link has nothing to relay to: its progress is this device's own.
    report(frame) {
      relay?.(frame);
    },
  };
}

// A peer's source for the length of the scope: the link opens on the
// first question (sync:openSource on the peer), ends with the scope,
// and is torn down when the scope fails or is interrupted, so a source
// still sending a bundle stops and the question waiting on it fails.
export const peerSource = (
  deviceId: string,
  worktree: { projectId: string; worktreeId: string },
) =>
  Effect.gen(function* () {
    let attached: Link | undefined;
    // This device's end of the link is attached BEFORE the call that
    // opens the peer's end is sent, so the peer's first bytes always
    // find it. The call's failure resets it.
    const open = Effect.gen(function* () {
      const channelId = mintHexId();
      const mux = yield* peerChannelsFor(deviceId);
      const link = attachLink((endpoint) => mux.attach(channelId, endpoint));
      attached = link;
      yield* peerSyncFor(deviceId)
        .openSource({ ...worktree, channelId })
        .pipe(Effect.tapError(() => Effect.sync(() => link.reset())));
      return link;
    });
    const linkOf = yield* Effect.cached(open);
    // A cancel must not wait on a peer that never answered the open,
    // so the link goes as soon as it is attached.
    yield* Effect.addFinalizer((exit) =>
      Effect.sync(() => {
        if (Exit.isSuccess(exit)) attached?.end();
        else attached?.reset();
      }),
    );
    return askSource(linkOf, null);
  });

// A host handler's source over a link a peer opened, for the length of
// the scope: it ends with the scope, and is torn down when the scope
// fails or is interrupted.
export const linkSource = (link: Link) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      askSource(Effect.succeed(link), (frame) =>
        link.post({ progress: frame }),
      ),
    ),
    (_, exit) =>
      Effect.sync(() => {
        if (Exit.isSuccess(exit)) link.end();
        else link.reset();
      }),
  );
