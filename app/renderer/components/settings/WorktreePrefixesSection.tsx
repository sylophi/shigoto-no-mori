import { useState } from "react";
import { normalizeWorktreePrefixes } from "@shigomori/contracts/sharedSettings";
import {
  type WorktreePrefixList,
  useSaveWorktreePrefixes,
  useWorktreePrefixes,
} from "@/hooks/sharedSettings/useWorktreePrefixes";
import { useSharedSettingsSettled } from "@/hooks/sharedSettings/useSharedSettings";
import { WorktreePrefixesSectionView } from "./WorktreePrefixesSectionView";

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((prefix, i) => prefix === b[i]);

// A worktree prefix list (WorktreePrefixesSectionView), written to the
// shared settings as it changes.
export function WorktreePrefixesSection({
  list,
}: {
  list: WorktreePrefixList;
}) {
  const stored = useWorktreePrefixes(list);
  const save = useSaveWorktreePrefixes(list);
  const settled = useSharedSettingsSettled();
  // An edit shows at once and the stored list catches up behind it, so
  // two edits in a row build on each other (see LeaveOutSection).
  const [draft, setDraft] = useState<string[] | null>(null);
  if (draft !== null && sameList(draft, stored)) setDraft(null);
  const prefixes = draft ?? stored;
  return (
    <WorktreePrefixesSectionView
      list={list}
      prefixes={prefixes}
      settled={settled}
      commit={(next) => {
        if (sameList(normalizeWorktreePrefixes(next), prefixes)) return true;
        const saved = save(next);
        if (saved === null) return false;
        setDraft(saved);
        return true;
      }}
    />
  );
}
