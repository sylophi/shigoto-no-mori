// A typed path read as a folder browse, shared by the add-project modal
// and the folder picker: the directory part is listed, the last segment
// filters that listing by prefix, and the two moves (into an entry, up
// to the parent) rewrite the query and clear the highlight.
import {
  appendBrowsePathSegment,
  getBrowseDirectoryPath,
  getBrowseLeafSegment,
  getBrowseParentPath,
  hasTrailingSlash,
} from "@shared/projectPaths";
import { useFsListDirectory } from "@/hooks/fs/useFsListDirectory";

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
}: UseBrowseListingOptions) {
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
    setQuery(appendBrowsePathSegment(query, name));
    setHighlighted("");
  };

  const browseUp = () => {
    const parent = getBrowseParentPath(query);
    if (parent) {
      setQuery(parent);
      setHighlighted("");
    }
  };

  return {
    browseDir,
    leafFilter,
    // Whether the query names a folder to list (it ends in a slash).
    listingEnabled,
    listing,
    isLoading,
    error,
    filtered,
    browseTo,
    browseUp,
  };
}
