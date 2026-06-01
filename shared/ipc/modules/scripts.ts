import { z } from "zod";
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
    { tracksProjectUsage: true },
  ),
  cancel: invoke(
    "scripts:cancel",
    CancelScriptPayloadSchema,
    z.object({ cancelled: z.boolean() }),
  ),
  event: broadcast("scripts:event", ScriptEventSchema),
} as const;

export type ScriptsContract = typeof scriptsContract;
