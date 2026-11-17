// A typed path read as a folder browse, shared by the add-project modal
// and the folder picker: the directory part is listed, the last segment
// filters that listing by prefix, and the two moves (into an entry, up
// to the parent) rewrite the query and clear the highlight. The query
// is spelled as the engine spells it, and the moves as the scoped
// device's paths go (devicePaths.ts).
import {
  getBrowseDirectoryPath,
  getBrowseLeafSegment,
  hasTrailingSlash,
} from "@shigomori/contracts/projectPaths";
import type { BrowseListing } from "@shigomori/ui/lib/browseListing.ts";
import { devicePaths } from "@shigomori/ui/lib/devicePaths.ts";
import { useFsListDirectory } from "@/hooks/fs/useFsListDirectory";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";

interface UseBrowseListingOptions {
  query: string;
  setQuery: (value: string) => void;
  setHighlighted: (value: string) => void;
  enabled?: boolean;
}

export function useBrowseListing({
  query,
  setQuery,
  setHighlighted,
  enabled = true,
}: UseBrowseListingOptions): BrowseListing & {
  // Whether there is a folder above the listed one.
  readonly canBrowseUp: boolean;
} {
  const paths = devicePaths(useRuntimeInfo().data?.homedir, query);
  const browseDir = getBrowseDirectoryPath(query);
  const leafFilter = hasTrailingSlash(query) ? "" : getBrowseLeafSegment(query);

  const listingEnabled =
    enabled && browseDir.length > 0 && hasTrailingSlash(browseDir);
  const {
    data: listing,
    isLoading,
    error,
  } = useFsListDirectory(browseDir, listingEnabled);

  const filtered = (listing?.entries ?? []).filter((e) =>
    e.name.toLowerCase().startsWith(leafFilter.toLowerCase()),
  );

  const browseTo = (name: string) => {
    setQuery(paths.childOf(query, name));
    setHighlighted("");
  };

  const parent = paths.parentOf(query);
  const browseUp = () => {
    if (parent) {
      setQuery(parent);
      setHighlighted("");
    }
  };

  return {
    paths,
    browseDir,
    leafFilter,
    // Whether the query names a folder to list (it ends in a slash).
    listingEnabled,
    listing,
    isLoading,
    error,
    filtered,
    canBrowseUp: hasTrailingSlash(query) && parent !== null,
    browseTo,
    browseUp,
  };
}
