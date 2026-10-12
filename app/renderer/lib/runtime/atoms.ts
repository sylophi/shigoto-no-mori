// The atoms a container reads a host view or a push stream through
// (app/DESIGN.md, "Views and containers"): each on the client's runtime,
// over the links the page's api rides, which the boot seeds into the
// page's registry (clientLinksAtom) with this device's id
// (localDeviceIdAtom) and the page's query client (queryClientAtom). A
// request stays a React Query query.
import type { Decoded, Encoded } from "@shigomori/contracts/codec";
import {
  type ContractCall,
  type ContractModule,
  channelOf,
  type InputOf,
  type OutputOf,
  outputOf,
  type PayloadOf,
  payloadOf,
} from "@shigomori/contracts/contract";
import {
  isCommandRefusedError,
  isContractError,
  isNoDirectConnectionError,
  isNotSharingError,
} from "@shigomori/contracts/errors";
import { hubContract } from "@shigomori/contracts/modules/hub";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { QueryClient } from "@tanstack/react-query";
import type { Link } from "@shared/ipc/transport";
import { UnreadableAnswerError } from "@shared/remote/rpcTransport";
import { ClientLinks } from "./ClientLinks";
import { peerLink } from "./peerLink";

// Put in the registry by the boot, before anything reads a view.
export const clientLinksAtom = Atom.keepAlive(
  Atom.make<ClientLinks["Service"] | null>(null),
);

// This device's id, put in the registry by the boot beside the links:
// a view of it rides the local link, any other device's the hub hop.
export const localDeviceIdAtom = Atom.keepAlive(Atom.make(""));

// The page's query client, put in the registry by the boot beside the
// links, for an atom whose pushes move a request's cache (a worktree's
// removal, a carry-over rewriting project.json).
export const queryClientAtom = Atom.keepAlive(
  Atom.make<QueryClient | null>(null),
);

export const clientAtoms = Atom.runtime((get) => {
  const links = get(clientLinksAtom);
  return links === null
    ? Layer.effect(
        ClientLinks,
        Effect.die(new Error("the boot seeds the client's links")),
      )
    : Layer.succeed(ClientLinks, links);
});

// How many sessions to each peer have landed, which the boot counts
// (onSessionLanded). A peer's views start again on each new session,
// since one riding a session this side closed (a probe that found it
// dead) is never told it ended.
export const peerSessionAtom = Atom.family((_deviceId: string) =>
  Atom.keepAlive(Atom.make(0)),
);

// How many accounts this window has left, which the boot counts
// (onAccountLeft). What an atom keeps of a peer (its script runs, a
// removal under way) is the peer's, and a device of a later account
// with the same id (this machine on two accounts) starts over.
export const accountsLeftAtom = Atom.keepAlive(Atom.make(0));

// A device's refusal is a switch that may flip back (its command access
// off, its sharing off), so the view is asked again. The device's other
// failures (an unknown project) end the view.
const isRefusal = (error: unknown) =>
  isCommandRefusedError(error) || isNotSharingError(error);

// What ends a view for good: the device's own failure (an unknown
// project). A refusal is asked again, and so is finding no session to
// the peer, which is the link between dials, not an answer from it.
const endsView = (error: unknown) =>
  isContractError(error) &&
  !isRefusal(error) &&
  !isNoDirectConnectionError(error);

// When a view is asked again, while anyone still reads it (its readers
// gone, the stream ends with them, and a peer gone from the account has
// none): after a dropped link (a peer's session going, this machine's
// host restarting), from 250 ms doubling to 2 s, so a session landing
// shows within two seconds, each ask finding no session failing at once
// on this machine; after a refusal, a call to a peer that said no, from
// 2 s doubling to 30 s.
const REDIAL = Schedule.exponential("250 millis", 2).pipe(
  Schedule.modifyDelay(({ input, attempt, duration }) =>
    Effect.succeed(
      isRefusal(input)
        ? Duration.min(
            Duration.times(Duration.seconds(2), 2 ** Math.max(attempt - 1, 0)),
            Duration.seconds(30),
          )
        : Duration.min(duration, Duration.seconds(2)),
    ),
  ),
);

