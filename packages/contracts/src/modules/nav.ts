import * as Schema from "effect/Schema";
import { broadcast, defineContract, invoke } from "../contract.ts";
import { VoidSchema } from "../schemas/index.ts";

export const navContract = defineContract("client", {
  openSettings: broadcast("nav:openSettings", VoidSchema),
  addProject: broadcast("nav:addProject", VoidSchema),
  launchById: broadcast("launch:byId", Schema.String),
  // A deep link arrived. Only a nudge: main holds the link until the
  // renderer takes it below, so a link that lands before the renderer
  // listens (one that launched the app) is not lost.
  deepLink: broadcast("nav:deepLink", VoidSchema),
  // The pending deep link's path (`/devices/<id>/projects/<id>/...`,
  // the part after `<scheme>://open`), or null. Taking clears it.
  takeDeepLink: invoke(
    "nav:takeDeepLink",
    VoidSchema,
    Schema.NullOr(Schema.String),
  ),
});
