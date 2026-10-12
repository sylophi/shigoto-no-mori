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
);
