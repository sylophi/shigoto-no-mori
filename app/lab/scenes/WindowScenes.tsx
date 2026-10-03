// The whole windows: a sidebar and a page in the app's window
// (LabWindow), on the desktop or on a phone.
import { ForestPageView } from "@/components/ForestPageView";
import {
  BRAVE_BADGER_ID,
  HAPPY_HUMMINGBIRD_ID,
  MAIN_CHECKOUT_ID,
} from "../fixtures";
import { DevicesPane } from "./DevicesPane";
import { LabSidebar, NewWorktreeMenuOverlay } from "./LabSidebar";
import { LabWindow } from "./LabWindow";
import { WorktreeDetailPane } from "./WorktreeDetailPane";

// The inbox, on happy-hummingbird's page: its PR open, checks passed,
// ready to merge.
export function HeroWindowScene() {
  return (
    <LabWindow
      sidebar={<LabSidebar view="inbox" selected={HAPPY_HUMMINGBIRD_ID} />}
    >
      <WorktreeDetailPane worktreeId={HAPPY_HUMMINGBIRD_ID} />
    </LabWindow>
  );
}

// The tree inside shigoto-no-mori, on brave-badger's page: its PR
// merged, the bottom of a stack of three.
export function StackWindowScene() {
  return (
    <LabWindow
      sidebar={<LabSidebar view="projects" selected={BRAVE_BADGER_ID} />}
    >
      <WorktreeDetailPane worktreeId={BRAVE_BADGER_ID} />
    </LabWindow>
  );
}

// The inbox on the main checkout's page with the New worktree menu
// open under its button, the Thinkpad's projects among its targets.
export function CreateWindowScene() {
  return (
    <LabWindow
      sidebar={
        <LabSidebar view="inbox" selected={MAIN_CHECKOUT_ID} newWorktreeMenu />
      }
      overlays={<NewWorktreeMenuOverlay />}
    >
      <WorktreeDetailPane worktreeId={MAIN_CHECKOUT_ID} />
    </LabWindow>
  );
}

// The Devices page, beside the tree with nothing open in it.
export function DevicesWindowScene() {
  return (
    <LabWindow sidebar={<LabSidebar view="projects" activePath="/devices" />}>
      <DevicesPane />
    </LabWindow>
  );
}

// The web shell on a phone: the inbox tab, every forest a peer of the
// browser, over the tab bar.
export function PhoneWindowScene() {
  return (
    <LabWindow shell="web" phone>
      <ForestPageView>
        <LabSidebar shell="web" view="inbox" footer={false} />
      </ForestPageView>
    </LabWindow>
  );
}
