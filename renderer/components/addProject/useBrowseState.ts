import {
  appendBrowsePathSegment,
  getBrowseDirectoryPath,
  getBrowseLeafSegment,
  getBrowseParentPath,
  hasTrailingSlash,
  normalizeForSubmit,
} from "@/lib/projectPaths";
import { useFsIsGitRepo } from "@/hooks/fs/useFsIsGitRepo";
import { useFsListDirectory } from "@/hooks/fs/useFsListDirectory";

interface UseBrowseStateOptions {
  query: string;
  setQuery: (value: string) => void;
  setHighlighted: (value: string) => void;
  enabled: boolean;
}

// Browse-mode derivations + navigation helpers for the add-project modal.
// Owns the directory listing query and the "is this a git repo?" probe, plus
// the path-segment math so the parent component stays focused on stage
// orchestration and keyboard handling.
export function useBrowseState(opts: UseBrowseStateOptions) {
  const { query, setQuery, setHighlighted, enabled } = opts;

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

  // What the user is about to submit. When the query points at an
  // existing git repo we offer "Add"; otherwise we offer "Scan for git
  // repos" so the same primary slot doubles as the discovery path.
  const submitTarget = normalizeForSubmit(query);
  const { data: targetIsGitRepo = false } = useFsIsGitRepo(
    submitTarget,
    enabled,
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
    listing,
    isLoading,
    error,
    filtered,
    submitTarget,
    targetIsGitRepo,
    browseTo,
    browseUp,
  };
}