// How many asks a peer's view that never showed a value makes with no
// session to the peer before it gives up (hostViewAtom): about eight
// seconds on REDIAL's ladder (250 ms doubling to 2 s), room for a session
// still dialing at boot, as v2's three retries a second, two and four
// apart gave.
const PEER_TRIES = 7;

// One device's host modules: this machine's over its own link, a peer's
// over the hub hop.
const hostLinkOf = (deviceId: string, localDeviceId: string) =>
  Effect.gen(function* () {
    const { linkOf } = yield* ClientLinks;
    return deviceId === localDeviceId
      ? linkOf(projectsContract)
      : peerLink(linkOf(hubContract), deviceId);
  });

// A push's payloads on a link, decoded where they may come from another
// build (a peer's). One this build does not read is dropped, there
// being no caller to fail.
export function pushesOn<R extends ContractCall>(
  link: Link,
  push: R,
): Stream.Stream<Decoded<PayloadOf<R>>> {
  type A = Decoded<PayloadOf<R>>;
  const values = link.pushes(channelOf(push));
  if (link.local === true) return values as Stream.Stream<A>;
  const decode = Schema.decodeUnknownEffect(payloadOf(push));
  return values.pipe(
    Stream.mapEffect((value) =>
      decode(value).pipe(
        Effect.tapError(() =>
          Effect.logWarning(
            `dropped a ${channelOf(push)} push this build does not read`,
          ),
        ),
        Effect.option,
      ),
    ),
    Stream.filter(Option.isSome),
    Stream.map((some) => some.value),
  );
}

// A view's values on a link, decoded where they may come from another
// build (a peer's). One this build does not read ends the view, naming
// it.
export function viewOn<R extends ContractCall>(
  link: Link,
  view: R,
  input: unknown,
): Stream.Stream<Decoded<PayloadOf<R>>, unknown> {
  type A = Decoded<PayloadOf<R>>;
  const channel = channelOf(view);
  const values = link.view(channel, input);
  if (link.local === true) return values as Stream.Stream<A, unknown>;
  const decode = Schema.decodeUnknownEffect(payloadOf(view));
  return values.pipe(
    Stream.mapEffect((value) =>
      decode(value).pipe(
        Effect.mapError(
          (cause) => new UnreadableAnswerError({ channel, cause }),
        ),
      ),
    ),
  );
}

// One device's pushes on its host (contracts' callOf), as they come, for
// as long as the stream runs: this machine's over its own link, a peer's
// out of the hub hop.
export const hostPushes = <R extends ContractCall>(
  deviceId: string,
  localDeviceId: string,
  push: R,
) =>
  Stream.unwrap(
    Effect.map(hostLinkOf(deviceId, localDeviceId), (link) =>
      pushesOn(link, push),
    ),
  );

// The same for a module of the client's own (the hub's status).
export const clientPushes = <R extends ContractCall>(
  module: ContractModule,
  push: R,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { linkOf } = yield* ClientLinks;
      return pushesOn(linkOf(module), push);
    }),
  );

// One device's host calls as Promises, for an atom whose methods a
// caller outside an effect uses (the script runs): each runs on the
// atom's scope, so one still in flight ends with it, and its answer is
// decoded where it may come from another build.
export const hostCalls = (deviceId: string, localDeviceId: string) =>
  Effect.gen(function* () {
    const link = yield* hostLinkOf(deviceId, localDeviceId);
    const run = yield* FiberSet.makeRuntimePromise<never>();
    return <R extends ContractCall>(
      call: R,
      input: Encoded<InputOf<R>>,
    ): Promise<Decoded<OutputOf<R>>> =>
      run(
        link
          .call(channelOf(call), input)
          .pipe(
            Effect.flatMap((output) =>
              link.local === true
                ? Effect.succeed(output as Decoded<OutputOf<R>>)
                : Effect.orDie(
                    Schema.decodeUnknownEffect(outputOf(call))(output),
                  ),
            ),
          ),
      );
  });

// What a push stream does as each value comes besides keeping it (a
// toast, a cache write), run so that one that throws is logged and the
// next push still lands, as a subscriber's was.
export const heard = (what: string, follow: () => void) =>
  Effect.sync(follow).pipe(
    Effect.catchDefect((defect) =>
      Effect.logWarning(`a ${what} follower threw`, defect),
    ),
  );

