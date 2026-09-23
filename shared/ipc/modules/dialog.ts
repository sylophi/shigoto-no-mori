import { Schema } from "effect";
import { defineContract, invoke } from "@shared/ipc/contract";
import { PickFolderPayloadSchema } from "@shared/schemas";

export const dialogContract = defineContract("client", {
  pickFolder: invoke(
    "dialog:pickFolder",
    PickFolderPayloadSchema,
    Schema.NullOr(Schema.String),
  ),
});
