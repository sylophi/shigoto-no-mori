import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
import { broadcast, invoke } from "@shared/ipc/contract";
import { UpdaterStateSchema } from "@shared/schemas";

export const updaterContract = {
  get: invoke("updater:get", z.void(), UpdaterStateSchema),
  check: invoke("updater:check", z.void(), z.void()),
  install: invoke("updater:install", z.void(), z.void()),
  state: broadcast("updater:state", UpdaterStateSchema),
} as const;

export type UpdaterContract = typeof updaterContract;

const client = buildClient(updaterContract);

export const updater = {
  get: () => client.get(),
  check: () => client.check(),
  install: () => client.install(),
  onState: client.state,
} as const;
