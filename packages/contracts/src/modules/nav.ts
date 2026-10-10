import * as Schema from "effect/Schema";
import { broadcast, defineContract, invoke } from "../contract.ts";
import { VoidSchema } from "../schemas/index.ts";

export const navContract = defineContract(
  "nav",
  "client",
  broadcast("openSettings", VoidSchema),
  broadcast("addProject", VoidSchema),
  broadcast("launchById", Schema.String),
  // The v3 migration began: the window shows its page. A window that
  // opens before it hears this asks (migrating) as it mounts.
  broadcast("showMigration", VoidSchema),
  invoke("migrating", VoidSchema, Schema.Boolean),
  // A deep link arrived. Only a nudge: main holds the link until the
  // renderer takes it below, so a link that lands before the renderer
  // listens (one that launched the app) is not lost.
  broadcast("deepLink", VoidSchema),
  // The pending deep link's path (`/devices/<id>/projects/<id>/...`,
  // the part after `<scheme>://open`), or null. Taking clears it.
  invoke("takeDeepLink", VoidSchema, Schema.NullOr(Schema.String)),
);
