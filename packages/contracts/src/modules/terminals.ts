import * as Schema from "effect/Schema";
import { defineContract, invoke, view } from "../contract.ts";
import {
  AttachTerminalPayloadSchema,
  CloseTerminalPayloadSchema,
  OpenTerminalPayloadSchema,
  ResizeTerminalPayloadSchema,
  TerminalEventSchema,
  TerminalsSchema,
  VoidSchema,
  WriteTerminalPayloadSchema,
} from "../schemas/index.ts";

// The host's interactive shells (app/host/lib/terminals). Every call is
// gated under the scripts' consent: a terminal runs anything, as a
// custom script already does, and its folders and output are as private
// as a script's.
const gated = { remote: true, gated: true, grant: "runCommands" } as const;

export const terminalsContract = defineContract(
  "terminals",
  "host",
  view("list", VoidSchema, TerminalsSchema, gated),
  invoke(
    "open",
    OpenTerminalPayloadSchema,
    Schema.Struct({ terminalId: Schema.String }),
    gated,
  ),
  invoke("close", CloseTerminalPayloadSchema, VoidSchema, gated),
  view("attach", AttachTerminalPayloadSchema, TerminalEventSchema, gated),
  invoke("write", WriteTerminalPayloadSchema, VoidSchema, gated),
  // Sets the size for every attached client.
  invoke("resize", ResizeTerminalPayloadSchema, VoidSchema, gated),
);
