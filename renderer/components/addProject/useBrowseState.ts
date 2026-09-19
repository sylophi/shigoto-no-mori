import { normalizeForSubmit } from "@/lib/projectPaths";
import { useBrowseListing } from "@/hooks/fs/useBrowseListing";
import { useFsIsGitRepo } from "@/hooks/fs/useFsIsGitRepo";

interface UseBrowseStateOptions {
  query: string;
  setQuery: (value: string) => void;
  setHighlighted: (value: string) => void;
  enabled: boolean;
}

// Browse-mode derivations + navigation helpers for the add-project modal.
// The listing and the path-segment moves are useBrowseListing's, shared
// with the folder picker. This adds the "is this a git repo?" probe, so
// the parent component stays focused on stage orchestration and keyboard
// handling.
export function useBrowseState(opts: UseBrowseStateOptions) {
  const { query, enabled } = opts;
  const browse = useBrowseListing(opts);

  // What the user is about to submit. When the query points at an
  // existing git repo we offer "Add"; otherwise we offer "Scan for git
  // repos" so the same primary slot doubles as the discovery path.
  const submitTarget = normalizeForSubmit(query);
  const { data: targetIsGitRepo = false } = useFsIsGitRepo(
    submitTarget,
    enabled,
  );

  return { ...browse, submitTarget, targetIsGitRepo };
}
