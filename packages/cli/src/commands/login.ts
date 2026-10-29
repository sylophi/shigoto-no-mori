// sm login and sm logout: this machine on the account, signed in or out
// from the terminal, which is what a machine with no windows has for
// the app's account page. The host does the work (the login contract):
// it asks Clerk for a code, which the person approves from another
// device. On a Mac the app's account page signs in. The rest of the
// page is under `sm devices` (deviceCommands).
import { DEVICE_ICONS, isDeviceIcon } from "@shigomori/contracts/deviceIcon";
import type {
  LoginCode,
  LoginStatus,
} from "@shigomori/contracts/modules/login";
import { byPlatform } from "@shigomori/engine/platform";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { askHost } from "../askHost.ts";
import { Cancelled, UsageError } from "../errors.ts";
import { rest } from "../here.ts";
import { emit, note, out, Output, styles } from "../output.ts";
import { confirm, interactive } from "../prompt.ts";

const onLinux = byPlatform({
  darwin: Effect.fail(
    new UsageError({
      problem: "On a Mac you sign in from the app's account page.",
    }),
  ),
  linux: Effect.void,
});

export const login = Command.make("login", { rest }, () =>
  Effect.gen(function* () {
    yield* onLinux;
    const { json, stdoutColor, stderrColor } = yield* Effect.service(Output);
    const status = yield* askHost<LoginStatus>("login:status");
    if (status.signedIn) {
      if (json) return yield* emit({ ok: true, ...status });
      return yield* out(
        `Already signed in. This machine is "${status.deviceName}" on your account.`,
      );
    }
    const code = yield* askHost<LoginCode>("login:start");
    const { bold, dim } = styles(stderrColor);
    yield* note(
      code.verificationUriComplete === undefined
        ? `To sign this machine in, open ${bold(code.verificationUri)} and enter ${bold(code.userCode)}.`
        : `To sign this machine in, open ${bold(code.verificationUriComplete)} and check it shows ${bold(code.userCode)}.`,
    );
    yield* note(dim("Waiting for you to approve it…"));
    const signedIn = yield* askHost<LoginStatus>("login:finish", code);
    if (json) return yield* emit({ ok: true, ...signedIn });
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
    const status = yield* askHost<LoginStatus>("login:status");
    if (status.signedIn) yield* askHost<void>("login:signOut");
    if (json) return yield* emit({ ok: true, signedIn: false });
    yield* out(
      status.signedIn ? "Signed out." : "This machine isn't signed in.",
    );
  }),
);

const rename = Command.make(
  "rename",
  { name: Argument.String("name") },
  ({ name }) =>
    Effect.gen(function* () {
      const { json } = yield* Effect.service(Output);
      const status = yield* askHost<LoginStatus>("login:rename", name);
      if (json) return yield* emit({ ok: true, ...status });
      yield* out(`This machine is "${status.deviceName}" on your account.`);
    }),
);

const icon = Command.make(
  "icon",
  { icon: Argument.String("icon").pipe(Argument.optional) },
  (input) =>
    Effect.gen(function* () {
      const { json, stdoutColor } = yield* Effect.service(Output);
      const picked = Option.getOrUndefined(input.icon);
      if (picked !== undefined && !isDeviceIcon(picked)) {
        return yield* new UsageError({
          problem: `"${picked}" isn't an icon. Pick one of ${DEVICE_ICONS.join(", ")}.`,
        });
      }
      const status =
        picked === undefined
          ? yield* askHost<LoginStatus>("login:status")
          : yield* askHost<LoginStatus>("login:setIcon", picked);
      if (json) return yield* emit({ ok: true, ...status });
      const { dim, green } = styles(stdoutColor);
      const line = `Icon: ${status.deviceIcon}`;
      if (picked !== undefined) return yield* out(green(line));
      yield* out(line);
      yield* out(dim(DEVICE_ICONS.join(" ")));
    }),
);

const remove = Command.make(
  "remove",
  {
    device: Argument.String("device"),
    yes: Flag.Boolean("yes").pipe(Flag.withAlias("y"), Flag.withDefault(false)),
  },
  ({ device, yes }) =>
    Effect.gen(function* () {
      const { json } = yield* Effect.service(Output);
      if (!yes) {
        if (!(yield* interactive)) {
          return yield* new UsageError({
            problem: `Refusing to remove "${device}" without confirmation. Re-run with --yes, or interactively.`,
          });
        }
        const sure = yield* confirm(
          `Remove "${device}" from your account? It's signed out there.`,
        );
        if (!sure) return yield* new Cancelled();
      }
      const removed = yield* askHost<string>("login:removeDevice", device);
      if (json) return yield* emit({ ok: true, removed });
      yield* out(`Removed "${removed}" from your account.`);
    }),
);

// What the account page sets that `sm devices` has no switch for.
export const deviceCommands = byPlatform({
  darwin: [],
  linux: [rename, icon, remove],
});
