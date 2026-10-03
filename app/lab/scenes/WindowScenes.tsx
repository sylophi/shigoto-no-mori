// The whole windows the marketing site shows: a sidebar scene and a
// page scene in the app's window (AppWindowScene). Each fills the box
// it is given (h-full), which the site sizes as the window it draws:
// 1280x800 on the desktop, 390x844 on a phone. They pose as a release
// build, without the lab's dev marks on the brand header.
import { ForestPageView } from "@/components/ForestPageView";
import { AppWindowScene } from "./AppWindowScene";
import { WorktreeDetailPane } from "./DetailScene";
import { DevicesPane } from "./DevicesScene";
import { LabSidebar, NewWorktreeMenuOverlay } from "./SidebarScenes";

const MAIN_CHECKOUT = "5a0000000001";
const HAPPY_HUMMINGBIRD = "5a0000000002";
const BRAVE_BADGER = "5a0000000003";

// The inbox, on happy-hummingbird's page: its PR open, checks passed,
// ready to merge.
export function HeroWindowScene() {
  return (
    <AppWindowScene
      className="h-full"
      sidebar={
        <LabSidebar view="inbox" selected={HAPPY_HUMMINGBIRD} dev={false} />
      }
    >
      <WorktreeDetailPane worktreeId={HAPPY_HUMMINGBIRD} />
    </AppWindowScene>
  );
}

// The tree inside shigoto-no-mori, on brave-badger's page: its PR
// merged, the bottom of a stack of three.
export function StackWindowScene() {
  return (
    <AppWindowScene
      className="h-full"
      sidebar={
        <LabSidebar view="projects" selected={BRAVE_BADGER} dev={false} />
      }
    >
      <WorktreeDetailPane worktreeId={BRAVE_BADGER} />
    </AppWindowScene>
  );
}

// The inbox on the main checkout's page with the New worktree menu
// open under its button, placed within the window (relative).
export function CreateWindowScene() {
  return (
    <AppWindowScene
      className="relative h-full"
      sidebar={
        <LabSidebar
          view="inbox"
          selected={MAIN_CHECKOUT}
          newWorktreeMenu
          dev={false}
        />
      }
      overlays={<NewWorktreeMenuOverlay />}
    >
      <WorktreeDetailPane worktreeId={MAIN_CHECKOUT} />
    </AppWindowScene>
  );
}

// The Devices page, beside the tree with nothing open in it.
export function DevicesWindowScene() {
  return (
    <AppWindowScene
      className="h-full"
      sidebar={
        <LabSidebar
          view="projects"
          selected={null}
          activePath="/devices"
          dev={false}
        />
      }
    >
      <DevicesPane />
    </AppWindowScene>
  );
}

// The web shell on a phone: the inbox tab, over the tab bar.
export function PhoneWindowScene() {
  return (
    <AppWindowScene shell="web" phone className="h-full">
      <ForestPageView>
        <LabSidebar shell="web" view="inbox" footer={false} dev={false} />
      </ForestPageView>
    </AppWindowScene>
  );
}
