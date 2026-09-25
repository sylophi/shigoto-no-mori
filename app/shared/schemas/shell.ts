import { z } from "zod";
import { isWebUrl } from "../webUrl";

// Only web URLs may reach shell.openExternal. zod's url check alone
// accepts file:, javascript:, and arbitrary custom schemes, any of which
// would let an externally-sourced link (e.g. a PR check's target_url)
// launch local apps or files when clicked.
export const ShellOpenExternalPayloadSchema = z.object({
  url: z.url().refine(isWebUrl, { message: "Only http(s) URLs can be opened" }),
});
