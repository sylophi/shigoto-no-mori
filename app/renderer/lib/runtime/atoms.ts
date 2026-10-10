// The atoms a container reads a host view through (app/DESIGN.md,
// "Views and containers"): each on the client's runtime, over the links
// window.api rides, which the boot seeds into the window's registry
// (clientLinksAtom). A request stays a React Query query.
import type { Decoded, Encoded } from "@shigomori/contracts/codec";
import {
  type ContractCall,
  channelOf,
  type InputOf,
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
import * as Layer from "effect/Layer";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Link } from "@shared/ipc/transport";
import { ClientLinks } from "./ClientLinks";
import { peerLink } from "./peerLink";

// Put in the registry by the boot, before anything reads a view.
export const clientLinksAtom = Atom.keepAlive(
  Atom.make<ClientLinks["Service"] | null>(null),
);

const clientAtoms = Atom.runtime((get) => {
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

// One device's host modules: this machine's over its own link, a peer's
// over the hub hop.
const hostLinkOf = (deviceId: string, localDeviceId: string) =>
  Effect.gen(function* () {
    const { linkOf } = yield* ClientLinks;
    return deviceId === localDeviceId
      ? linkOf(projectsContract)
      : peerLink(linkOf(hubContract), deviceId);
  });

// A host view's values, decoded where they may come from another build
// (a peer's), as an atom. The device's own failure (an unknown project,
// a refused call) is what the view ends with; a dropped link is asked
// again, and a peer's view starts again on a new session to it. Kept a
// while after its last reader goes, so a page that comes back finds it
// streaming.
export function hostViewAtom<R extends ContractCall>(options: {
  readonly deviceId: string;
  readonly localDeviceId: string;
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
  const values = Stream.unwrap(
    Effect.map(
      hostLinkOf(options.deviceId, options.localDeviceId),
      (link: Link) =>
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
    Stream.catchIf(endsView, (error) => Stream.die(error)),
    Stream.retry(REDIAL),
    Stream.tap((value) => Effect.sync(() => options.onValue?.(value))),
    Stream.ensuring(Effect.sync(() => options.onStop?.())),
  );
  const remote = options.deviceId !== options.localDeviceId;
  return clientAtoms
    .atom((get) => {
      if (remote) get(peerSessionAtom(options.deviceId));
      return values;
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
  readonly localDeviceId: string;
  readonly call: (arg: Arg) => { channel: string; input: unknown };
}) {
  return clientAtoms.fn((arg: Arg) =>
    Effect.flatMap(
      hostLinkOf(options.deviceId, options.localDeviceId),
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
