import { type ReactNode, useState } from "react";
import { File } from "@pierre/diffs/react";
import { FolderOpen, Loader2 } from "lucide-react";
import { CODE_STYLE, CODE_THEME } from "../diff/codeTheme.ts";
import { CenteredMessage } from "../../primitives/centered-message.tsx";
import { CopyButton } from "../../primitives/copy-button.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { Markdown } from "../../primitives/markdown.tsx";
import { SegmentedControl } from "../../primitives/segmented-control.tsx";
import { formatBytes } from "../../lib/formatBytes.ts";

// Past this many lines a file shows as plain text: highlighting it
// would hold the window for seconds, all at once on the main thread.
const TOKENIZE_MAX_LINES = 10_000;

// A file with a rendered form shows it, or its source.
export type FileShown = "preview" | "source";

const SHOWN_OPTIONS = [
  { value: "preview", label: "Preview" },
  { value: "source", label: "Source" },
] as const;

// The files page's pane: one file, read whole (FileViewer.tsx reads
// it). Read-only by design (PRODUCT.md: the app doesn't own the
// editor).
export function FileViewerView({
  path,
  size,
  shown,
  onReveal,
  reading,
  message,
  children,
}: {
  path: string;
  // Unknown until read, and for a file that is gone.
  size: number | null;
  // The Preview / Source switch, for a file with a rendered form.
  shown: { value: FileShown; onChange: (next: FileShown) => void } | null;
  // Reveal in Finder, this machine's alone: null on a peer's page.
  onReveal: (() => void) | null;
  reading: boolean;
  // What stands in for a file with nothing to draw.
  message: string | null;
  // The file: highlighted (CodeFileView), rendered (MarkdownFileView)
  // or drawn (MediaFileView).
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
        {shown && (
          <SegmentedControl
            aria-label="Show"
            optionClassName="px-2 py-0.5 text-2xs"
            value={shown.value}
            onChange={shown.onChange}
            options={SHOWN_OPTIONS}
          />
        )}
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

// A Markdown file, rendered as GitHub shows it. Without a line break
// for each one in the source, so prose wrapped there reflows.
export function MarkdownFileView({
  source,
  remoteImage,
  localImage,
}: {
  source: string;
  // An image on the project's remotes' hosts, and one in the worktree
  // (Markdown).
  remoteImage?: (url: string) => Promise<string>;
  localImage?: (src: string) => Promise<string>;
}) {
  return (
    <Markdown
      source={source}
      remoteImage={remoteImage}
      localImage={localImage}
      breaks={false}
      className="mx-auto max-w-3xl px-6 py-4"
    />
  );
}

// An image, video or audio file, drawn by the browser itself. One it
// can't decode (a codec it lacks, or bytes that aren't what the
// extension says) gets a line instead of a broken frame.
export function MediaFileView({ mime, src }: { mime: string; src: string }) {
  // The source that failed, so another (another file, or this one
  // saved again) gets its own try.
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === src) {
    return <CenteredMessage>Can't show this file here.</CenteredMessage>;
  }
  const onError = () => setFailed(src);
  return (
    <div className="flex h-full items-center justify-center p-4">
      {mime.startsWith("video/") ? (
        // oxlint-disable-next-line jsx-a11y/media-has-caption -- a file in a worktree comes with no captions to offer
        <video
          src={src}
          controls
          onError={onError}
          className="max-h-full max-w-full"
        />
      ) : mime.startsWith("audio/") ? (
        // oxlint-disable-next-line jsx-a11y/media-has-caption -- a file in a worktree comes with no captions to offer
        <audio src={src} controls onError={onError} />
      ) : (
        <img
          src={src}
          alt=""
          onError={onError}
          className="max-h-full max-w-full object-contain"
        />
      )}
    </div>
  );
}
