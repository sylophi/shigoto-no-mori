import * as Schema from "effect/Schema";
import { broadcast, defineContract, invoke } from "../contract.ts";
import { DeviceIdSchema } from "../hubProtocol.ts";
import { HexId32Schema } from "../schemas/hexId.ts";
import { strict } from "../schemas/strict.ts";
import {
  NotifyPayloadSchema,
  PortNumberSchema,
  PreviewThemePayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";

// Where this machine's host listens on the loopback, the token its
// handshake proves, and the device it is: the window's id comes from
// here, since the host's store holds it.
export const HostAddressSchema = strict(
  Schema.Struct({
    port: PortNumberSchema,
    token: HexId32Schema,
    deviceId: DeviceIdSchema,
  }),
);

// A page of the app, as the router names it: a window opens on one and
// says which it shows, so a quit can bring it back there.
const RouteSchema = Schema.String.check(Schema.isPattern(/^\//));
const RoutePayloadSchema = strict(Schema.Struct({ route: RouteSchema }));

// The this-window / app-instance surface: focus signals from the
// BrowserWindow, plus the calls that act on the window's own process.
export const windowContract = defineContract(
  "window",
  "client",
  broadcast("focused", VoidSchema),
  broadcast("blurred", VoidSchema),
  // Non-persisting theme preview for unsaved Settings staging and the
  // dev hotkeys. It drives nativeTheme only, so a reload snaps back to
  // the saved value. Saves land through the clientConfig module.
  invoke("previewTheme", PreviewThemePayloadSchema, VoidSchema),
  // Renderer-acknowledged restart after a successful moveDataDir: firing
  // this only after the moveDataDir reply resolves guarantees the reply
  // was delivered before the app quits. No timing guesses.
  invoke("relaunch", VoidSchema, VoidSchema),
  // A system notification that opens `route` (a deep link's path) when
  // clicked.
  invoke("notify", NotifyPayloadSchema, VoidSchema),
  // Where this machine's host listens for its own windows (the loopback,
  // LoopbackGroup), and the token its handshake proves: what the window
  // dials for every call that is not the shell's.
  invoke("hostAddress", VoidSchema, HostAddressSchema),
  // Another window, on `route`.
  invoke("open", RoutePayloadSchema, VoidSchema),
  // The page this window shows now, which the shell reopens it on at
  // the next start.
  invoke("showing", RoutePayloadSchema, VoidSchema),
  // The window's Chromium saw the network go or come back: the shell
  // wakes its host, as on a resume from sleep.
  invoke("networkChanged", VoidSchema, VoidSchema),
);
