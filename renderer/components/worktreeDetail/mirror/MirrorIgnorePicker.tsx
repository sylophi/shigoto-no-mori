// What a mirror leaves out, as one section: the heading and the base
// rule on one line, and under it the exceptions to that base. Nothing
// takes the ignored paths to leave out anyway, and gitignored (which
// lists what git ignores there today) takes the ignored paths to bring
// anyway, so one list serves as a leave-out list or a bring list by
// the base it hangs off. The list is the carry-over flow: the chosen
// paths as rows, and a button opening the same folder browser over the
// worktree, where an ignored entry can be picked. The worktree browsed
// is the caller's (the source's copy in the dialog, the local copy on
// the mirror's own page), read under the surrounding scope.
import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { normalizeRelPath } from "@shared/gitPaths";
import {
  BRING_PATHS_LIMIT,
  bringRulesRoom,
  MIRROR_IGNORES_LIMIT,
} from "@shared/ipc/modules/mirror";
import type { SyncIgnoredPathsResult } from "@shared/ipc/modules/sync";
import { PathPickerModal } from "@/components/configure/PathPickerModal";
import { Button } from "@/components/ui/button";
import { MaterialIcon } from "@/components/ui/material-icon";
import { SectionHeading } from "@/components/ui/section-heading";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useWorktreeFolder } from "@/hooks/remote/useWorktreeFolder";
import { withToggled } from "@/lib/toggleSet";
import { cn } from "@/lib/utils";
import { CARD, CARD_NOTE, CardSkeleton } from "../transplant/TransplantChrome";
import {
  exceptionsOf,
  IGNORE_BASE_COPY,
  type IgnoreBase,
  type IgnoreSelection,
} from "./ignoreChoice";

