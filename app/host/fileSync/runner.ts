// The bundled file-sync engine (file-sync/, built by
// scripts/build-file-sync.mts) for the host's FileSync service
// (host/fileSync/FileSync.ts). Addressed directly like the CLI binary:
// Resources/ when packaged, dist-file-sync/ in dev.
import {
  FILE_SYNC_BINARY_NAME,
  FILE_SYNC_DIST_DIR,
} from "@shared/packaging/fileSyncDist.mts";
import * as FileSync from "./FileSync";
import { hostBinaryResolver } from "@host/process/facts";

export const layer = FileSync.layer(
  hostBinaryResolver(FILE_SYNC_DIST_DIR, () => FILE_SYNC_BINARY_NAME),
);
