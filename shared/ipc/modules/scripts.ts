import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
import { broadcast, invoke } from "@shared/ipc/contract";
import {
  CancelScriptPayloadSchema,
  RunScriptPayloadSchema,
  ScriptEventSchema,
} from "@shared/schemas";

export const scriptsContract = {
  run: invoke(
    "scripts:run",
    RunScriptPayloadSchema,
    z.object({ runId: z.string() }),
  ),
  cancel: invoke(
    "scripts:cancel",
    CancelScriptPayloadSchema,
    z.object({ cancelled: z.boolean() }),
  ),
  event: broadcast("scripts:event", ScriptEventSchema),
} as const;

export type ScriptsContract = typeof scriptsContract;

const client = buildClient(scriptsContract);

export const scripts = {
  run: client.run,
  cancel: (runId: string) => client.cancel({ runId }),
  onEvent: client.event,
} as const;
