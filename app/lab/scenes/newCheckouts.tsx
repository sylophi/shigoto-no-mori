// The two ways something new lands on a device: the New worktree page
// (from a pull request, and branched off a source) over shigoto-no-mori's
// fixtures, and the Add project dialog's three tabs with the stages
// between them.
import { createRef, type ReactNode } from "react";
import { FolderGit2, FolderPlus } from "lucide-react";
import {
  AddProjectHeaderView,
  AddProjectNoDeviceView,
  type AddProjectMode,
} from "@shigomori/ui/views/AddProjectModalView.tsx";
import { AddExistingFormView } from "@shigomori/ui/views/addProject/AddExistingFormView.tsx";
import { CloneFormView } from "@shigomori/ui/views/addProject/CloneFormView.tsx";
import { CreateFormView } from "@shigomori/ui/views/addProject/CreateFormView.tsx";
import { ProgressPanelView } from "@shigomori/ui/views/addProject/DialogPartsView.tsx";
import { ResultsPanelView } from "@shigomori/ui/views/addProject/ResultsPanelView.tsx";
import { ScanningPanelView } from "@shigomori/ui/views/addProject/ScanningPanelView.tsx";
import { TerrierOptInView } from "@shigomori/ui/views/addProject/TerrierOptInView.tsx";
import {
  NewWorktreeBodyView,
  NewWorktreeFormView,
} from "@shigomori/ui/views/newWorktree/NewWorktreeView.tsx";
import { PullRequestSourceView } from "@shigomori/ui/views/newWorktree/PullRequestPickerView.tsx";
import { BranchComboboxView } from "@shigomori/ui/views/shared/BranchComboboxView.tsx";
import { DeviceTabBarView } from "@shigomori/ui/views/shared/DeviceTabBarView.tsx";
import { ProjectDevicePageView } from "@shigomori/ui/views/shared/ProjectDevicePageView.tsx";
import {
  VillagerFaceView,
  VillagerSaysView,
} from "@shigomori/ui/views/shared/VillagerSaysView.tsx";
import { ModalBox } from "@shigomori/ui/primitives/modal-shell.tsx";
import type { Worktree } from "@shigomori/contracts/schemas";
import {
  forests,
  LOCAL_DEVICE_ID,
  MINI_ID,
  THINKPAD_ID,
} from "../fake-host/fixtures";
import { fakePullRequestCandidates } from "../fake-host/pullRequestFixtures";
import { SceneDialog, SceneWindowFrame } from "./frame";
import { SceneSidebar } from "./sidebar";
import { deviceTabs, FACE, projectNamed } from "./world";

const noop = () => {};
const HOME = "/Users/rin";
const DEV = `${HOME}/dev`;
const SM = projectNamed(LOCAL_DEVICE_ID, "shigoto-no-mori");
const WORKTREES: Worktree[] = forests[LOCAL_DEVICE_ID]?.worktrees[SM.id] ?? [];
const WORKTREE_BY_BRANCH = new Map(WORKTREES.map((w) => [w.branch, w]));
const DEST_ROOT = `${HOME}/.sm/worktrees/shigoto-no-mori`;
const CANDIDATES = fakePullRequestCandidates();
const DEVICE_TABS = deviceTabs([LOCAL_DEVICE_ID, THINKPAD_ID, MINI_ID]);

function newWorktreePage(form: ReactNode) {
  return (
    <SceneWindowFrame
      sidebar={<SceneSidebar view="projects" open />}
      pathname="/projects"
    >
      <ProjectDevicePageView
        projectName={SM.name}
        title="New worktree"
        tabs={
          <DeviceTabBarView
            tabs={DEVICE_TABS}
            selectedId={LOCAL_DEVICE_ID}
            onSelect={noop}
          />
        }
        terrier
        showAllDevices={false}
        body={<NewWorktreeBodyView>{form}</NewWorktreeBodyView>}
      />
    </SceneWindowFrame>
  );
}

// What every form here shares but its source and its folder.
const FORM = {
  onMode: noop,
  prOptionOff: undefined,
  busy: false,
  deviceLabel: "MacBook",
  base: "main",
  checkoutBranch: "main",
  baseHolder: undefined,
  onBranchName: noop,
  branchTaken: false,
  onPrFolder: noop,
  onUseSourceName: noop,
  worktreeName: "",
  onWorktreeName: noop,
  folderTaken: false,
  folderPlaceholder: "sheldon",
  cloneFiles: true,
  onCloneFiles: noop,
  errorMessage: null,
  onSubmit: noop,
  onCancel: noop,
};

const branchPicker = (
  <BranchComboboxView
    id="branch-base"
    branches={{ local: ["main"], remote: ["origin/main"] }}
    fetching={false}
    onOpen={noop}
    value="main"
    onChange={noop}
    placeholder="main"
  />
);

// The page on a pull request, its list from the fixtures and one picked.
export function NewWorktreeScene() {
  const selected = CANDIDATES[0] ?? null;
  const folder = selected?.headRefName ?? "";
  return newWorktreePage(
    <NewWorktreeFormView
      {...FORM}
      mode="pull-request"
      sourcePicker={branchPicker}
      prSource={
        <PullRequestSourceView
          query={{
            isPending: false,
            isError: false,
            data: { status: "ok", pullRequests: CANDIDATES },
          }}
          unavailableText={undefined}
          selected={selected}
          onSelect={noop}
          worktreeByBranch={WORKTREE_BY_BRANCH}
        />
      }
      branchName=""
      useBranchAsFolder
      prFolderFrom="branch"
      folderName={folder}
      folderSourceRaw={folder}
      destPath={`${DEST_ROOT}/${folder}`}
      villager={null}
      canSubmit
    />,
  );
}

