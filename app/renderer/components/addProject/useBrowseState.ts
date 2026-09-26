import { hasTrailingSlash, normalizeForSubmit } from "@shared/projectPaths";
import { useBrowseListing } from "@/hooks/fs/useBrowseListing";
import { useFsIsGitRepo } from "@/hooks/fs/useFsIsGitRepo";
import { useDebouncedValue } from "@/hooks/ui/useDebouncedValue";

// How long a typed name holds still before it is worth asking about.
const PROBE_PAUSE_MS = 250;

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
  const { listing, leafFilter } = browse;

  // What the user is about to submit. When the query points at an
  // existing git repo we offer "Add"; otherwise we offer "Scan for git
  // repos" so the same primary slot doubles as the discovery path.
  const submitTarget = normalizeForSubmit(query);
  // Whether it is a repo. A name typed inside the listed folder is
  // often answered by the listing already in hand. Only a yes is taken
  // from it: the listing leaves out dotfolders and symlinks, and knows
  // a repo by its `.git` alone, where the probe also knows a bare one.
  // Everything else is probed, and the probe's key moves with every
  // keystroke, each a round trip under a peer's scope, so a name still
  // being typed waits for a pause. A path ending in a slash changes per
  // folder entered, not per key, and is asked at once: ↩ right after
  // walking into a repo has to mean "add" already.
  const typingLeaf = !hasTrailingSlash(query);
  const listedAsRepo =
    typingLeaf &&
    (listing?.entries.some(
      (entry) => entry.name === leafFilter && entry.isGitRepo,
    ) ??
      false);
  const pausedTarget = useDebouncedValue(submitTarget, PROBE_PAUSE_MS);
  const probeTarget = typingLeaf ? pausedTarget : submitTarget;
  const { data: probedIsGitRepo = false, isLoading: probing } = useFsIsGitRepo(
    probeTarget,
    enabled && !listedAsRepo,
  );
  const targetIsGitRepo =
    listedAsRepo || (probeTarget === submitTarget && probedIsGitRepo);
  // False while the answer above is a guess: the pause hasn't run out,
  // or the probe is still out. ↩ must not read "not a repo" off that,
  // or a path pasted and entered at once scans its parent instead.
  const targetSettled =
    listedAsRepo || (probeTarget === submitTarget && !probing);

  return { ...browse, submitTarget, targetIsGitRepo, targetSettled };
}
