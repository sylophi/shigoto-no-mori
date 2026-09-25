import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { Files, RotateCw } from "lucide-react";
import { PAGE_HEADER_PADDING } from "@/components/shared/PageHeader";
import { WorktreeMissing } from "@/components/shared/WorktreeMissing";
import { BackButton } from "@/components/ui/back-button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { ChipButton } from "@/components/ui/chip-button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useElementWidth } from "@/hooks/ui/useElementWidth";
import { useResizableWidth } from "@/hooks/ui/useResizableWidth";
import { usePhoneLayout } from "@/hooks/ui/useViewport";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { peerFilesHiddenNote } from "@/lib/commandAccessCopy";
import { withMember } from "@/lib/toggleSet";
import type { Worktree } from "@shared/schemas";
import { ancestorsOf, FileTree } from "./FileTree";
import { FileViewer } from "./FileViewer";

// The rail is dragged between these. The upper one is lowered further
// by the pane, so the viewer always keeps VIEWER_MIN beside it.
const RAIL_MIN = 200;
const RAIL_MAX = 560;
const RAIL_DEFAULT = 280;
const VIEWER_MIN = 320;

export function WorktreeFiles() {
  const { worktree, goBack, missing } = useRouteWorktree();
  if (!worktree) {
    return <WorktreeMissing {...missing} />;
  }
  return <FilesView worktree={worktree} onBack={goBack} />;
}

// A worktree's files, browsed read-only: the folder tree on the left,
// the picked file on the right. The pick lives in the route's search
// (`path`), so a link can open the page on a file.
function FilesView({
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
  const [paneRef, paneWidth] = useElementWidth<HTMLDivElement>();
  const phone = usePhoneLayout();
  const [treeSheetOpen, setTreeSheetOpen] = useState(false);
  const rail = useResizableWidth({
    storageKey: "files.railWidth",
    min: RAIL_MIN,
    max:
      paneWidth === null
        ? RAIL_MAX
        : Math.max(RAIL_MIN, Math.min(RAIL_MAX, paneWidth - VIEWER_MIN)),
    fallback: RAIL_DEFAULT,
    leftEdge: () => paneRef.current?.getBoundingClientRect().left ?? 0,
  });

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
    onToggleFolder: toggleFolder,
    onSelectFile: selectFile,
  };
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
    <div ref={paneRef} className="flex h-full flex-col">
      <header
        className={`flex flex-col gap-3 border-b border-border ${PAGE_HEADER_PADDING}`}
      >
        <BackButton onClick={onBack} label={worktree.branch} />
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="truncate text-xl font-medium tracking-tight phone:text-lg">
              Files
            </h1>
            <p className="truncate font-mono text-xs text-muted-foreground select-text">
              {worktree.name}
            </p>
          </div>
          {canCommand && (
            <div className="flex shrink-0 items-center gap-2 self-center">
              {phone && selected !== null && (
                <ChipButton
                  onClick={() => setTreeSheetOpen(true)}
                  title="Browse files"
                  aria-label="Browse files"
                  className="py-1.5"
                >
                  <Files aria-hidden className="size-3.5" />
                </ChipButton>
              )}
              <ChipButton
                onClick={refresh}
                title="Refresh files"
                aria-label="Refresh files"
                className="py-1.5"
              >
                <RotateCw aria-hidden className="size-3.5" />
              </ChipButton>
            </div>
          )}
        </div>
      </header>

      {!canCommand ? (
        <CenteredMessage className="px-6 text-center">
          {peerFilesHiddenNote()}
        </CenteredMessage>
      ) : phone ? (
        // No width beside the viewer on a phone: the tree is the page
        // until a file is picked, and a sheet after.
        viewer || <FileTree {...treeProps} className="min-h-0 w-full flex-1" />
      ) : (
        <div className="flex min-h-0 flex-1">
          <FileTree {...treeProps} width={rail.width} />
          <div
            onMouseDown={rail.onMouseDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file tree"
            tabIndex={-1}
            className="relative w-px shrink-0 cursor-col-resize bg-border"
          >
            <div className="absolute inset-y-0 -left-1 w-2" />
          </div>
          {viewer || (
            <CenteredMessage className="min-w-0 flex-1 bg-background px-6">
              Pick a file to view it.
            </CenteredMessage>
          )}
        </div>
      )}

      {phone && (
        <Sheet open={treeSheetOpen} onOpenChange={setTreeSheetOpen}>
          <SheetContent
            side="bottom"
            showCloseButton={false}
            className="gap-0 p-0"
          >
            <SheetTitle className="sr-only">Files</SheetTitle>
            <FileTree {...treeProps} className="h-[70dvh] w-full" />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
