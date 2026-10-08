import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import { PickFolderPayloadSchema } from "../schemas/index.ts";

export const dialogContract = defineContract("client", {
  pickFolder: invoke(
    "dialog:pickFolder",
    PickFolderPayloadSchema,
    Schema.NullOr(Schema.String),
  ),
});
