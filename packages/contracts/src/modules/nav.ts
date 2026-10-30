import * as Schema from "effect/Schema";
import { push, defineContract, invoke } from "../contract.ts";
import { VoidSchema } from "../schemas/index.ts";
import { GuideStartSchema } from "./guide.ts";

export const navContract = defineContract(
  "nav",
  "client",
  push("openSettings", VoidSchema),
  push("addProject", VoidSchema),
  push("launchById", Schema.String),
  push("closeTab", VoidSchema),
  // A Help menu item: the guide to open.
  push("showAround", GuideStartSchema),
  // A deep link arrived. Only a nudge: main holds the link until the
  // renderer takes it below, so a link that lands before the renderer
  // listens (one that launched the app) is not lost.
  push("deepLink", VoidSchema),
  // The pending deep link's path (`/devices/<id>/projects/<id>/...`,
  // the part after `<scheme>://open`), or null. Taking clears it.
  invoke("takeDeepLink", VoidSchema, Schema.NullOr(Schema.String)),
);
