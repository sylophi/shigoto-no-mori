import { Schema } from "effect";
import { broadcast, defineContract } from "@shared/ipc/contract";

export const navContract = defineContract("client", {
  openSettings: broadcast("nav:openSettings", Schema.Undefined),
  launchById: broadcast("launch:byId", Schema.String),
});
