// The atoms a container reads a host view or a push stream through
// (EFFECT.md, section 10): each on the client's runtime, over the links
// the page's api rides, which the boot seeds into the page's registry
// (clientLinksAtom) with this device's id (localDeviceIdAtom) and the
// page's query client (queryClientAtom). A request stays a React Query
// query.
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
  isContractError,
  isNoDirectConnectionError,
  isPeerRefusal,
  isRemoteCallError,
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

// How many sessions to each device's host have landed, which the boot
// counts: a peer's (onSessionLanded), and this machine's link landing
// on its host again after a drop (startLocalHost). A peer's views start
// again on each new session, since one riding a session this side
// closed (a probe that found it dead) is never told it ended. What an
// atom folds from pushes starts again on either, since the pushes that
// would have ended it went with the session or the host that died.
export const hostSessionAtom = Atom.family((_deviceId: string) =>
  Atom.keepAlive(Atom.make(0)),
);

// How many accounts this window has left, which the boot counts
// (onAccountLeft). What an atom keeps of a peer (its script runs, a
// removal under way) is the peer's, and a device of a later account
// with the same id (this machine on two accounts) starts over.
export const accountsLeftAtom = Atom.keepAlive(Atom.make(0));

// What ends a view for good: the device's own failure (an unknown
// project), or its read failing in its own words (a RemoteCallError),
// which asking again every few seconds would only repeat unseen. A
// refusal is asked again, and so is finding no session to the peer,
// which is the link between dials, not an answer from it.
const endsView = (error: unknown) =>
  isRemoteCallError(error) ||
  (isContractError(error) &&
    !isPeerRefusal(error) &&
    !isNoDirectConnectionError(error));

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
      isPeerRefusal(input)
        ? Duration.min(
            Duration.times(Duration.seconds(2), 2 ** Math.max(attempt - 1, 0)),
            Duration.seconds(30),
          )
        : Duration.min(duration, Duration.seconds(2)),
    ),
  ),
);

// How many asks a peer's view that never showed a value makes with no
// session to the peer before it gives up (redialing): about eight
// seconds on REDIAL's ladder (250 ms doubling to 2 s), room for a session
// still dialing at boot.
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

// A push's payloads on a link, decoded unless the link is to this
// machine's own app (a peer's cross the hub hop untyped). One that
// doesn't read is dropped, there being no caller to fail.
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

// A view's values on a link, decoded unless the link is to this
// machine's own app. One that doesn't read ends the view.
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
  return values.pipe(Stream.mapEffect((value) => decode(value)));
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

// State a device or this window's shell keeps whole and pushes on
// every change (the updater's, the guide's), as its stream: the pushes,
// with a read as the seed, kept only if no push reached the stream's
// reader between the read's start and its answer, so the order is the
// reader's, not the fibers'. A read that fails fails the stream.
export function pushedState<R extends ContractCall, P extends ContractCall>(
  link: Link,
  options: { readonly read: R; readonly push: P },
): Stream.Stream<Decoded<PayloadOf<P>>, unknown, ClientLinks> {
  type A = Decoded<PayloadOf<P>>;
  let pushes = 0;
  const read = Effect.suspend(() => {
    const after = pushes;
    return link.call(channelOf(options.read), undefined).pipe(
      Effect.flatMap((output) =>
        link.local === true
          ? Effect.succeed(output as A)
          : Effect.orDie(
              Schema.decodeUnknownEffect(outputOf(options.read))(output),
            ),
      ),
      Effect.map((value) => ({ value: value as A, after })),
    );
  });
  return Stream.merge(
    (pushesOn(link, options.push) as Stream.Stream<A>).pipe(
      Stream.map((value) => ({ value, after: undefined })),
    ),
    Stream.fromEffect(read),
  ).pipe(
    Stream.filter((next) => {
      if (next.after === undefined) {
        pushes += 1;
        return true;
      }
      return next.after === pushes;
    }),
    Stream.map((next) => next.value),
  );
}

