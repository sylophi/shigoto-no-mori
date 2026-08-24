import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { PickFolderPayloadSchema } from "@shared/schemas";

export const dialogContract = defineContract("client", {
  pickFolder: invoke(
    "dialog:pickFolder",
    PickFolderPayloadSchema,
    z.string().nullable(),
  ),
});
