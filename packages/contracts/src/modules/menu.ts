import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import {
  SetLaunchToolsEnabledPayloadSchema,
  SetMenuChordsPayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";
import { GuideChoicesSchema } from "./guide.ts";

export const menuContract = defineContract(
  "menu",
  "client",
  invoke(
    "setLaunchToolsEnabled",
    SetLaunchToolsEnabledPayloadSchema,
    VoidSchema,
  ),
  invoke("setChords", SetMenuChordsPayloadSchema, VoidSchema),
  // What the Help menu's guide items offer.
  invoke("setGuideChoices", GuideChoicesSchema, VoidSchema),
  invoke("setTerminalFocused", Schema.Boolean, VoidSchema),
);
