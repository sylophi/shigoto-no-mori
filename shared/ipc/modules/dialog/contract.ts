import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import { PickFolderPayloadSchema } from "@shared/schemas";

export const dialogContract = {
  pickFolder: invoke(
    "dialog:pickFolder",
    PickFolderPayloadSchema,
    z.string().nullable(),
  ),
} as const;

export type DialogContract = typeof dialogContract;
