import { Schema } from "effect";
import { isWebUrl } from "../webUrl";

// Only web URLs may reach shell.openExternal. A URL check alone accepts
// file:, javascript:, and arbitrary custom schemes, any of which would
// let an externally-sourced link (e.g. a PR check's target_url) launch
// local apps or files when clicked. The value is trimmed first, as the
// zod url check this replaces did, so the handler opens the trimmed URL.
export const ShellOpenExternalPayloadSchema = Schema.Struct({
  url: Schema.Trim.check(
    Schema.makeFilter(isWebUrl, {
      message: "Only http(s) URLs can be opened",
    }),
  ),
});