// The page branching off main, into a folder a villager moves into.
export function NewWorktreeBranchScene() {
  return newWorktreePage(
    <NewWorktreeFormView
      {...FORM}
      mode="branch-from"
      sourcePicker={branchPicker}
      prSource={null}
      branchName="sheldon"
      useBranchAsFolder
      prFolderFrom="branch"
      folderName="sheldon"
      folderSourceRaw="sheldon"
      destPath={`${DEST_ROOT}/sheldon`}
      villager={
        <>
          {" "}
          <VillagerFaceView
            face={FACE}
            className="-my-1 mr-1 size-5 align-middle"
          />
          <VillagerSaysView
            line={{
              lead: "Sheldon is moving in",
              tail: ", cardio!",
              speaker: "Sheldon",
            }}
          />
        </>
      }
      canSubmit
    />,
  );
}

const terrierOptIn = (
  <TerrierOptInView checked={false} onCheckedChange={noop} />
);

function addProject(mode: AddProjectMode, body: ReactNode) {
  return (
    <>
      <AddProjectHeaderView
        mode={mode}
        onMode={noop}
        tabs={
          <DeviceTabBarView
            tabs={DEVICE_TABS}
            selectedId={LOCAL_DEVICE_ID}
            onSelect={noop}
            className="px-3 phone:px-3"
          />
        }
      />
      {body}
    </>
  );
}

const FOLDERS = [
  { name: "dotfiles", isGitRepo: true },
  { name: "kawaii-cam", isGitRepo: true },
  { name: "notes", isGitRepo: false },
  { name: "shigoto-no-mori", isGitRepo: true },
  { name: "sketches", isGitRepo: false },
];

// The dialog on its first tab, browsing ~/dev.
export function AddProjectScene() {
  return (
    <SceneWindowFrame
      sidebar={<SceneSidebar view="projects" open />}
      pathname="/projects"
      overlays={
        <SceneDialog>
          {addProject(
            "existing",
            <AddExistingFormView
              query="~/dev/"
              onQuery={noop}
              onInputKeyDown={noop}
              highlighted="browse:~/dev/kawaii-cam"
              onHighlight={noop}
              browseDir="~/dev/"
              entries={FOLDERS}
              registeredNames={new Set(["shigoto-no-mori"])}
              isLoading={false}
              hasListing
              error={null}
              leafFilter=""
              targetIsGitRepo={false}
              canPrimary
              pending={false}
              onPrimary={noop}
              canBrowseUp
              onBrowseUp={noop}
              onBrowseTo={noop}
              onAdd={noop}
              terrierOptIn={terrierOptIn}
              onPickFolder={noop}
            />,
          )}
        </SceneDialog>
      }
    />
  );
}

// Its other tabs and stages, each in its own box.
export function AddProjectPartsScene() {
  const inputRef = createRef<HTMLInputElement>();
  return (
    <div className="grid grid-cols-2 items-start gap-6 p-6">
      <ModalBox>
        {addProject(
          "clone",
          <CloneFormView
            url="sylophi/"
            onUrl={noop}
            inputRef={inputRef}
            highlighted="sylophi/kawaii-cam"
            onHighlight={noop}
            rows={["sylophi/kawaii-cam", "sylophi/dotfiles", "sylophi/notes"]}
            typedRow={false}
            repo="sylophi/kawaii-cam"
            canClone
            onClone={noop}
            dest={`${DEV}/kawaii-cam`}
            onChangeParent={noop}
            terrierOptIn={terrierOptIn}
            picker={null}
          />,
        )}
      </ModalBox>
      <ModalBox>
        {addProject(
          "create",
          <CreateFormView
            name="mori-garden"
            onName={noop}
            inputRef={inputRef}
            canCreate
            onCreate={noop}
            dest={`${DEV}/mori-garden`}
            onChangeParent={noop}
            ghUnavailable={null}
            publish
            onPublish={noop}
            owners={["sylophi", "mori-labs"]}
            owner="sylophi"
            onOwner={noop}
            visibility="private"
            onVisibility={noop}
            terrierOptIn={terrierOptIn}
            picker={null}
          />,
        )}
      </ModalBox>
      <ModalBox>
        <ScanningPanelView scanRoot={DEV} home={HOME} onCancel={noop} />
      </ModalBox>
      <ModalBox>
        <ResultsPanelView
          scanRoot={DEV}
          home={HOME}
          results={[`${DEV}/dotfiles`, `${DEV}/kawaii-cam`, `${DEV}/work/api`]}
          selected={new Set([`${DEV}/kawaii-cam`])}
          highlighted={`result:${DEV}/kawaii-cam`}
          onHighlightChange={noop}
          onToggle={noop}
          onSelectAll={noop}
          onSelectNone={noop}
          onBack={noop}
          onAdd={async () => {}}
          bulkAdding={false}
          onKeyDown={noop}
          terrierOptIn={terrierOptIn}
        />
      </ModalBox>
      <ModalBox>
        <ProgressPanelView
          icon={<FolderGit2 className="size-4 text-muted-foreground/80" />}
          title="sylophi/kawaii-cam"
          status="Cloning…"
          dest={`${DEV}/kawaii-cam`}
        />
      </ModalBox>
      <ModalBox>
        <ProgressPanelView
          icon={<FolderPlus className="size-4 text-muted-foreground/80" />}
          title="mori-garden"
          status="Creating the repository…"
          dest={`${DEV}/mori-garden`}
        />
      </ModalBox>
      <ModalBox>
        {addProject("existing", <AddProjectNoDeviceView signedIn={false} />)}
      </ModalBox>
    </div>
  );
}
