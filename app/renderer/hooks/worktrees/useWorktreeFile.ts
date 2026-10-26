import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorktreeFile } from "@shigomori/contracts/schemas";
import { type HostScope, useHostScope } from "@/hooks/remote/useHostScope";
import { gatedHostReadMeta } from "@/lib/queryClientOptions";

// One file of a worktree. Nothing watches plain files for edits, so it
// goes stale in seconds and is refetched on mount and focus: coming back
// from an editor shows what was saved.
function worktreeFileQuery(
  { api, keys }: Pick<HostScope, "api" | "keys">,
  projectId: string,
  worktreeId: string,
  path: string,
) {
  return queryOptions<WorktreeFile>({
    queryKey: keys.worktreeFile(projectId, worktreeId, path),
    queryFn: ({ signal }) =>
      api.run(api.worktrees.readFile({ projectId, worktreeId, path }), {
        signal,
      }),
    // Long enough that stepping between files already looked at doesn't
    // read (and, from a peer, ship) each one again.
    staleTime: 5_000,
    // Every file looked at leaves its contents behind (up to the read
    // cap each), so only a recent one is kept for an instant second look.
    gcTime: 60_000,
  });
}

// A file for the files page's viewer.
export function useWorktreeFile(
  projectId: string,
  worktreeId: string,
  path: string,
) {
  const scope = useHostScope();
  return useQuery({
    ...worktreeFileQuery(scope, projectId, worktreeId, path),
    // The pane says so itself, and a peer without the grant refusing
    // is a state, not an error.
    meta: gatedHostReadMeta(scope.remote, "Couldn't read file"),
  });
}

// One side of an image, video or audio file in a diff, by the blob id
// its patch names. A blob never changes, so it is kept while in use.
export function useGitBlob(
  projectId: string,
  worktreeId: string,
  oid: string,
  path: string,
  enabled: boolean,
) {
  const { api, keys } = useHostScope();
  return useQuery<WorktreeFile>({
    queryKey: keys.gitBlob(projectId, worktreeId, oid, path),
    queryFn: ({ signal }) =>
      api.run(api.worktrees.readBlob({ projectId, worktreeId, oid, path }), {
        signal,
      }),
    enabled,
    staleTime: Infinity,
    gcTime: 60_000,
    // The side says so itself, and a diff can hold dozens of them.
    meta: { silentError: true },
  });
}

// An image a Markdown file in a worktree names by a local path, as a
// data: URL, read as the viewer reads a file. Relative to the file's
// folder, or to the worktree's root from a leading slash, as GitHub
// shows it.
export function useWorktreeImage(
  projectId: string,
  worktreeId: string,
  markdownPath: string,
): (src: string) => Promise<string> {
  const queryClient = useQueryClient();
  const scope = useHostScope();
  return async (src) => {
    const path = decodeURIComponent(
      new URL(
        src,
        `file:///${markdownPath.split("/").map(encodeURIComponent).join("/")}`,
      ).pathname.slice(1),
    );
    const file = await queryClient.fetchQuery({
      ...worktreeFileQuery(scope, projectId, worktreeId, path),
      // One that won't read stays blank, which says so.
      meta: { silentError: true },
    });
    if (file.kind === "media") return `data:${file.mime};base64,${file.base64}`;
    if (file.kind === "text" && /\.svg$/i.test(path)) {
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.contents)}`;
    }
    throw new Error(`Not an image: ${path}`);
  };
}
