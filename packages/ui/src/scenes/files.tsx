// The files page over the fixtures: happy-hummingbird's tree in the
// sidebar with src open and its index.ts in the pane, and the page's
// other states.
import type { ReactNode } from "react";
import {
  FileTreeNoteView,
  FileTreeRowsView,
  FileTreeView,
} from "../views/files/FileTreeView.tsx";
import {
  CodeFileView,
  FileViewerView,
  MarkdownFileView,
  MediaFileView,
} from "../views/files/FileViewerView.tsx";
import { defaultBinding } from "../lib/keymap.ts";
import {
  FilesHeaderView,
  FilesNoteView,
  FilesPageView,
  FilesTreeSheetView,
  HideIgnoredToggleView,
} from "../views/files/WorktreeFilesView.tsx";
import { SidebarTakeoverView } from "../views/sidebar/SidebarTakeoverView.tsx";
import { peerFilesHiddenNote } from "../lib/commandAccessCopy.ts";
import { FAKE_TREE, fakeFile } from "../fixtures/filesFixtures.ts";
import { LOCAL_DEVICE_ID } from "../fixtures/fixtures.ts";
import { SceneWindowFrame } from "./frame.tsx";
import { SceneSidebar } from "./sidebar.tsx";
import { projectNamed, worktreeNamed } from "./world.ts";

const noop = () => {};

const find = {
  open: false,
  keys: defaultBinding("find").label,
  onToggle: noop,
};
const HUM = worktreeNamed(
  projectNamed(LOCAL_DEVICE_ID, "shigoto-no-mori"),
  "happy-hummingbird",
);
const PICKED = "src/index.ts";
const EXPANDED = new Set(["src"]);
const LEAF =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#3a9a5b" d="M5 19C5 9 11 4 20 4c0 9-5 15-15 15Z"/></svg>';

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
                  {() => rows("", 0)}
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
      shown={null}
      onReveal={noop}
      reading={false}
      message={null}
      find={find}
      findBar={null}
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
// a file being read, a Markdown file rendered, an image, one the pane
// has no drawing for, and a folder that couldn't be read.
export function FilesPartsScene() {
  const file = fakeFile("README.md");
  const readme = file.kind === "text" ? file.contents : "";
  return (
    <div className="grid h-full grid-cols-2 gap-6 overflow-hidden bg-background p-6 text-foreground">
      <Part label="Nothing picked">
        <FilesNoteView peerNote={null} />
      </Part>
      <Part label="A peer's files">
        <FilesNoteView peerNote={peerFilesHiddenNote("MacBook")} />
      </Part>
      <Part label="Reading">
        <FileViewerView
          path="src/index.ts"
          size={null}
          shown={null}
          onReveal={null}
          reading
          message={null}
          find={null}
          findBar={null}
        >
          {null}
        </FileViewerView>
      </Part>
      <Part label="Markdown, rendered">
        <FileViewerView
          path="README.md"
          size={readme.length}
          shown={{ value: "preview", onChange: noop }}
          onReveal={null}
          reading={false}
          message={null}
          find={find}
          findBar={null}
        >
          <MarkdownFileView source={readme} />
        </FileViewerView>
      </Part>
      <Part label="An image">
        <FileViewerView
          path="assets/leaf.svg"
          size={LEAF.length}
          shown={{ value: "preview", onChange: noop }}
          onReveal={null}
          reading={false}
          message={null}
          find={null}
          findBar={null}
        >
          <MediaFileView
            mime="image/svg+xml"
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(LEAF)}`}
          />
        </FileViewerView>
      </Part>
      <Part label="Binary">
        <FileViewerView
          path="assets/logo.psd"
          size={48_213}
          shown={null}
          onReveal={null}
          reading={false}
          message="Binary file, not shown."
          find={null}
          findBar={null}
        >
          {null}
        </FileViewerView>
      </Part>
      <Part label="A folder that couldn't be read">
        <FileTreeView expanded={new Set()} onToggleFolder={noop}>
          {() => (
            <FileTreeNoteView depth={0}>Couldn't read folder</FileTreeNoteView>
          )}
        </FileTreeView>
      </Part>
    </div>
  );
}
