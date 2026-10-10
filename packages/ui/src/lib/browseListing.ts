import type { DirectoryListing } from "@shigomori/contracts/schemas";

// A typed path read as a folder browse, as the folder picker and the
// add-project views draw it: the directory part listed, the last
// segment filtering that listing by prefix, and the two moves (into an
// entry, up to the parent). The app's useBrowseListing builds it.
export type BrowseListing = {
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
};
