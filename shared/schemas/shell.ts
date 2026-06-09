import { z } from "zod";

export const ShellPathPayloadSchema = z.object({
  path: z.string().min(1),
});

// Only web URLs may reach shell.openExternal. zod's .url() alone accepts
// file:, javascript:, and arbitrary custom schemes, any of which would
// let an externally-sourced link (e.g. a PR check's target_url) launch
// local apps or files when clicked.
export const ShellOpenExternalPayloadSchema = z.object({
  url: z
    .string()
    .url()
    .refine(
      (value) => {
        try {
          const protocol = new URL(value).protocol;
          return protocol === "http:" || protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "Only http(s) URLs can be opened" },
    ),
});
