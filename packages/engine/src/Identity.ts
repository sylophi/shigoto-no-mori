import { normalizeRemoteUrl } from "@shigomori/contracts/predicates/remoteUrl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Git from "./Git.ts";

// What makes the same project on two devices the same repo. Derived,
// never stored.
export type RepoIdentity = {
  // `root:<sha>` of the default ref's root commit, else
  // `remote:<host/owner/repo>` of the primary remote, else none. Null
  // also when git couldn't be asked, so it never matches across devices.
  readonly identity: string | null;
  // The primary fetch remote as `host/owner/repo`, which the sidebar
  // groups projects by owner off. Null without a network remote.
  readonly remote: string | null;
};

export class Identity extends Context.Service<
  Identity,
  {
    readonly of: (projectPath: string) => Effect.Effect<RepoIdentity>;
  }
>()("sm/engine/Identity") {}

// upstream, then origin, then the rest by name.
const byPrecedence = (names: ReadonlyArray<string>) => [
  ...["upstream", "origin"].filter((name) => names.includes(name)),
  ...names
    .filter((name) => name !== "upstream" && name !== "origin")
    .toSorted(),
];

const make = Effect.gen(function* () {
  const git = yield* Git.Git;

  // The primary fetch remote among those whose URL normalizes.
  const primaryRemote = (projectPath: string) =>
    git.run(projectPath, ["remote", "-v"]).pipe(
      Effect.map((stdout) => {
        const usable = new Map<string, string>();
        for (const line of stdout.split("\n")) {
          const match = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line);
          const [, name, url] = match ?? [];
          if (name === undefined || url === undefined || usable.has(name)) {
            continue;
          }
          const normalized = normalizeRemoteUrl(url);
          if (normalized !== null) usable.set(name, normalized);
        }
        const [first] = byPrecedence([...usable.keys()]);
        return first === undefined ? null : (usable.get(first) ?? null);
      }),
      Effect.orElseSucceed(() => null),
    );

  // `root:<sha>` of the parentless commit the default ref reaches (never
  // HEAD, which would name the checkout, not the repo). None for a
  // shallow clone, whose root is fake, or without a default ref; a
  // failed git run fails, which reads as no identity.
  const rootCommitKey = (projectPath: string) =>
    Effect.gen(function* () {
      const shallow = yield* git.run(projectPath, [
        "rev-parse",
        "--is-shallow-repository",
      ]);
      if (shallow.trim() !== "false") return Option.none<string>();
      const ref = yield* git.resolveDefaultRef(projectPath);
      if (Option.isNone(ref)) return Option.none<string>();
      const roots = (yield* git.run(projectPath, [
        "rev-list",
        "--max-parents=0",
        ref.value,
        "--",
      ]))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .toSorted();
      return Option.map(
        Option.fromNullishOr(roots[0]),
        (root) => `root:${root}`,
      );
    });

  const of = Effect.fn("Identity.of")(function* (projectPath: string) {
    const remote = yield* primaryRemote(projectPath);
    const identity = yield* rootCommitKey(projectPath).pipe(
      Effect.map(
        Option.getOrElse(() => (remote === null ? null : `remote:${remote}`)),
      ),
      Effect.orElseSucceed(() => null),
    );
    return { identity, remote };
  });

  return Identity.of({ of });
});

export const layer = Layer.effect(Identity, make);