// An AsyncResult atom whose effect answers at once (it only forks its
// streams, on a runtime built from what the boot seeded), read for its
// value.
export function valueNow<A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
): A {
  const result = registry.get(atom);
  if (AsyncResult.isSuccess(result)) return result.value;
  throw AsyncResult.isFailure(result)
    ? Cause.squash(result.cause)
    : new Error("the atom answers when read");
}

// A host view's values, decoded where they may come from another build
// (a peer's), as an atom. The device's own failure (an unknown project,
// a refused call) is what the view ends with; a dropped link is asked
// again, and a peer's view starts again on a new session to it. Kept a
// while after its last reader goes, so a page that comes back finds it
// streaming.
export function hostViewAtom<R extends ContractCall>(options: {
  readonly deviceId: string;
  // The view (contracts' callOf), whose values are decoded with its own
  // schema.
  readonly view: R;
  readonly input: Encoded<InputOf<R>>;
  // Each value as it comes, and the stream going (its last reader gone,
  // or the device's own failure), for a watcher outside React.
  readonly onValue?: (value: Decoded<PayloadOf<R>>) => void;
  readonly onStop?: () => void;
}): Atom.Atom<AsyncResult.AsyncResult<Decoded<PayloadOf<R>>, unknown>> {
  type A = Decoded<PayloadOf<R>>;
  const decode = Schema.decodeUnknownEffect(payloadOf(options.view));
  // Whether this view ever showed a value, for as long as the atom
  // lives: a new session starts its stream again, not its history.
  let seen = false;
  const valuesOn = (localDeviceId: string) => {
    // A peer's view that has never shown a value gives up after a few
    // asks, as v2's queries did, so a peer listed and never reached
    // reads empty and says so; a new session to it starts it again.
    // One that has shown rows keeps them, and redials for as long as
    // anything reads it. This machine's host is asked for good.
    const peer = options.deviceId !== localDeviceId;
    let failures = 0;
    return Stream.unwrap(
      Effect.map(hostLinkOf(options.deviceId, localDeviceId), (link: Link) =>
        link
          .view(channelOf(options.view), options.input)
          .pipe(
            Stream.mapEffect((value) =>
              link.local === true
                ? Effect.succeed(value as A)
                : Effect.orDie(decode(value)),
            ),
          ),
      ),
    ).pipe(
      Stream.tap(() =>
        Effect.sync(() => {
          seen = true;
          failures = 0;
        }),
      ),
      // A refusal is the peer's answer, which a grant may change: only
      // asks that found no way to it count.
      Stream.tapError((error) =>
        Effect.sync(() => {
          if (!isRefusal(error)) failures += 1;
        }),
      ),
      Stream.catchIf(
        (error) => endsView(error) || (peer && !seen && failures >= PEER_TRIES),
        (error) => Stream.die(error),
      ),
      Stream.retry(REDIAL),
      Stream.tap((value) => Effect.sync(() => options.onValue?.(value))),
      Stream.ensuring(Effect.sync(() => options.onStop?.())),
    );
  };
  return clientAtoms
    .atom((get) => {
      const localDeviceId = get(localDeviceIdAtom);
      if (options.deviceId !== localDeviceId) {
        get(peerSessionAtom(options.deviceId));
      }
      return valuesOn(localDeviceId);
    })
    .pipe(Atom.setIdleTTL("1 minute")) as Atom.Atom<
    AsyncResult.AsyncResult<A, unknown>
  >;
}

// Atom.optimistic takes no success that is still waiting while it holds
// one, and every value a live stream gives reads as waiting (more may
// come), so an optimistic copy over a view would never update. This
// restates each as settled. It is a readable of its own on purpose:
// Atom.map hands the refresh Atom.optimistic asks for at a transition's
// end on to the stream, which resubscribes the view; recomputing here
// reads the value the stream already has.
export function optimisticView<A, E>(
  view: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  return Atom.optimistic(
    Atom.readable((get) => {
      const result = get(view);
      return AsyncResult.isSuccess(result) && result.waiting
        ? AsyncResult.success(result.value)
        : result;
    }),
  );
}

