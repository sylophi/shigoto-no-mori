import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
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

const client = buildClient(dialogContract);

export const dialog = {
  pickFolder: (options?: { title?: string; buttonLabel?: string }) =>
    client.pickFolder(options),
} as const;
