// The leave-out section's look (LeaveOutPicker.tsx says what the rule
// is and keeps the folder browser): the heading and the base rule on
// one line, what git ignores there when that is the base, the chosen
// exceptions as rows, and the button that opens the browser.
import type { ReactNode } from "react";
import { Plus, X } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { normalizeRelPath } from "@shared/git/gitPaths";
import {
  bringRulesRoom,
  MIRROR_IGNORES_LIMIT,
} from "@shared/ipc/modules/mirror";
import type { SyncIgnoredPathsResult } from "@shared/ipc/modules/sync";
import {
  exceptionsOf,
  type IgnoreBase,
  type IgnoreSelection,
} from "@shared/leaveOutRule";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { SectionHeading } from "@/components/ui/section-heading";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { withToggled } from "@/lib/toggleSet";
import { cn } from "@/lib/utils";
import { CARD, CARD_NOTE, CardSkeleton } from "./FlowChromeView";
import { IGNORE_BASE_COPY } from "./ignoreBaseCopy";

const OPTIONS = (Object.keys(IGNORE_BASE_COPY) as IgnoreBase[]).map((base) => ({
  value: base,
  label: IGNORE_BASE_COPY[base].label,
  title: IGNORE_BASE_COPY[base].title,
}));

// What git ignores on the worktree, as the query reads it.
export type IgnoredPathsState = Pick<
  UseQueryResult<SyncIgnoredPathsResult>,
  "data" | "isPending" | "isError"
>;

// A chosen row's file icon until one is handed in: the empty box the
// app's icon holds while its manifest loads.
const NO_ICON = () => <span aria-hidden className="size-4 shrink-0" />;

export function LeaveOutPickerView({
  value,
  onChange,
  ignored,
  disabled = false,
  note,
  fileIcon = NO_ICON,
  onAdd,
  children,
}: {
  value: IgnoreSelection;
  onChange: (next: IgnoreSelection) => void;
  ignored: IgnoredPathsState;
  // Read-only: the rule shows, nothing changes it.
  disabled?: boolean;
  // What the rule is for, under the heading.
  note?: ReactNode;
  // A chosen path's icon, by its file name (the app's MaterialIcon).
  fileIcon?: (name: string) => ReactNode;
  // Opens the browser the exceptions are picked in.
  onAdd: () => void;
  // Trailing content under the rule.
  children?: ReactNode;
}) {
  const bringing = value.base === "gitignored";
  const excepted = exceptionsOf(value);
  const remove = (path: string) =>
    onChange({
      ...value,
      [bringing ? "brought" : "leftOut"]: withToggled(path)(new Set(excepted)),
    });
  const chosen = [...excepted].toSorted();
  const copy = IGNORE_BASE_COPY[value.base];
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
              icon={fileIcon(path.split("/").pop() ?? path)}
              disabled={disabled}
              onRemove={() => remove(path)}
            />
          ))}
          {!disabled && (
            <Button variant="ghost" size="sm" title={copy.hint} onClick={onAdd}>
              <Plus />
              {copy.add}
            </Button>
          )}
        </div>
      )}
      {children}
    </section>
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
  ignored: IgnoredPathsState;
  brought: ReadonlySet<string>;
}) {
  if (ignored.isPending) return <CardSkeleton />;
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
  icon,
  disabled,
  onRemove,
}: {
  path: string;
  icon: ReactNode;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5">
      {icon}
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
        {path}
      </span>
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
