import type { ReactNode } from "react";
import { File } from "@pierre/diffs/react";
import { FolderOpen, Loader2 } from "lucide-react";
import { CODE_STYLE, CODE_THEME } from "@/components/diff/codeTheme";
import { CenteredMessage } from "@shigomori/ui/primitives/centered-message.tsx";
import { CopyButton } from "@shigomori/ui/primitives/copy-button.tsx";
import { IconButton } from "@shigomori/ui/primitives/icon-button.tsx";
import { formatBytes } from "@/lib/formatBytes";

// Past this many lines a file shows as plain text: highlighting it
// would hold the window for seconds, all at once on the main thread.
const TOKENIZE_MAX_LINES = 10_000;

// The files page's pane: one file, read whole (FileViewer.tsx reads
// it). Read-only by design (PRODUCT.md: the app doesn't own the
// editor).
export function FileViewerView({
  path,
  size,
  onReveal,
  reading,
  message,
  children,
}: {
  path: string;
  // Unknown until read, and for a file that is gone.
  size: number | null;
  // Reveal in Finder, this machine's alone: null on a peer's page.
  onReveal: (() => void) | null;
  reading: boolean;
  // What stands in for a file with nothing to draw.
  message: string | null;
  // The highlighted file (CodeFileView).
  children: ReactNode;
}) {
  const cut = path.lastIndexOf("/");
  const name = path.slice(cut + 1);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs select-text">
          {cut >= 0 && (
            <span className="text-muted-foreground">
              {path.slice(0, cut + 1)}
            </span>
          )}
          {name}
        </span>
        {size !== null && (
          <span className="tabular shrink-0 text-2xs text-muted-foreground">
            {formatBytes(size)}
          </span>
        )}
        <CopyButton value={path} label="Copy path" />
        {onReveal && (
          <IconButton
            onClick={onReveal}
            aria-label="Reveal in Finder"
            className="shrink-0 p-0.5"
          >
            <FolderOpen aria-hidden className="size-3.5" />
          </IconButton>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {reading ? (
          <CenteredMessage>
            <Loader2 aria-hidden className="mr-2 size-3.5 animate-spin" />
            Reading file…
          </CenteredMessage>
        ) : message !== null ? (
          <CenteredMessage className="px-6 text-center">
            {message}
          </CenteredMessage>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

// The file, highlighted by the same renderer the diffs use.
export function CodeFileView({
  name,
  contents,
  themeType,
}: {
  name: string;
  contents: string;
  themeType: "light" | "dark";
}) {
  return (
    <div data-slot="file-view" className="p-2 select-text" style={CODE_STYLE}>
      <File
        file={{ name, contents }}
        options={{
          ...CODE_THEME,
          themeType,
          disableFileHeader: true,
          overflow: "scroll",
          tokenizeMaxLength: TOKENIZE_MAX_LINES,
        }}
      />
    </div>
  );
}
