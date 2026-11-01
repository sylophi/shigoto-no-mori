// The bundled file-sync engine (file-sync/, built by
// scripts/build-go.mts) for the host's FileSync service
// (host/fileSync/FileSync.ts). Addressed directly like the CLI binary:
// Resources/ when packaged, dist-file-sync/ in dev.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  FILE_SYNC_BINARY_NAME,
  FILE_SYNC_DIST_DIR,
} from "@shared/packaging/goHelpersDist.mts";
import { bundledBinaryResolver } from "@shared/packaging/bundledBinary.mts";
import * as HostFacts from "@host/lib/HostFacts";
import * as FileSync from "./FileSync";

export const layer = Layer.unwrap(
  Effect.map(HostFacts.HostFacts, (facts) =>
    FileSync.layer(
      bundledBinaryResolver(
        () => facts,
        FILE_SYNC_DIST_DIR,
        () => FILE_SYNC_BINARY_NAME,
      ),
    ),
  ),
);