// An edit laid over a view as Atom.optimistic shows it (a transition of
// its own), until `end`: then the view shows through again, re-read as
// it stands, or, for a change that failed, as it stood. `replace` swaps
// the edit for another while it holds (the host's answer for the guess).
export function overlay<A, E>(
  registry: AtomRegistry.AtomRegistry,
  shown: ReturnType<typeof optimisticView<A, E>>,
  edit: (value: A) => A,
): {
  readonly replace: (edit: (value: A) => A) => void;
  readonly end: (failed?: boolean) => void;
} {
  const current = registry.get(shown);
  if (!AsyncResult.isSuccess(current)) {
    return { replace: () => {}, end: () => {} };
  }
  const base = current.value;
  const held = (next: (value: A) => A) =>
    AsyncResult.success<AsyncResult.AsyncResult<A, E>, unknown>(
      AsyncResult.success(next(base)),
      { waiting: true },
    );
  const transition = Atom.make<
    AsyncResult.AsyncResult<AsyncResult.AsyncResult<A, E>, unknown>
  >(held(edit));
  registry.set(shown, transition);
  let ended = false;
  return {
    replace: (next) => {
      if (!ended) registry.set(transition, held(next));
    },
    end: (failed = false) => {
      if (ended) return;
      ended = true;
      registry.set(
        transition,
        failed
          ? AsyncResult.failure(Cause.fail("the change failed"))
          : AsyncResult.success(AsyncResult.success(base)),
      );
    },
  };
}

// An overlay that ends by itself once the view reads `caughtUp` (or
// `withinMs` passes), or with "next", at the view's next value, which is
// newer than the edit laid over it: a row the host has just made,
// removed or answered with, shown before its stream says so, for a
// caller that moves on to (or off) that row at once.
export function layOver<A, E>(
  registry: AtomRegistry.AtomRegistry,
  shown: ReturnType<typeof optimisticView<A, E>>,
  view: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  edit: (value: A) => A,
  until: { caughtUp: (value: A) => boolean; withinMs?: number } | "next",
): void {
  const laid = overlay(registry, shown, edit);
  endWith(registry, view, laid, until);
}

export function endWith<A, E>(
  registry: AtomRegistry.AtomRegistry,
  view: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  laid: { readonly end: () => void },
  until: { caughtUp: (value: A) => boolean; withinMs?: number } | "next",
): void {
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = () => {
    clearTimeout(timer);
    unsubscribe?.();
    laid.end();
  };
  if (until !== "next") timer = setTimeout(end, until.withinMs ?? 5_000);
  unsubscribe = registry.subscribe(view, (result) => {
    if (!AsyncResult.isSuccess(result)) return;
    if (until === "next" || until.caughtUp(result.value)) end();
  });
}

// A mutation on one device's host, as an atom function: its call over
// the device's link.
export function hostCallFn<Arg>(options: {
  readonly deviceId: string;
  readonly call: (arg: Arg) => { channel: string; input: unknown };
}) {
  return clientAtoms.fn((arg: Arg, get) =>
    Effect.flatMap(
      hostLinkOf(options.deviceId, get(localDeviceIdAtom)),
      (link) => {
        const { channel, input } = options.call(arg);
        return link.call(channel, input);
      },
    ),
  );
}

// What a container reads off a view, in the shape it reads a query in:
// the value once there is one, the failure, and whether it is still
// waiting for its first value.
export type ViewState<A> = {
  readonly data: A | undefined;
  readonly error: Error | null;
  readonly isError: boolean;
  readonly isPending: boolean;
  readonly isLoading: boolean;
};

export function viewStateOf<A>(
  result: AsyncResult.AsyncResult<A, unknown>,
  live: boolean,
): ViewState<A> {
  const data = AsyncResult.isSuccess(result)
    ? result.value
    : AsyncResult.getOrElse(result, () => undefined);
  const failure = AsyncResult.isFailure(result)
    ? Cause.squash(result.cause)
    : null;
  return {
    data,
    error:
      failure === null
        ? null
        : failure instanceof Error
          ? failure
          : new Error(String(failure)),
    isError: failure !== null,
    isPending: data === undefined && failure === null,
    isLoading: live && data === undefined && failure === null,
  };
}

// The view of nothing: a scope with no host behind it reads no view.
export const noView: Atom.Atom<AsyncResult.AsyncResult<never, never>> =
  Atom.make(AsyncResult.initial<never, never>());
