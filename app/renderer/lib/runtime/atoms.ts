// The atoms a container reads a host view or a push stream through
// (EFFECT.md, section 10): each on the client's runtime, over the page's
// api (Api.ts), which the boot seeds into the page's registry
// (apiAtom) with this device's id (localDeviceIdAtom) and the page's
// query client (queryClientAtom). A request stays a React Query query.
import {
  isContractError,
  isNoDirectConnectionError,
  isPeerRefusal,
  isRemoteCallError,
} from "@shigomori/contracts/errors";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { QueryClient } from "@tanstack/react-query";
import { Api, type ClientApi, type HostApi } from "./Api";

// Put in the registry by the boot, before anything reads a view.
export const apiAtom = Atom.keepAlive(Atom.make<ClientApi | null>(null));

// This device's id, put in the registry by the boot beside the api:
// a view of it rides this machine's own link, any other device's the
// hub hop.
export const localDeviceIdAtom = Atom.keepAlive(Atom.make(""));

// The page's query client, put in the registry by the boot beside the
// api, for an atom whose pushes move a request's cache (a worktree's
// removal, a carry-over rewriting project.json).
export const queryClientAtom = Atom.keepAlive(
  Atom.make<QueryClient | null>(null),
);

export const clientAtoms = Atom.runtime((get) => {
  const api = get(apiAtom);
  return api === null
    ? Layer.effect(
        Api,
        Effect.die(new Error("the boot seeds the client's api")),
      )
    : Layer.succeed(Api, api);
});

// One device's api: the page's for this machine, a peer's (peerApi)
// over the hub hop.
export const deviceApi = (deviceId: string, localDeviceId: string) =>
  Effect.map(
    Api,
    (api): HostApi =>
      deviceId === localDeviceId ? api : api.peerApi(deviceId),
  );

// A stream on one device's api.
export const deviceStream = <A, E>(
  deviceId: string,
  localDeviceId: string,
  stream: (api: HostApi) => Stream.Stream<A, E>,
): Stream.Stream<A, E, Api> =>
  Stream.unwrap(Effect.map(deviceApi(deviceId, localDeviceId), stream));

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
// on this machine. After a refusal, a call to a peer that said no, from
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

// State a device or this window's shell keeps whole and pushes on
// every change (the updater's, the guide's), as its stream: the pushes,
// with a read as the seed, kept only if no push reached the stream's
// reader between the read's start and its answer, so the order is the
// reader's, not the fibers'. A read that fails fails the stream.
type PushedState<A> = {
  readonly read: Effect.Effect<A, unknown>;
  readonly push: Stream.Stream<A>;
};

function pushedState<A>({
  read,
  push,
}: PushedState<A>): Stream.Stream<A, unknown> {
  let pushes = 0;
  const seed = Effect.suspend(() => {
    const after = pushes;
    return Effect.map(read, (value) => ({ value, after }));
  });
  return Stream.merge(
    push.pipe(Stream.map((value) => ({ value, after: undefined }))),
    Stream.fromEffect(seed),
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

// The same for a module of this window's shell, asked again as a view
// is (redialing).
export const shellState = <A>(state: (api: ClientApi) => PushedState<A>) => {
  const memory = { seen: false };
  return redialing(
    Stream.unwrap(Effect.map(Api, (api) => pushedState(state(api)))),
    { peer: false, memory },
  );
};

// The same for one device's host module: it starts again on each new
// session to the host, which covers a restart into a new build.
export const hostStateAtom = <A>(
  deviceId: string,
  state: (api: HostApi) => PushedState<A>,
) => {
  const memory = { seen: false };
  return clientAtoms.atom((get) => {
    const localDeviceId = get(localDeviceIdAtom);
    const peer = deviceId !== localDeviceId;
    get(hostSessionAtom(deviceId));
    return redialing(
      deviceStream(deviceId, localDeviceId, (api) => pushedState(state(api))),
      { peer, memory },
    );
  });
};

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
// and says so, and a new session to it starts it again. One that has shown
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

// A host view's values as an atom. The device's own failure (an
// unknown project) is what the view ends with. A refusal and a dropped
// link are asked again (REDIAL), and a peer's view starts again on a new
// session to it. Kept a while after its last reader goes, so a page
// that comes back finds it streaming.
export function hostViewAtom<A>(options: {
  readonly deviceId: string;
  // The view, on the device's api.
  readonly view: (api: HostApi) => Stream.Stream<A, unknown>;
  // Each value as it comes, and the stream going (its last reader gone,
  // or the device's own failure), for a watcher outside React.
  readonly onValue?: (value: A) => void;
  readonly onStop?: () => void;
  // How long it keeps streaming after its last reader goes, a minute
  // unless said.
  readonly idle?: Duration.Input;
}): Atom.Atom<AsyncResult.AsyncResult<A, unknown>> {
  const memory = { seen: false };
  return clientAtoms
    .atom((get) => {
      const localDeviceId = get(localDeviceIdAtom);
      const peer = options.deviceId !== localDeviceId;
      if (peer) get(hostSessionAtom(options.deviceId));
      return redialing(
        deviceStream(options.deviceId, localDeviceId, options.view),
        { peer, memory },
      ).pipe(
        Stream.tap((value) => Effect.sync(() => options.onValue?.(value))),
        Stream.ensuring(Effect.sync(() => options.onStop?.())),
      );
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
// end on to the stream, which resubscribes the view, while recomputing
// here reads the value the stream already has.
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
