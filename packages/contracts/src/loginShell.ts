// Which shell is the user's, from its two readings: $SHELL, and the
// account's entry in the user database. In the user's own environment
// (a terminal's, or the app's once rebuilt at launch) $SHELL is their
// choice and comes first. In one a launcher handed over (the packaged
// app's before the rebuild) it is the launcher's, so the account's
// does. The engine's `Lifecycle.loginShell` reads it for everything
// that runs in the shell, the launch rebuild (app/shared/shellEnv.ts)
// for the shell it captures. "" when neither names one. The second
// reading runs only when the first named none.
import * as Effect from "effect/Effect";

export const loginShellOf = <E, R>(input: {
  readonly environment: "own" | "launcher";
  readonly shellVar: string;
  readonly account: Effect.Effect<string, E, R>;
}): Effect.Effect<string, E, R> => {
  const fromVar = Effect.succeed(input.shellVar);
  const [first, then] =
    input.environment === "own"
      ? [fromVar, input.account]
      : [input.account, fromVar];
  return Effect.filterOrElse(
    first,
    (shell) => shell !== "",
    () => then,
  );
};
