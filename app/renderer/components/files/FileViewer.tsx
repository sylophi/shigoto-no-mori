import { getFiletypeFromFileName, preloadHighlighter } from "@pierre/diffs";
import { useQuery } from "@tanstack/react-query";
import { CODE_THEME } from "@/components/diff/codeTheme";
import { useTheme } from "@/hooks/ui/useTheme";
import { useWorktreeFile } from "@/hooks/worktrees/useWorktreeFile";
import { formatBytes } from "@/lib/formatBytes";
import { queryKeys } from "@/lib/queryKeys";
import { notifyError } from "@/lib/toast";
import type { WorktreeFile } from "@shigomori/contracts/schemas";
import { CodeFileView, FileViewerView } from "./FileViewerView";

// The files page's pane: one file, read whole and highlighted by the
// same renderer the diffs use.
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
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    <FileViewerView
      path={path}
      size={data && data.kind !== "missing" ? data.size : null}
      onReveal={
        revealRoot === null
          ? null
          : () => {
              window.api.shell
                .showItemInFolder({ path: `${revealRoot}/${path}` })
                .catch((err: unknown) =>
                  notifyError("Couldn't reveal the file", err),
                );
            }
      }
      reading={isPending}
      message={
        isPending
          ? null
          : isError
            ? "Couldn't read file."
            : data.kind !== "text" || data.contents.length === 0
              ? placeholderFor(data)
              : null
      }
    >
      {data?.kind === "text" && (
        <CodeFile name={name} contents={data.contents} />
      )}
    </FileViewerView>
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
  return <CodeFileView name={name} contents={contents} themeType={resolved} />;
}
