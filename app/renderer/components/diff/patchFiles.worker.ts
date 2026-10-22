// Parses a patch away from the window's thread, for DiffPage: pierre
// takes a third of a second and more over a branch's patch of tens of
// megabytes, which on the window's thread would hold a click that long.
import { parsePatchFiles } from "@pierre/diffs";

addEventListener("message", (event: MessageEvent<string>) => {
  postMessage(parsePatchFiles(event.data).flatMap((patch) => patch.files));
});