const OPTIONS = (Object.keys(IGNORE_BASE_COPY) as IgnoreBase[]).map((base) => ({
  value: base,
  label: IGNORE_BASE_COPY[base].label,
  title: IGNORE_BASE_COPY[base].title,
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
  const bringing = value.base === "gitignored";
  const excepted = exceptionsOf(value);
  const toggle = (path: string) =>
    onChange({
      ...value,
      [bringing ? "brought" : "leftOut"]: withToggled(path)(new Set(excepted)),
    });
  const chosen = [...excepted].toSorted();
  const copy = IGNORE_BASE_COPY[value.base];
  // Each brought path costs the gitignore rules two patterns of room.
  const full = bringing && excepted.size >= BRING_PATHS_LIMIT;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <SectionHeading>Leave out</SectionHeading>
        <SegmentedControl
          aria-label="What the mirror leaves out"
          value={value.base}
          onChange={(base) => onChange({ ...value, base })}
          disabled={disabled}
          options={OPTIONS}
          optionClassName="px-2.5 py-0.5 text-[11px]"
        />
      </div>
      {bringing && <IgnoredList ignored={ignored} brought={excepted} />}
      {(chosen.length > 0 || !disabled) && (
        <div className="space-y-1.5">
          {chosen.length > 0 && (
            <p className="text-xs text-muted-foreground">{copy.lead}</p>
          )}
          {chosen.map((path) => (
            <ChosenRow
              key={path}
              path={path}
              disabled={disabled}
              onRemove={() => toggle(path)}
            />
          ))}
          {!disabled && (
            <Button
              variant="ghost"
              size="sm"
              title={copy.hint}
              onClick={() => setPicking(true)}
            >
              <Plus />
              Add exception
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
          renderTrailing={(entry, path, insideIgnored) => (
            <Trailing
              picked={excepted.has(path)}
              ignored={entry.ignored}
              // The engine never walks into a folder it leaves out, so a
              // path under one cannot be brought on its own.
              unreachable={bringing && insideIgnored}
              full={full}
              copy={copy}
              onPick={() => toggle(path)}
            />
          )}
          onClose={() => setPicking(false)}
        />
      )}
    </section>
  );
}

// A picker row's control: the note on a picked path, the button on an
// ignored one that can take an exception, and why not otherwise.
function Trailing({
  picked,
  ignored,
  unreachable,
  full,
  copy,
  onPick,
}: {
  picked: boolean;
  ignored: boolean;
  unreachable: boolean;
  full: boolean;
  copy: { action: string; done: string };
  onPick: () => void;
}) {
  if (picked) {
    return (
      <span className="px-2 text-[11px] text-muted-foreground">
        {copy.done}
      </span>
    );
  }
  if (unreachable) {
    return (
      <span
        className="px-2 text-[11px] text-muted-foreground/70"
        title="Bring the ignored folder it sits in. A folder that stays put is not opened for one file."
      >
        in ignored folder
      </span>
    );
  }
  if (!ignored) {
    return (
      <span
        className="px-2 text-[11px] text-muted-foreground/70"
        title="Tracked by git, so it always crosses. Only ignored files and folders take an exception."
      >
        tracked
      </span>
    );
  }
  if (full) {
    return (
      <span
        className="px-2 text-[11px] text-muted-foreground/70"
        title={`A rule brings ${BRING_PATHS_LIMIT} paths at most. Bring a folder higher up, or remove one.`}
      >
        limit reached
      </span>
    );
  }
  return (
    <div
      className="inline-flex items-center"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <Button type="button" variant="outline" size="xs" onClick={onPick}>
        {copy.action}
      </Button>
    </div>
  );
}

// What git ignores on the worktree today, the list the gitignored
// rule leaves out, less the paths brought anyway. A brought path is a
// topmost ignored entry, so it is one line of git's list (a folder's
// ends in a slash) whether or not it made the capped page.
function IgnoredList({
  ignored,
  brought,
}: {
  ignored: Pick<
    UseQueryResult<SyncIgnoredPathsResult>,
    "data" | "isPending" | "isError"
  >;
  brought: ReadonlySet<string>;
}) {
  if (ignored.isPending) return <CardSkeleton />;
  if (ignored.isError) {
    return <p className={CARD_NOTE}>Couldn't list the ignored files.</p>;
  }
  const paths = (ignored.data?.paths ?? []).filter(
    (path) => !brought.has(normalizeRelPath(path)),
  );
  const total = Math.max(0, (ignored.data?.total ?? 0) - brought.size);
  const rules = ignored.data?.patterns.length ?? 0;
  // The rules that fit: all the cap holds, less what the brought paths
  // take. At the cap itself the wire may have cut the list already.
  const room = bringRulesRoom(brought.size);
  const cut = brought.size > 0 ? rules > room : rules >= MIRROR_IGNORES_LIMIT;
  // Every path the wire carries, flowed into as many columns as the
  // card fits: the rule is judged by seeing what it covers. A column
  // is as wide as the longest path, so short names pack side by side,
  // up to a cap: one deep path truncates instead of costing every
  // other row its columns.
  const longest = Math.min(
    28,
    Math.max(12, ...paths.map((path) => path.length)),
  );
  return (
    <>
      {total === 0 ? (
        <p className={CARD_NOTE}>
          {brought.size > 0
            ? "Every ignored path there is brought."
            : "Nothing ignored yet."}
        </p>
      ) : (
        <ul
          className={cn(CARD, "gap-x-4 font-mono text-xs")}
          style={{ columnWidth: `${longest}ch` }}
        >
          {paths.map((path) => (
            <li key={path} className="truncate py-0.5" title={path}>
              {path}
            </li>
          ))}
          {total > paths.length && (
            <li className="py-0.5 text-muted-foreground [column-span:all]">
              and {total - paths.length} more
            </li>
          )}
        </ul>
      )}
      {cut && (
        <p className="text-xs text-muted-foreground">
          Only the first {Math.min(room, MIRROR_IGNORES_LIMIT)} gitignore rules
          apply.
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
