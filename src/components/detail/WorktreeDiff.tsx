import { useState } from "react";
// parsePatchFiles lives in the root entry, not /react (the docs example
// is slightly off — `@pierre/diffs/react` only re-exports the React
// components and shared types). The two imports are friendly together.
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { useWorktreeDiff, useWorktrees } from "@/hooks/useWorktrees";
import { worktreeDiffRoute } from "@/router";
import type { Worktree } from "@shared/schemas";

type DiffStyle = "unified" | "split";

const DIFF_THEME = {
  theme: { dark: "pierre-dark", light: "pierre-light" } as const,
  // 'simple' is the shortest built-in separator (vs 'line-info' default
  // which renders rounded corners and an expansion-control row).
  hunkSeparators: "simple" as const,
};

// CSS custom properties inherit through the library's shadow DOM, so
// setting them on the wrapper applies to every FileDiff child.
const DIFF_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "1.45",
  "--diffs-gap-block": "4px",
  "--diffs-gap-inline": "6px",
} as React.CSSProperties;

export function WorktreeDiff() {
  const { projectId, worktreeName } = worktreeDiffRoute.useParams();
  const navigate = useNavigate();
  const { data: worktrees = [] } = useWorktrees(projectId);
  const worktree = worktrees.find((w) => w.name === worktreeName);

  const goBack = () =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeName",
      params: { projectId, worktreeName },
    });

  if (!worktree) {
    return (
      <div className="flex h-full flex-col">
        <header className="border-b border-border px-6 pt-7 pb-4">
          <BackButton onClick={goBack} label="Back" />
        </header>
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Worktree not found.
        </div>
      </div>
    );
  }

  return <WorktreeDiffInner worktree={worktree} onBack={goBack} />;
}

function WorktreeDiffInner({
  worktree,
  onBack,
}: {
  worktree: Worktree;
  onBack: () => void;
}) {
  const {
    data: patch,
    isLoading,
    error,
  } = useWorktreeDiff(worktree.projectId, worktree.id);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");

  // `PatchDiff` requires a single-file patch; for multi-file output we
  // parse with `parsePatchFiles` and spawn one `<FileDiff>` per file
  // per the library's recommended pattern. React Compiler memoizes
  // this implicitly.
  const parsedPatches = patch ? parsePatchFiles(patch) : [];
  const allFiles = parsedPatches.flatMap((p) => p.files);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 pt-7 pb-4">
        <BackButton onClick={onBack} label={worktree.branch} />
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="truncate font-mono text-xl font-medium tracking-tight">
              Uncommitted changes
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              {worktree.changedCount}{" "}
              {worktree.changedCount === 1 ? "file" : "files"} changed in{" "}
              <span className="font-mono">{worktree.name}</span>
            </p>
          </div>
          <DiffStyleToggle value={diffStyle} onChange={setDiffStyle} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto bg-background">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 aria-hidden className="mr-2 size-3.5 animate-spin" />
            Computing diff…
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6 text-sm text-destructive">
            {error.message}
          </div>
        ) : allFiles.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No uncommitted changes.
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-2" style={DIFF_STYLE}>
            {allFiles.map((fileDiff) => (
              <FileDiff
                key={`${fileDiff.prevName ?? ""} ${fileDiff.name}`}
                fileDiff={fileDiff}
                options={{ ...DIFF_THEME, diffStyle }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DiffStyleToggle({
  value,
  onChange,
}: {
  value: DiffStyle;
  onChange: (next: DiffStyle) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Diff layout"
      className="inline-flex shrink-0 self-center rounded-md border border-border bg-muted/30 p-0.5 text-xs"
    >
      <ToggleOption
        active={value === "unified"}
        onClick={() => onChange("unified")}
        label="Unified"
      />
      <ToggleOption
        active={value === "split"}
        onClick={() => onChange("split")}
        label="Split"
      />
    </div>
  );
}

function ToggleOption({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded px-2 py-1 transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function BackButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft aria-hidden className="size-3" />
      <span>{label}</span>
    </button>
  );
}
