// The bundled file-sync engine (file-sync/, built by
// scripts/build-file-sync.mts) for the host's FileSync service
// (host/fileSync/FileSync.ts). Addressed directly like the CLI binary:
// Resources/ when packaged, dist-file-sync/ in dev.
import * as Layer from "effect/Layer";
import {
  FILE_SYNC_BINARY_NAME,
  FILE_SYNC_DIST_DIR,
} from "@shared/packaging/fileSyncDist.mts";
import * as FileSync from "@host/fileSync/FileSync";
import { bundledBinaryResolver } from "./bundledBinary";

export const layer = FileSync.adapter.pipe(
  Layer.provideMerge(
    FileSync.layer(
      bundledBinaryResolver(FILE_SYNC_DIST_DIR, FILE_SYNC_BINARY_NAME),
    ),
  ),
);
