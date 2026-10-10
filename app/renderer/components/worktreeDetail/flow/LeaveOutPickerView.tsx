// What a mirror leaves out, as one section: the heading and the base
// rule on one line, and under it the exceptions to that base. Nothing
// takes the ignored paths to leave out anyway, and gitignored (which
// lists what git ignores there today) takes the ignored paths to bring
// anyway, so one list serves as a leave-out list or a bring list by
// the base it hangs off. The list is the carry-over flow: the chosen
// paths as rows, and a button opening the same folder browser over the
// caller's files, where an ignored entry can be picked. What is browsed
// is the caller's: one worktree under the surrounding scope for a pull
// (the source's copy in the dialog, the local copy on the mirror's own
// page), since only what the source holds can cross, and the repo as
// every device holds it for the project's preset.
import type { ReactNode } from "react";
import { Plus, X } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { normalizeRelPath } from "@shared/git/gitPaths";
import {
  BRING_PATHS_LIMIT,
  bringRulesRoom,
  MIRROR_IGNORES_LIMIT,
} from "@shigomori/contracts/modules/mirror";
import type { SyncIgnoredPathsResult } from "@shigomori/contracts/modules/sync";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { MaterialIcon } from "@shigomori/ui/primitives/material-icon.tsx";
import { SectionHeading } from "@shigomori/ui/primitives/section-heading.tsx";
import { SegmentedControl } from "@shigomori/ui/primitives/segmented-control.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { withToggled } from "@/lib/toggleSet";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { CARD, CARD_NOTE, CardSkeletonView } from "./FlowChromeView";
import {
  exceptionsOf,
  type IgnoreBase,
  type IgnoreSelection,
} from "@shared/leaveOutRule";
import { IconButton } from "@shigomori/ui/primitives/icon-button.tsx";

// What stays behind before the exceptions (nothing, or what git
// ignores), in the words each base goes by. The heading beside the
// segmented control says "Leave out", so `label` answers that, and the
// list under it reads on from the label: "nothing, except" and
// "gitignored, except". The rest is an exception in the base's words:
// the add button, the line over the picked rows, the picker row's
// button, and a picked row's note.
export const IGNORE_BASE_COPY = {
  everything: {
    label: "Nothing",
    tip: "Copy every file, gitignored ones included",
    add: "Leave something out",
    lead: "Except these, which are left out:",
    action: "Leave out",
    done: "Left out",
  },
  gitignored: {
    label: "Gitignored",
    tip: "Skip whatever .gitignore matches",
    add: "Bring something anyway",
    lead: "Except these, which are brought anyway:",
    action: "Bring",
    done: "Brought",
  },
} as const satisfies Record<IgnoreBase, unknown>;

const OPTIONS = (Object.keys(IGNORE_BASE_COPY) as IgnoreBase[]).map((base) => ({
  value: base,
  label: IGNORE_BASE_COPY[base].label,
  tip: IGNORE_BASE_COPY[base].tip,
}));

export type IgnoredPaths = Pick<
  UseQueryResult<SyncIgnoredPathsResult>,
  "data" | "isPending" | "isError"
>;

// The rule as the picker edits it: which list the exceptions are, and
// a path toggled on or off it.
export function leaveOutEdit(
  value: IgnoreSelection,
  onChange: (next: IgnoreSelection) => void,
) {
  const bringing = value.base === "gitignored";
  const excepted = exceptionsOf(value);
  return {
    bringing,
    excepted,
    copy: IGNORE_BASE_COPY[value.base],
    // Each brought path costs the gitignore rules two patterns of room.
    full: bringing && excepted.size >= BRING_PATHS_LIMIT,
    toggle: (path: string) =>
      onChange({
        ...value,
        [bringing ? "brought" : "leftOut"]: withToggled(path)(
          new Set(excepted),
        ),
      }),
  };
}

export function LeaveOutPickerView({
  value,
  onChange,
  ignored,
  disabled = false,
  note,
  children,
  onBrowse,
  browser,
}: {
  value: IgnoreSelection;
  onChange: (next: IgnoreSelection) => void;
  ignored: IgnoredPaths;
  // Read-only: the rule shows, nothing changes it.
  disabled?: boolean;
  // What the rule is for, under the heading, where the surrounding
  // page does not already say (the Configure page's preset).
  note?: ReactNode;
  // Trailing content under the rule (the manage dialog's apply row).
  children?: ReactNode;
  // Opens the folder browser, drawn in `browser` while it is up.
  onBrowse: () => void;
  browser: ReactNode;
}) {
  const { bringing, excepted, copy, toggle } = leaveOutEdit(value, onChange);
  const chosen = [...excepted].toSorted();
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
          optionClassName="px-2.5 py-0.5 text-2xs"
        />
      </div>
      {note !== undefined && (
        <p className="text-xs text-muted-foreground">{note}</p>
      )}
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
            <Button variant="ghost" size="sm" onClick={onBrowse}>
              <Plus />
              {copy.add}
            </Button>
          )}
        </div>
      )}
      {children}
      {browser}
    </section>
  );
}

// A picker row's control: the note on a picked path, the button on an
// ignored one that can take an exception, and why not otherwise.
export function LeaveOutTrailingView({
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
      <span className="px-2 text-2xs text-muted-foreground">{copy.done}</span>
    );
  }
  // Why the row cannot be picked, as its tag and the tag's tooltip.
  const why: [string, string] | null = unreachable
    ? [
        "in ignored folder",
        "This is inside an ignored folder. Bring the whole folder instead.",
      ]
    : !ignored
      ? [
          "tracked",
          "Git tracks this, so it is always copied. Only ignored files and folders can be picked.",
        ]
      : full
        ? [
            "limit reached",
            `You can bring up to ${BRING_PATHS_LIMIT} paths. Bring a parent folder instead, or remove one.`,
          ]
        : null;
  if (why !== null) {
    return (
      <SimpleTooltip tip={why[1]}>
        <span className="px-2 text-2xs text-muted-foreground/70">{why[0]}</span>
      </SimpleTooltip>
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
  ignored: IgnoredPaths;
  brought: ReadonlySet<string>;
}) {
  if (ignored.isPending) return <CardSkeletonView />;
  if (ignored.isError) {
    return <p className={CARD_NOTE}>Couldn't list the ignored files.</p>;
  }
  const listed = ignored.data?.paths ?? [];
  const paths = listed.filter((path) => !brought.has(normalizeRelPath(path)));
  // How many of the brought paths are ignored here. A path picked in
  // this worktree always is, but a project preset's may not be, so
  // they are counted off the list while it is whole. Past the cap the
  // list cannot say, and every brought path is taken to be one.
  const allListed = (ignored.data?.total ?? 0) <= listed.length;
  const broughtHere = allListed ? listed.length - paths.length : brought.size;
  const total = Math.max(0, (ignored.data?.total ?? 0) - broughtHere);
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
          {broughtHere > 0
            ? "Every ignored path is being brought."
            : "No ignored files here yet."}
        </p>
      ) : (
        <ul
          className={cn(CARD, "gap-x-4 font-mono text-xs")}
          style={{ columnWidth: `${longest}ch` }}
        >
          {paths.map((path) => (
            <SimpleTooltip whenTruncated key={path} tip={path}>
              <li className="truncate py-0.5">{path}</li>
            </SimpleTooltip>
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
      <SimpleTooltip whenTruncated tip={path}>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {path}
        </span>
      </SimpleTooltip>
      {!disabled && (
        <IconButton
          onClick={onRemove}
          aria-label={`Remove ${path}`}
          tone="destructive"
        >
          <X className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}
