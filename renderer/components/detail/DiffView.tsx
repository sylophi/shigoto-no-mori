import { useState, type ReactNode } from "react";
// parsePatchFiles lives in the root entry, not /react (the docs example
// is slightly off — `@pierre/diffs/react` only re-exports the React
// components and shared types). The two imports are friendly together.
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";

type DiffStyle = "unified" | "split";

const DIFF_THEME = {
  theme: { dark: "pierre-dark", light: "pierre-light" } as const,
  // 'simple' is the shortest built-in separator (vs 'line-info' default
  // which renders rounded corners and an expansion-control row).
  hunkSeparators: "simple" as const,
  // Pin the diff's base bg to the app's `--background` token. All the
  // per-row backgrounds (buffer, context, separator) derive from
  // `--diffs-bg` via color-mix, so overriding the one variable
  // cascades through the whole diff surface. Without this the diff
  // reads as a pitch-black slab against the lifted neutral-900 main
  // pane that PR #59 introduced. `unsafeCSS` is the documented path
  // for CSS overrides — see https://diffs.com/docs (Hunk Separators).
  unsafeCSS: `:host { --diffs-bg: var(--background); }`,
};

// CSS custom properties inherit through the library's shadow DOM, so
// setting them on the wrapper applies to every FileDiff child.
const DIFF_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "1.45",
  "--diffs-gap-block": "4px",
  "--diffs-gap-inline": "6px",
} as React.CSSProperties;

export function DiffView({
  patch,
  isLoading,
  error,
  onBack,
  backLabel,
  title,
  subtitle,
  emptyMessage,
}: {
  patch: string | undefined;
  isLoading: boolean;
  error: Error | null;
  onBack: () => void;
  backLabel: string;
  title: ReactNode;
  subtitle: ReactNode;
  emptyMessage: ReactNode;
}) {
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  // Pierre's library picks between the `dark`/`light` entries off the
  // shadow root's `color-scheme`, which defaults to the OS preference.
  // Force it to follow the in-app theme instead.
  const { resolved } = useTheme();

  const parsedPatches = patch ? parsePatchFiles(patch) : [];
  const allFiles = parsedPatches.flatMap((p) => p.files);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 pt-7 pb-4">
        <BackButton onClick={onBack} label={backLabel} />
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="truncate text-xl font-medium tracking-tight select-text">
              {title}
            </h1>
            <p className="truncate text-xs text-muted-foreground select-text">
              {subtitle}
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
          <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
            Couldn't compute diff.
          </div>
        ) : allFiles.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {emptyMessage}
          </div>
        ) : (
          <div
            className="flex flex-col gap-2 p-2 select-text"
            style={DIFF_STYLE}
          >
            {allFiles.map((fileDiff) => (
              // `PatchDiff` requires a single-file patch; for multi-file
              // output we parse with `parsePatchFiles` and spawn one
              // `<FileDiff>` per file per the library's recommended
              // pattern. React Compiler memoizes this implicitly.
              <FileDiff
                key={`${fileDiff.prevName ?? ""} ${fileDiff.name}`}
                fileDiff={fileDiff}
                options={{ ...DIFF_THEME, diffStyle, themeType: resolved }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function DiffNotFound({
  onBack,
  message,
}: {
  onBack: () => void;
  message: string;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 pt-7 pb-4">
        <BackButton onClick={onBack} label="Back" />
      </header>
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {message}
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
