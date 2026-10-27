import * as Schema from "effect/Schema";
import { push, defineContract, invoke } from "../contract.ts";
import { DeviceIdSchema } from "../hubProtocol.ts";
import { HexId32Schema } from "../schemas/hexId.ts";
import { strict } from "../schemas/strict.ts";
import {
  NotifyPayloadSchema,
  NukeReportSchema,
  PortNumberSchema,
  PreviewThemePayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";

// The window's id comes from here: the host's store holds it.
export const HostAddressSchema = strict(
  Schema.Struct({
    port: PortNumberSchema,
    token: HexId32Schema,
    deviceId: DeviceIdSchema,
  }),
);

// Why the shell started this machine's host again, pushed to every
// window as the new host is up: each says it once its link lands there.
export const HostRestartReasonSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("silent"), seconds: Schema.Int }),
  Schema.Struct({
    kind: Schema.Literal("exited"),
    code: Schema.NullOr(Schema.Int),
  }),
]);

// So a quit can bring a window back to it.
const RouteSchema = Schema.String.check(Schema.isPattern(/^\//));
const RoutePayloadSchema = strict(Schema.Struct({ route: RouteSchema }));

export const windowContract = defineContract(
  "window",
  "client",
  push("focused", VoidSchema),
  push("blurred", VoidSchema),
  push("hostRestarted", HostRestartReasonSchema),
  // Drives nativeTheme only, so a reload snaps back to the saved value.
  invoke("previewTheme", PreviewThemePayloadSchema, VoidSchema),
  // Fired only after moveDataDir's reply resolves, so the reply was
  // delivered before the app quits.
  invoke("relaunch", VoidSchema, VoidSchema),
  invoke("notify", NotifyPayloadSchema, VoidSchema),
  invoke("hostAddress", VoidSchema, HostAddressSchema),
  invoke("open", RoutePayloadSchema, VoidSchema),
  // Forgets the sizes the shell keeps: the terminals window's.
  invoke("resetLayout", VoidSchema, VoidSchema),
  // Reopened on at the next start.
  invoke("showing", RoutePayloadSchema, VoidSchema),
  // The shell wakes its host, as on a resume from sleep.
  invoke("networkChanged", VoidSchema, VoidSchema),
  // After the host's half. The files are marked to go at the next start,
  // before anything opens them.
  invoke("nuke", VoidSchema, NukeReportSchema),
);
