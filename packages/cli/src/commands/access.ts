// This device's switches on the account page, under `sm devices`: each
// set with on or off and shown without. The host keeps them where the
// page does (control:access).
import type { ControlAccess } from "@shigomori/contracts/modules/control";
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
        const before = yield* askHost<ControlAccess>("control:access");
        if (before[key] === null) {
          return yield* new UsageError({
            problem: `On Linux the service keeps the host running (\`${binaryName} service status\`).`,
          });
        }
        const access =
          mode === undefined
            ? before
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
  accessSwitch("reachable", "keepReachable", "Keep this device reachable"),
] as const;
