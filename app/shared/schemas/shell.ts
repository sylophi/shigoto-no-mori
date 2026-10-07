import * as Schema from "effect/Schema";
import { isWebUrl } from "../webUrl";

// Only web URLs may reach shell.openExternal. A URL check alone accepts
// file:, javascript:, and arbitrary custom schemes, any of which would
// let an externally-sourced link (e.g. a PR check's target_url) launch
// local apps or files when clicked.
export const ShellOpenExternalPayloadSchema = Schema.Struct({
  url: Schema.String.check(
    Schema.makeFilter(
      (url: string) => isWebUrl(url) || "Only http(s) URLs can be opened",
    ),
  ),
});
