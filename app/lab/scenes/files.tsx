// The files page over the fixtures: happy-hummingbird's tree in the
// sidebar with src open and its index.ts in the pane, and the page's
// other states.
import type { ReactNode } from "react";
import {
  FileTreeNoteView,
  FileTreeRowsView,
  FileTreeView,
} from "@shigomori/ui/views/files/FileTreeView.tsx";
import {
  CodeFileView,
  FileViewerView,
} from "@shigomori/ui/views/files/FileViewerView.tsx";
import {
  FilesHeaderView,
  FilesNoteView,
  FilesPageView,
  FilesTreeSheetView,
  HideIgnoredToggleView,
} from "@shigomori/ui/views/files/WorktreeFilesView.tsx";
import { SidebarTakeoverView } from "@shigomori/ui/views/sidebar/SidebarTakeoverView.tsx";
import { peerFilesHiddenNote } from "@shigomori/ui/lib/commandAccessCopy.ts";
import { FAKE_TREE, fakeFile } from "../fake-host/filesFixtures";
import { LOCAL_DEVICE_ID } from "../fake-host/fixtures";
import { SceneWindowFrame } from "./frame";
import { SceneSidebar } from "./sidebar";
import { projectNamed, worktreeNamed } from "./world";

const noop = () => {};
const HUM = worktreeNamed(
  projectNamed(LOCAL_DEVICE_ID, "shigoto-no-mori"),
  "happy-hummingbird",
);
const PICKED = "src/index.ts";
const EXPANDED = new Set(["src"]);

// One folder's rows, the open ones' under them, ignored files left out.
function rows(parent: string, depth: number): ReactNode {
  const entries = (FAKE_TREE[parent] ?? []).filter((e) => !e.ignored);
  return (
    <FileTreeRowsView
      parent={parent}
      entries={entries}
      depth={depth}
      selectedPath={PICKED}
      expanded={EXPANDED}
      tabStop={PICKED}
      onToggleFolder={noop}
      onSelectFile={noop}
      renderFolder={(path) =>
        FAKE_TREE[path] ? (
          rows(path, depth + 1)
        ) : (
          <FileTreeNoteView depth={depth + 1} loading>
            Loading…
          </FileTreeNoteView>
        )
      }
    />
  );
}

function filesPage(body: ReactNode, tree: boolean) {
  const toggle = <HideIgnoredToggleView hidden onToggle={noop} />;
  return (
    <SceneWindowFrame
      sidebar={
        <SceneSidebar
          view="projects"
          open
          takeover={
            <SidebarTakeoverView
              back={{ label: HUM.name, onClick: noop }}
              actions={tree && toggle}
            >
              {tree && (
                <FileTreeView
                  expanded={EXPANDED}
                  onToggleFolder={noop}
                  className="min-h-0 flex-1"
                >
                  {rows("", 0)}
                </FileTreeView>
              )}
            </SidebarTakeoverView>
          }
        />
      }
      pathname="/projects"
    >
      <FilesPageView
        takeover={null}
        header={
          <FilesHeaderView
            worktreeName={HUM.name}
            back={null}
            controls={
              tree
                ? { onBrowse: null, hideIgnored: null, onRefresh: noop }
                : null
            }
          />
        }
        body={body}
        sheet={
          <FilesTreeSheetView open={false} onOpenChange={noop}>
            {null}
          </FilesTreeSheetView>
        }
      />
    </SceneWindowFrame>
  );
}

// happy-hummingbird's files, src/index.ts open.
export function FilesPageScene() {
  const file = fakeFile(PICKED);
  return filesPage(
    <FileViewerView
      path={PICKED}
      size={file.kind === "text" ? file.size : null}
      onReveal={noop}
      reading={false}
      message={null}
    >
      {file.kind === "text" && (
        <CodeFileView
          name="index.ts"
          contents={file.contents}
          themeType="light"
        />
      )}
    </FileViewerView>,
    true,
  );
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs text-muted-foreground">{label}</h2>
      <div className="flex h-40 flex-col overflow-hidden rounded-md border border-border">
        {children}
      </div>
    </section>
  );
}

// The page's other states: nothing picked, a peer that shows no files,
// a file being read, one the pane has no drawing for, and a folder
// that couldn't be read.
export function FilesPartsScene() {
  return (
    <div className="grid h-full grid-cols-2 gap-6 overflow-hidden bg-background p-6 text-foreground">
      <Part label="Nothing picked">
        <FilesNoteView peerNote={null} />
      </Part>
      <Part label="A peer's files">
        <FilesNoteView peerNote={peerFilesHiddenNote("Thinkpad")} />
      </Part>
      <Part label="Reading">
        <FileViewerView
          path="src/index.ts"
          size={null}
          onReveal={null}
          reading
          message={null}
        >
          {null}
        </FileViewerView>
      </Part>
      <Part label="Binary">
        <FileViewerView
          path="assets/logo.png"
          size={48_213}
          onReveal={null}
          reading={false}
          message="Binary file, not shown."
        >
          {null}
        </FileViewerView>
      </Part>
      <Part label="A folder that couldn't be read">
        <FileTreeView expanded={new Set()} onToggleFolder={noop}>
          <FileTreeNoteView depth={0}>Couldn't read folder</FileTreeNoteView>
        </FileTreeView>
      </Part>
    </div>
  );
}
