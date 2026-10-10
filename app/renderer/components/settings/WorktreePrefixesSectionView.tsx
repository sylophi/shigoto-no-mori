// A worktree prefix list. Hidden: a worktree whose name or branch
// starts with one of them folds away like a shelved one, behind its
// project's "N hidden" toggle (and the inbox's Hidden shelf). Grouped:
// it sits under a header for its prefix in its project's tree (and in
// the inbox, when it is live work). Shared
// settings, so each applies the moment it changes (outside the page's
// Save) and holds on every device.
import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip-button";
import { Input } from "@/components/ui/input";
import { SectionIntro } from "@/components/ui/section-heading";
import type { WorktreePrefixList } from "@/hooks/sharedSettings/useWorktreePrefixes";

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
      "Group worktrees whose name or branch starts with one of these under a header for it. Hidden ones stay hidden.",
    placeholder: "v3/",
  },
};

export function WorktreePrefixesSectionView({
  list,
  prefixes,
  settled,
  commit,
}: {
  list: WorktreePrefixList;
  prefixes: readonly string[];
  // Every edit writes the whole list, so none may be made off a list
  // not read yet: it would replace the stored one everywhere.
  settled: boolean;
  // Writes the list, false when it could not.
  commit: (next: string[]) => boolean;
}) {
  const copy = COPY[list];
  const [input, setInput] = useState("");
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
                  aria-label={`Remove ${prefix} from ${copy.title.toLowerCase()}`}
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
          aria-label={`${copy.title}: new prefix`}
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
