// The React side of the host views (atoms.ts): a view's state in the
// shape a container reads a query in, and a wait for a view to show
// what a mutation just made, before a caller moves into it.
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as AsyncResultValue from "effect/reactivity/AsyncResult";
import { use } from "react";
import { noView, type ViewState, viewStateOf } from "./atoms";

export type LiveViewState<A> = ViewState<A> & {
  // Asks the view again from the start (a retry after it failed).
  readonly refetch: () => void;
};

export function useView<A>(
  view: Atom.Atom<AsyncResult.AsyncResult<A, unknown>> | null,
): LiveViewState<A> {
  const registry = use(RegistryContext);
  return {
    ...viewStateOf(useAtomValue(view ?? noView), view !== null),
    refetch: () => {
      if (view !== null) registry.refresh(view);
    },
  };
}

// The view's first value, or undefined if none comes within `withinMs`
// (or it fails), for a caller that reads it once.
export function firstValueOf<A>(
  registry: AtomRegistry.AtomRegistry,
  view: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  withinMs = 5_000,
): Promise<A | undefined> {
  let value: A | undefined;
  return whenViewShows(
    registry,
    view,
    (shown) => {
      value = shown;
      return true;
    },
    withinMs,
  ).then(() => value);
}

// Settles once the view's value passes `shows`, or after `withinMs`
// whatever it shows (the caller goes on either way, as it would with a
// list a moment stale).
export function whenViewShows<A>(
  registry: AtomRegistry.AtomRegistry,
  view: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  shows: (value: A) => boolean,
  withinMs = 5_000,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe: (() => void) | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve();
    };
    const timer = setTimeout(finish, withinMs);
    unsubscribe = registry.subscribe(
      view,
      (result) => {
        if (AsyncResultValue.isSuccess(result) && shows(result.value)) {
          finish();
        }
      },
      { immediate: true },
    );
    if (done) unsubscribe();
  });
}

export function useRegistry(): AtomRegistry.AtomRegistry {
  return use(RegistryContext);
}

// Several views of one kind read together, by key (null for one with
// nothing to read), as one atom, so the array keeps its identity while
// none of them changed.
const SEPARATOR = "\u0001";

export function viewsOf<A>(
  atomOf: (key: string) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
) {
  return Atom.family((joined: string) =>
    Atom.readable((get) =>
      joined === ""
        ? []
        : joined
            .split(SEPARATOR)
            .map((key) => (key === "" ? get(noView) : get(atomOf(key)))),
    ),
  );
}

export function useViews<A>(
  views: ReturnType<typeof viewsOf<A>>,
  keys: readonly (string | null)[],
): readonly ViewState<A>[] {
  const joined = keys.map((key) => key ?? "").join(SEPARATOR);
  const results = useAtomValue(
    views(joined),
  ) as readonly AsyncResult.AsyncResult<A, unknown>[];
  return results.map((result, at) =>
    viewStateOf(result, joined.split(SEPARATOR)[at] !== ""),
  );
}
