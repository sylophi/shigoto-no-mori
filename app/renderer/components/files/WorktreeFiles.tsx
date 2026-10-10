import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { SidebarTakeover } from "@/components/sidebar/SidebarTakeover";
import { WorktreeMissingView } from "@shigomori/ui/views/shared/WorktreeMissingView.tsx";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { usePhoneLayout } from "@/hooks/ui/useViewport";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { useWorktreeName } from "@/hooks/worktrees/useWorktreeTitle";
import { peerFilesHiddenNote } from "@shigomori/ui/lib/commandAccessCopy.ts";
import { readStored, writeStored } from "@/lib/localStorage";
import { withMember } from "@shigomori/ui/lib/toggleSet.ts";
import type { Worktree } from "@shigomori/contracts/schemas";
import { FileTree } from "./FileTree";
import { ancestorsOf } from "@shigomori/ui/views/files/treePaths.ts";
import { FileViewer } from "./FileViewer";
import {
  FilesHeaderView,
  FilesNoteView,
  FilesPageView,
  FilesTreeSheetView,
  HideIgnoredToggleView,
} from "@shigomori/ui/views/files/WorktreeFilesView.tsx";

// Kept across worktrees and launches, like the diff's line wrap.
const HIDE_IGNORED_STORAGE_KEY = "files.hideIgnored";

export function WorktreeFiles() {
  const { worktree, goBack, missing } = useRouteWorktree();
  if (!worktree) {
    return <WorktreeMissingView {...missing} />;
  }
  return <WorktreeFilesPage worktree={worktree} onBack={goBack} />;
}

// A worktree's files, browsed read-only: the folder tree in the app
// sidebar (SidebarTakeover), the picked file filling the page. The
// pick lives in the route's search (`path`), so a link can open the
// page on a file.
function WorktreeFilesPage({
  worktree,
  onBack,
}: {
  worktree: Worktree;
  onBack: () => void;
}) {
  const nav = useWorktreeNav();
  const { remote, keys } = useHostScope();
  const queryClient = useQueryClient();
  // Every read here rides the command grant (worktrees:readFile). Local
  // is granted by contract, and a verdict in flight counts as granted,
  // so only a peer that said no gets the note instead of the tree.
  const { canCommand } = useCommandAccess();
  const { projectId, id: worktreeId } = worktree;
  const { path } = useSearch({ strict: false }) as { path?: string };
  const selected = path ?? null;
  // The folders down to a linked file start open, so its row is there
  // to see. Past that, what is open is the tree's own business.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(selected === null ? [] : ancestorsOf(selected)),
  );
  const [hideIgnored, setHideIgnored] = useState(
    () => readStored(HIDE_IGNORED_STORAGE_KEY) !== "false",
  );
  const toggleHideIgnored = () => {
    const next = !hideIgnored;
    setHideIgnored(next);
    writeStored(HIDE_IGNORED_STORAGE_KEY, String(next));
  };
  const phone = usePhoneLayout();
  const backLabel = useWorktreeName(worktree);
  const [treeSheetOpen, setTreeSheetOpen] = useState(false);

  const toggleFolder = (folder: string, open: boolean) =>
    setExpanded((prev) => withMember(prev, folder, open));
  const selectFile = (file: string) => {
    setTreeSheetOpen(false);
    nav.toFiles(projectId, worktreeId, { path: file, replace: true });
  };
  // Nothing watches plain files, so this is the way to see a change
  // made while the page sat in front (focus refetches the rest).
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: keys.worktreeFolders(projectId, worktreeId),
    });
    void queryClient.invalidateQueries({
      queryKey: keys.worktreeFiles(projectId, worktreeId),
    });
  };

  const treeProps = {
    projectId,
    worktreeId,
    selectedPath: selected,
    expanded,
    hideIgnored,
    onToggleFolder: toggleFolder,
    onSelectFile: selectFile,
  };
  const hideIgnoredToggle = (
    <HideIgnoredToggleView hidden={hideIgnored} onToggle={toggleHideIgnored} />
  );
  // Reveal is this machine's Finder, so only a local page offers it.
  const viewer = selected !== null && (
    <FileViewer
      projectId={projectId}
      worktreeId={worktreeId}
      path={selected}
      revealRoot={remote ? null : worktree.path}
    />
  );

  return (
    <FilesPageView
      takeover={
        <SidebarTakeover
          back={{ label: backLabel, onClick: onBack }}
          actions={canCommand && hideIgnoredToggle}
        >
          {canCommand && <FileTree {...treeProps} className="min-h-0 flex-1" />}
        </SidebarTakeover>
      }
      header={
        <FilesHeaderView
          worktreeName={worktree.name}
          back={phone ? { label: backLabel, onClick: onBack } : null}
          controls={
            canCommand
              ? {
                  onBrowse:
                    phone && selected !== null
                      ? () => setTreeSheetOpen(true)
                      : null,
                  hideIgnored: phone && hideIgnoredToggle,
                  onRefresh: refresh,
                }
              : null
          }
        />
      }
      body={
        !canCommand ? (
          <FilesNoteView peerNote={peerFilesHiddenNote()} />
        ) : phone ? (
          // No width beside the viewer on a phone: the tree is the page
          // until a file is picked, and a sheet after.
          viewer || (
            <FileTree {...treeProps} className="min-h-0 w-full flex-1" />
          )
        ) : (
          viewer || <FilesNoteView peerNote={null} />
        )
      }
      sheet={
        phone && (
          <FilesTreeSheetView
            open={treeSheetOpen}
            onOpenChange={setTreeSheetOpen}
          >
            <FileTree {...treeProps} className="h-[70cqh] w-full" />
          </FilesTreeSheetView>
        )
      }
    />
  );
}
