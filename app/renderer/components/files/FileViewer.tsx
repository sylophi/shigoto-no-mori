import { getFiletypeFromFileName, preloadHighlighter } from "@pierre/diffs";
import { File } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, Loader2 } from "lucide-react";
import { CODE_STYLE, CODE_THEME } from "@/components/diff/codeTheme";
import { CenteredMessage } from "@/components/ui/centered-message";
import { CopyButton } from "@/components/ui/copy-button";
import { IconButton } from "@/components/ui/icon-button";
import { useTheme } from "@/hooks/ui/useTheme";
import { useWorktreeFile } from "@/hooks/worktrees/useWorktreeFile";
import { formatBytes } from "@/lib/formatBytes";
import { queryKeys } from "@/lib/queryKeys";
import { notifyError } from "@/lib/toast";
import type { WorktreeFile } from "@shared/schemas";

// Past this many lines a file shows as plain text: highlighting it
// would hold the window for seconds, all at once on the main thread.
const TOKENIZE_MAX_LINES = 10_000;

// The files page's pane: one file, read whole and highlighted by the
// same renderer the diffs use. Read-only by design (PRODUCT.md: the
// app doesn't own the editor).
export function FileViewer({
  projectId,
  worktreeId,
  path,
  revealRoot,
}: {
  projectId: string;
  worktreeId: string;
  path: string;
  // The worktree's folder on this machine, for Reveal in Finder. Null
  // on a peer's page, where Finder would be the wrong machine's.
  revealRoot: string | null;
}) {
  const { data, isPending, isError } = useWorktreeFile(
    projectId,
    worktreeId,
    path,
  );
  const cut = path.lastIndexOf("/");
  const name = path.slice(cut + 1);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs select-text"
          title={path}
        >
          {cut >= 0 && (
            <span className="text-muted-foreground">
              {path.slice(0, cut + 1)}
            </span>
          )}
          {name}
        </span>
        {data && data.kind !== "missing" && (
          <span className="tabular shrink-0 text-2xs text-muted-foreground">
            {formatBytes(data.size)}
          </span>
        )}
        <CopyButton value={path} label="Copy path" />
        {revealRoot !== null && (
          <IconButton
            onClick={() => {
              window.api.shell
                .showItemInFolder(`${revealRoot}/${path}`)
                .catch((err: unknown) =>
                  notifyError("Couldn't reveal the file", err),
                );
            }}
            title="Reveal in Finder"
            aria-label="Reveal in Finder"
            className="shrink-0 p-0.5"
          >
            <FolderOpen aria-hidden className="size-3.5" />
          </IconButton>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {isPending ? (
          <CenteredMessage>
            <Loader2 aria-hidden className="mr-2 size-3.5 animate-spin" />
            Reading file…
          </CenteredMessage>
        ) : isError || data.kind !== "text" || data.contents.length === 0 ? (
          <CenteredMessage className="px-6 text-center">
            {isError ? "Couldn't read file." : placeholderFor(data)}
          </CenteredMessage>
        ) : (
          <CodeFile name={name} contents={data.contents} />
        )}
      </div>
    </div>
  );
}

// What the pane says in place of a file it has nothing to draw for.
function placeholderFor(file: WorktreeFile): string {
  switch (file.kind) {
    case "missing":
      return "This file is no longer in the worktree.";
    case "binary":
      return "Binary file, not shown.";
    case "tooLarge":
      return `Too large to show here (${formatBytes(file.size)}).`;
    case "text":
      return "Empty file.";
  }
}

// The highlighted file. Mounted only once the shared highlighter holds
// the file's language: pierre's File treats a <pre> it finds in its
// shadow root as prerendered, so a remount before the first paint (the
// dev StrictMode double mount, while a language is still loading)
// hydrates the empty one the first instance left and never paints.
// Loaded up front, the first render is already the finished one.
function CodeFile({ name, contents }: { name: string; contents: string }) {
  // Pierre picks between its dark and light entries off the shadow
  // root's color-scheme, which follows the OS unless told otherwise.
  const { resolved } = useTheme();
  const lang = getFiletypeFromFileName(name);
  const { isPending } = useQuery({
    queryKey: queryKeys.codeHighlighter(lang),
    queryFn: async () => {
      await preloadHighlighter({
        themes: Object.values(CODE_THEME.theme),
        langs: [lang],
      });
      return true;
    },
    staleTime: Infinity,
    gcTime: Infinity,
    // Not worth a wait or a toast: a language that won't load leaves
    // the file plain, which is still the file.
    retry: false,
    meta: { silentError: true },
  });
  // A language that fails to load still shows the file, unhighlighted,
  // so only the wait holds it back.
  if (isPending) return null;
  return (
    <div data-slot="file-view" className="p-2 select-text" style={CODE_STYLE}>
      <File
        file={{ name, contents }}
        options={{
          ...CODE_THEME,
          themeType: resolved,
          disableFileHeader: true,
          overflow: "scroll",
          tokenizeMaxLength: TOKENIZE_MAX_LINES,
        }}
      />
    </div>
  );
}
