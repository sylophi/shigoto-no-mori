import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import {
  SetLaunchToolsEnabledPayloadSchema,
  SetMenuChordsPayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";
import { GuideHarnessSchema } from "./guide.ts";

export const menuContract = defineContract(
  "menu",
  "client",
  invoke(
    "setLaunchToolsEnabled",
    SetLaunchToolsEnabledPayloadSchema,
    VoidSchema,
  ),
  invoke("setChords", SetMenuChordsPayloadSchema, VoidSchema),
  // The guide's harnesses installed here, which the Help menu offers.
  invoke("setGuideHarnesses", Schema.Array(GuideHarnessSchema), VoidSchema),
  // What the Help menu's guide does, from a control in the calling
  // window: its one harness opens at once, and several are offered as
  // the Help menu offers them, at the control (window coordinates).
  invoke(
    "showAround",
    Schema.Struct({ x: Schema.Finite, y: Schema.Finite }),
    VoidSchema,
  ),
);
