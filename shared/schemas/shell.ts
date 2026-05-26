import { z } from "zod";

export const ShellPathPayloadSchema = z.object({
  path: z.string().min(1),
});

export const ShellOpenExternalPayloadSchema = z.object({
  url: z.string().url(),
});
