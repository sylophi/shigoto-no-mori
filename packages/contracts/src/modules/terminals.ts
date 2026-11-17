import * as Schema from "effect/Schema";
import { defineContract, invoke, view, gatedBy } from "../contract.ts";
import {
  AttachTerminalPayloadSchema,
  CloseTerminalPayloadSchema,
  MoveTerminalPayloadSchema,
  OpenTerminalPayloadSchema,
  ResizeTerminalPayloadSchema,
  TerminalEventSchema,
  TerminalsSchema,
  VoidSchema,
  WriteTerminalPayloadSchema,
} from "../schemas/index.ts";

// The host's interactive shells (app/host/lib/terminals). Every call is
// gated under the scripts' consent: a terminal runs anything, as a
// custom script already does, and which are open where, and their
// output, are as private as a script's.
const gated = gatedBy("runCommands");

export const terminalsContract = defineContract(
  "terminals",
  { scope: "host", version: 2 },
  view("list", VoidSchema, TerminalsSchema, gated),
  invoke(
    "open",
    OpenTerminalPayloadSchema,
    Schema.Struct({ terminalId: Schema.String }),
    gated,
  ),
  invoke("close", CloseTerminalPayloadSchema, VoidSchema, gated),
  // Hands the terminal to another worktree of its project, its shell
  // sent there with a cd unless a command holds it.
  invoke("move", MoveTerminalPayloadSchema, VoidSchema, gated),
  view("attach", AttachTerminalPayloadSchema, TerminalEventSchema, gated),
  invoke("write", WriteTerminalPayloadSchema, VoidSchema, gated),
  // Sets the size for every attached client.
  invoke("resize", ResizeTerminalPayloadSchema, VoidSchema, gated),
);
