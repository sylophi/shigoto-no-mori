// A worktree prefix list. Hidden: a worktree whose name or branch
// starts with one of them folds away like a shelved one, behind its
// project's "N hidden" toggle (and the inbox's Hidden shelf). Grouped:
// it sits under a header for its prefix in its project's tree. Shared
// settings, so each applies the moment it changes (outside the page's
// Save) and holds on every device.
import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip-button";
import { Input } from "@/components/ui/input";
import { normalizeWorktreePrefixes } from "@shared/sharedSettings";
import { SectionIntro } from "@/components/ui/section-heading";
import {
  type WorktreePrefixList,
  useSaveWorktreePrefixes,
  useWorktreePrefixes,
} from "@/hooks/sharedSettings/useWorktreePrefixes";
import { useSharedSettingsSettled } from "@/hooks/sharedSettings/useSharedSettings";

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((prefix, i) => prefix === b[i]);

const COPY: Record<
  WorktreePrefixList,
  { title: string; intro: string; placeholder: string }
> = {
  hidden: {
    title: "Hidden worktrees",
    intro: "Hide worktrees whose name or branch starts with any of these.",
    placeholder: "exp/",
  },
  grouped: {
    title: "Grouped worktrees",
    intro:
      "Group worktrees whose name or branch starts with one of these under a header for it.",
    placeholder: "v3/",
  },
};

export function WorktreePrefixesSection({
  list,
}: {
  list: WorktreePrefixList;
}) {
  const copy = COPY[list];
  const stored = useWorktreePrefixes(list);
  const save = useSaveWorktreePrefixes(list);
  // Every edit writes the whole list, so none may be made off a list
  // not read yet: it would replace the stored one everywhere.
  const settled = useSharedSettingsSettled();
  const [input, setInput] = useState("");
  // An edit shows at once and the stored list catches up behind it, so
  // two edits in a row build on each other (see LeaveOutSection).
  const [draft, setDraft] = useState<string[] | null>(null);
  if (draft !== null && sameList(draft, stored)) setDraft(null);
  const prefixes = draft ?? stored;

  const commit = (next: string[]) => {
    if (sameList(normalizeWorktreePrefixes(next), prefixes)) return true;
    const saved = save(next);
    if (saved === null) return false;
    setDraft(saved);
    return true;
  };
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const prefix = input.trim();
    if (prefix === "") return;
    if (commit([...prefixes, prefix])) setInput("");
  };

  return (
    <section className="space-y-3">
      <SectionIntro title={copy.title}>{copy.intro}</SectionIntro>
      {prefixes.length > 0 && (
        <ul
          aria-label={`${copy.title}: prefixes`}
          className="flex flex-wrap gap-1.5"
        >
          {prefixes.map((prefix) => (
            <li key={prefix}>
              <Chip className="py-0.5 pr-1 font-mono">
                {prefix}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove ${prefix}`}
                  className="size-5 text-muted-foreground"
                  disabled={!settled}
                  onClick={() => commit(prefixes.filter((p) => p !== prefix))}
                >
                  <X />
                </Button>
              </Chip>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex items-center gap-2">
        <Input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={copy.placeholder}
          aria-label="Prefix"
          disabled={!settled}
          className="w-56 px-3 py-1.5 font-mono text-sm"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!settled || input.trim() === ""}
        >
          Add
        </Button>
      </form>
    </section>
  );
}
