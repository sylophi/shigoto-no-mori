import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";

export const navContract = defineContract("client", {
  openSettings: broadcast("nav:openSettings", z.void()),
  addProject: broadcast("nav:addProject", z.void()),
  launchById: broadcast("launch:byId", z.string()),
  // A deep link arrived. Only a nudge: main holds the link until the
  // renderer takes it below, so a link that lands before the renderer
  // listens (one that launched the app) is not lost.
  deepLink: broadcast("nav:deepLink", z.void()),
  // The pending deep link's path (`/devices/<id>/projects/<id>/...`,
  // the part after `<scheme>://open`), or null. Taking clears it.
  takeDeepLink: invoke("nav:takeDeepLink", z.void(), z.string().nullable()),
});