// The same over this window's own link for a module of its shell,
// asked again as a view is (redialing).
export const shellState = <R extends ContractCall, P extends ContractCall>(
  module: ContractModule,
  options: Parameters<typeof pushedState<R, P>>[1],
) => {
  const memory = { seen: false };
  return redialing(
    Stream.unwrap(
      Effect.gen(function* () {
        const { linkOf } = yield* ClientLinks;
        return pushedState(linkOf(module), options);
      }),
    ),
    { peer: false, memory },
  );
};

// The same for one device's host module: it starts again on each new
// session to the host, which covers a restart into a new build.
export const hostStateAtom = <R extends ContractCall, P extends ContractCall>(
  deviceId: string,
  options: Parameters<typeof pushedState<R, P>>[1],
) => {
  const memory = { seen: false };
  return clientAtoms.atom((get) => {
    const localDeviceId = get(localDeviceIdAtom);
    const peer = deviceId !== localDeviceId;
    get(hostSessionAtom(deviceId));
    return redialing(
      Stream.unwrap(
        Effect.map(hostLinkOf(deviceId, localDeviceId), (link) =>
          pushedState(link, options),
        ),
      ),
      { peer, memory },
    );
  });
};

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

// A view's stream (or pushed state's) asked again on REDIAL while
// anything reads it, ended by the device's own failure (endsView). A
// peer's that has never shown a value gives up after a few asks that
// found no way to it, so a peer listed and never reached reads empty
// and says so; a new session to it starts it again. One that has shown
// a value keeps it and redials. This machine's is asked for good.
// `memory` lives as long as the atom: a new session starts its stream
// again, not its history.
function redialing<A, R>(
  values: Stream.Stream<A, unknown, R>,
  options: { readonly peer: boolean; readonly memory: { seen: boolean } },
): Stream.Stream<A, never, R> {
  let failures = 0;
  return values.pipe(
    Stream.tap(() =>
      Effect.sync(() => {
        options.memory.seen = true;
        failures = 0;
      }),
    ),
    // A refusal is the peer's answer, which a grant may change: only
    // asks that found no way to it count.
    Stream.tapError((error) =>
      Effect.sync(() => {
        if (!isPeerRefusal(error)) failures += 1;
      }),
    ),
    Stream.catchIf(
      (error) =>
        endsView(error) ||
        (options.peer && !options.memory.seen && failures >= PEER_TRIES),
      (error) => Stream.die(error),
    ),
    Stream.retry(REDIAL),
  ) as Stream.Stream<A, never, R>;
}

// A host view's values, decoded where they may come from another build
// (a peer's), as an atom. The device's own failure (an unknown project)
// is what the view ends with; a refusal and a dropped link are asked
// again (REDIAL), and a peer's view starts again on a new session to it. Kept a
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
  // How long it keeps streaming after its last reader goes, a minute
  // unless said.
  readonly idle?: Duration.Input;
}): Atom.Atom<AsyncResult.AsyncResult<Decoded<PayloadOf<R>>, unknown>> {
  type A = Decoded<PayloadOf<R>>;
  const decode = Schema.decodeUnknownEffect(payloadOf(options.view));
  const memory = { seen: false };
  const valuesOn = (localDeviceId: string) => {
    const peer = options.deviceId !== localDeviceId;
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
      (values) => redialing(values, { peer, memory }),
      Stream.tap((value) => Effect.sync(() => options.onValue?.(value))),
      Stream.ensuring(Effect.sync(() => options.onStop?.())),
    );
  };
  return clientAtoms
    .atom((get) => {
      const localDeviceId = get(localDeviceIdAtom);
      if (options.deviceId !== localDeviceId) {
        get(hostSessionAtom(options.deviceId));
      }
      return valuesOn(localDeviceId);
    })
    .pipe(Atom.setIdleTTL(options.idle ?? "1 minute")) as Atom.Atom<
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
