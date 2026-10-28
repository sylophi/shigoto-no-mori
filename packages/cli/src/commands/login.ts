// sm login and sm logout: this machine on the account, signed in or out
// from the terminal, which is what a machine with no windows has for
// the app's account page. The host does the work (the login contract):
// it asks Clerk for a code, which the person approves from another
// device. On a Mac the app's account page signs in.
import type {
  LoginCode,
  LoginStatus,
} from "@shigomori/contracts/modules/login";
import * as Control from "@shigomori/engine/Control";
import { byPlatform } from "@shigomori/engine/platform";
import * as Effect from "effect/Effect";
import * as Command from "effect/cli/Command";
import { UsageError } from "../errors.ts";
import { rest } from "../here.ts";
import { emit, note, out, Output, styles } from "../output.ts";

const onLinux = byPlatform({
  darwin: Effect.fail(
    new UsageError({
      problem: "On a Mac you sign in from the app's account page.",
    }),
  ),
  linux: Effect.void,
});

// One call to the host, its answer as the contract types it: the
// loopback's client decoded it before Control handed it on.
const ask = <T>(channel: string, input?: unknown) =>
  Effect.flatMap(
    Control.Control,
    (control) =>
      control.call(channel, input) as Effect.Effect<T, Control.ControlError>,
  );

export const login = Command.make("login", { rest }, () =>
  Effect.gen(function* () {
    yield* onLinux;
    const { json, stdoutColor, stderrColor } = yield* Effect.service(Output);
    const status = yield* ask<LoginStatus>("login:status");
    if (status.signedIn) {
      if (json) return yield* emit(status);
      return yield* out(
        `Already signed in. This machine is "${status.deviceName}" on your account.`,
      );
    }
    const code = yield* ask<LoginCode>("login:start");
    const { bold, dim } = styles(stderrColor);
    yield* note(
      code.verificationUriComplete === undefined
        ? `To sign this machine in, open ${bold(code.verificationUri)} and enter ${bold(code.userCode)}.`
        : `To sign this machine in, open ${bold(code.verificationUriComplete)} and check it shows ${bold(code.userCode)}.`,
    );
    yield* note(dim("Waiting for you to approve it…"));
    const signedIn = yield* ask<LoginStatus>("login:finish", code);
    if (json) return yield* emit(signedIn);
    const { green } = styles(stdoutColor);
    yield* out(
      `${green("Signed in.")} This machine is "${signedIn.deviceName}" on your account.`,
    );
  }),
);

export const logout = Command.make("logout", { rest }, () =>
  Effect.gen(function* () {
    yield* onLinux;
    const { json } = yield* Effect.service(Output);
    const status = yield* ask<LoginStatus>("login:status");
    if (status.signedIn) yield* ask<void>("login:signOut");
    if (json) return yield* emit({ signedIn: false });
    yield* out(
      status.signedIn ? "Signed out." : "This machine isn't signed in.",
    );
  }),
);
