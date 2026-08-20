import { z } from "zod";
import { broadcast, invoke } from "@shared/ipc/contract";
import { UpdaterStateSchema } from "@shared/schemas";

export const updaterContract = {
  get: invoke("updater:get", z.void(), UpdaterStateSchema),
  check: invoke("updater:check", z.void(), z.void()),
  install: invoke("updater:install", z.void(), z.void()),
  state: broadcast("updater:state", UpdaterStateSchema),
} as const;
