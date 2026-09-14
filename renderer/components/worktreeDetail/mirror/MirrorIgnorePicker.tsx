// What a mirror leaves out, as one section: the heading and the
// three-way rule on one line, and under it only what the rule needs.
// Gitignored lists what git ignores there today. Custom is the
// carry-over flow turned around: the chosen paths as rows, and "Add
// file or folder" opening the same folder browser over the worktree,
// where an ignored entry can be left out. The worktree browsed is the
// caller's (the source's copy in the dialog, the local copy on the
// mirror's own page), read under the surrounding scope.
import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  MIRROR_IGNORES_LIMIT,
  MirrorIgnoreModeSchema,
} from "@shared/ipc/modules/mirror";
import type { SyncIgnoredPathsResult } from "@shared/ipc/modules/sync";
import { PathPickerModal } from "@/components/configure/PathPickerModal";
import { Button } from "@/components/ui/button";
import { MaterialIcon } from "@/components/ui/material-icon";
import { SectionHeading } from "@/components/ui/section-heading";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useWorktreeFolder } from "@/hooks/remote/useWorktreeFolder";
import {
  CARD_NOTE,
  CardList,
  CardSkeleton,
  MAX_LIST_ROWS,
} from "../transplant/TransplantChrome";
import {
  IGNORE_MODE_LABEL,
  IGNORE_MODE_TITLE,
  type IgnoreSelection,
} from "./ignoreChoice";

const OPTIONS = MirrorIgnoreModeSchema.options.map((mode) => ({
  value: mode,
  label: IGNORE_MODE_LABEL[mode],
  title: IGNORE_MODE_TITLE[mode],
}));

export function MirrorIgnorePicker({
  value,
  onChange,
  ignored,
  worktree,
  disabled = false,
  children,
}: {
  value: IgnoreSelection;
  onChange: (next: IgnoreSelection) => void;
  ignored: Pick<
    UseQueryResult<SyncIgnoredPathsResult>,
    "data" | "isPending" | "isError"
  >;
  // The worktree the custom picker browses, in the surrounding scope.
  worktree: { projectId: string; id: string; path: string };
  // Read-only: the rule shows, nothing changes it.
  disabled?: boolean;
  // Trailing content under the rule (the manage dialog's apply row).
  children?: React.ReactNode;
}) {
  // The browser is a modal over the caller's own. It owns Escape while
  // it is up (PathPickerModal's capture listener), so the dialog under
  // it needs no say.
  const [picking, setPicking] = useState(false);
  const select = (next: ReadonlySet<string>) =>
    onChange({ ...value, selected: next });
  const chosen = [...value.selected].toSorted();
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <SectionHeading>Leave out</SectionHeading>
        <SegmentedControl
          aria-label="What the mirror leaves out"
          value={value.mode}
          onChange={(mode) => onChange({ ...value, mode })}
          disabled={disabled}
          options={OPTIONS}
          optionClassName="px-2.5 py-0.5 text-[11px]"
        />
      </div>
      {value.mode === "gitignored" && <IgnoredList ignored={ignored} />}
      {value.mode === "custom" && (
        <div className="space-y-1.5">
          {chosen.map((path) => (
            <ChosenRow
              key={path}
              path={path}
              disabled={disabled}
              onRemove={() => {
                const next = new Set(value.selected);
                next.delete(path);
                select(next);
              }}
            />
          ))}
          {!disabled && (
            <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
              <Plus />
              Add file or folder
            </Button>
          )}
        </div>
      )}
      {children}
      {picking && (
        <PathPickerModal
          rootPath={worktree.path}
          useListing={(relative) =>
            useWorktreeFolder(worktree.projectId, worktree.id, relative)
          }
          emptyRootLabel="The worktree is empty."
          renderTrailing={(entry, path) =>
            value.selected.has(path) ? (
              <span className="px-2 text-[11px] text-muted-foreground">
                Left out
              </span>
            ) : entry.ignored ? (
              <div
                className="inline-flex items-center"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                role="presentation"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => select(new Set([...value.selected, path]))}
                >
                  Leave out
                </Button>
              </div>
            ) : (
              <span
                className="px-2 text-[11px] text-muted-foreground/70"
                title="Tracked by git, so it always crosses. Only ignored files and folders can be left out."
              >
                tracked
              </span>
            )
          }
          onClose={() => setPicking(false)}
        />
      )}
    </section>
  );
}

// What git ignores on the worktree today, the list the gitignored
// rule leaves out.
function IgnoredList({
  ignored,
}: {
  ignored: Pick<
    UseQueryResult<SyncIgnoredPathsResult>,
    "data" | "isPending" | "isError"
  >;
}) {
  if (ignored.isPending) return <CardSkeleton />;
  if (ignored.isError) {
    return <p className={CARD_NOTE}>Couldn't list the ignored files.</p>;
  }
  const paths = ignored.data?.paths ?? [];
  const total = ignored.data?.total ?? 0;
  const rules = ignored.data?.patterns.length ?? 0;
  if (total === 0 && rules === 0) {
    return <p className={CARD_NOTE}>Nothing ignored yet.</p>;
  }
  return (
    <>
      {total > 0 && (
        <CardList total={total}>
          {paths.slice(0, MAX_LIST_ROWS).map((path) => (
            <li key={path} className="min-w-0 truncate" title={path}>
              {path}
            </li>
          ))}
        </CardList>
      )}
      {rules >= MIRROR_IGNORES_LIMIT && (
        <p className="text-xs text-muted-foreground">
          Only the first {MIRROR_IGNORES_LIMIT} gitignore rules apply.
        </p>
      )}
    </>
  );
}

// A chosen path, the carry-over row's shape without the mode.
function ChosenRow({
  path,
  disabled,
  onRemove,
}: {
  path: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  const basename = path.split("/").pop() ?? path;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5">
      <MaterialIcon kind="file" name={basename} className="size-4" />
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
        {path}
      </span>
      {!disabled && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${path}`}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
