// This device's switches on the account page, under `sm devices`: each
// set with on or off and shown without. The host keeps them where the
// page does (control:access).
import type { ControlAccess } from "@shigomori/contracts/modules/control";
import { byPlatform } from "@shigomori/engine/platform";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import { askHost } from "../askHost.ts";
import { UsageError } from "../errors.ts";
import { emit, out, Output, styles } from "../output.ts";

const accessSwitch = (name: string, key: keyof ControlAccess, label: string) =>
  Command.make(
    name,
    { mode: Argument.String("on|off").pipe(Argument.optional) },
    (input) =>
      Effect.gen(function* () {
        const { json, stdoutColor, binaryName } = yield* Effect.service(Output);
        const mode = Option.getOrUndefined(input.mode);
        if (mode !== undefined && mode !== "on" && mode !== "off") {
          return yield* new UsageError({
            problem: `Usage: ${binaryName} devices ${name} [on|off]`,
          });
        }
        const access =
          mode === undefined
            ? yield* askHost<ControlAccess>("control:access")
            : yield* askHost<ControlAccess>("control:setAccess", {
                [key]: mode === "on",
              });
        if (json) return yield* emit({ ok: true, ...access });
        const line = `${label}: ${access[key] === true ? "on" : "off"}`;
        yield* out(mode === undefined ? line : styles(stdoutColor).green(line));
      }),
  );

export const accessSwitches = [
  accessSwitch("share", "share", "Share with other devices"),
  accessSwitch("control", "control", "Allow control from other devices"),
  // The service keeps a Linux host running (`service`).
  ...byPlatform({
    darwin: [
      accessSwitch("reachable", "keepReachable", "Keep this device reachable"),
    ],
    linux: [],
  }),
];
