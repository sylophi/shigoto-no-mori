import type { DirectoryListing, Volume } from "@shigomori/contracts/schemas";
import type { DevicePaths } from "./devicePaths.ts";

// A typed path read as a folder browse, as the folder picker and the
// add-project views draw it: the directory part listed, the last
// segment filtering that listing by prefix, and the moves (into an
// entry, up to the parent, to a volume). The app's useBrowseListing
// builds it.
export type BrowseListing = {
  // How the device's paths show and type.
  readonly paths: DevicePaths;
  readonly browseDir: string;
  readonly leafFilter: string;
  // Whether the query names a folder to list (it ends in a slash).
  readonly listingEnabled: boolean;
  readonly listing: DirectoryListing | undefined;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly filtered: DirectoryListing["entries"];
  readonly browseTo: (name: string) => void;
  readonly browseUp: () => void;
  // The device's mounted volumes, and the move to one (or home, `~/`).
  readonly volumes: readonly Volume[];
  readonly jumpTo: (path: string) => void;
};
