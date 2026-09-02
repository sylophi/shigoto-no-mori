// The web client's sidebar: the browser twin of the desktop's
// sidebar/Sidebar.tsx, built from the desktop's own chrome -- the
// SidebarHeader brand (browser chrome, "web" badge), the shared footer
// bar and nav cluster, and the desktop's buildSidebarRows + SidebarList
// with no local projects, so the merged tree renders exactly as it does
// in the app. Here every worktree is remote, so every row carries its
// device marker.
import { useRef, type RefObject } from "react";
import { LogOut } from "lucide-react";
import { buildSidebarRows } from "@/components/sidebar/buildSidebarRows";
import { SidebarEmptyState } from "@/components/sidebar/Sidebar";
import { SidebarHeader } from "@/components/sidebar/SidebarHeader";
import { SidebarList } from "@/components/sidebar/SidebarList";
import { SidebarNavActions } from "@/components/sidebar/SidebarNavActions";
import {
  SIDEBAR_FOOTER_BAR,
  SIDEBAR_ICON_BUTTON,
} from "@/components/sidebar/sidebarChrome";
import type { RowHandlers } from "@/components/sidebar/VirtualRow";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useAccountStatus } from "@/hooks/account/useAccount";
import { useClerkSignOut } from "@/hooks/account/useClerkAccount";
import { useFanOutErrorToast } from "@/components/sidebar/useFanOutErrorToast";
import { useRemoteForests } from "@/hooks/remote/useRemoteForests";
import { cn } from "@/lib/utils";
import { redirectTo, webPaths } from "./nav";

export function WebSidebar() {
  const { data: status } = useAccountStatus();
  const signedIn = status?.signedIn === true;
  const viewportRef = useRef<HTMLDivElement | null>(null);

  return (
    <aside
      data-sidebar
      data-doubutsu-zone="sidebar"
      className="flex h-full flex-col"
    >
      <SidebarHeader windowChrome={false} badge="web" />
      <div className="min-h-0 flex-1">
        <ScrollArea className="size-full" viewportRef={viewportRef}>
          {signedIn ? (
            <WebForest viewportRef={viewportRef} />
          ) : (
            <SidebarEmptyState message="Sign in to reach this account's devices." />
          )}
        </ScrollArea>
      </div>
      <WebSidebarFooter signedIn={signedIn} />
    </aside>
  );
}

// The tree has no local half here, so none of the local-row handlers
// can ever be called, and stable no-ops keep SidebarList's props inert.
const NO_LOCAL_HANDLERS: RowHandlers = {
  onToggle: () => {},
  onToggleShelved: () => {},
  onToggleShelf: () => {},
  arrangeMode: false,
};
const NO_COLLAPSED = new Set<string>();

function WebForest({
  viewportRef,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const { items, loading } = useRemoteForests();
  const view = buildSidebarRows({
    projects: [],
    worktreeQueries: [],
    collapsed: NO_COLLAPSED,
    shelvedExpanded: NO_COLLAPSED,
    arrangeMode: false,
    remote: items,
  });
  // Failed remote listings surface here exactly as on the desktop --
  // without it a peer's project would silently vanish from the tree.
  useFanOutErrorToast(view.failedCount);
  if (view.rows.length === 0) {
    // Loading and empty are different answers: a slow device hub must
    // not read as "no projects".
    return (
      <SidebarEmptyState
        message={
          loading
            ? "Loading forests…"
            : "No reachable devices with projects yet. Open the Devices page to see this account's machines."
        }
      />
    );
  }
  return (
    <SidebarList
      rows={view.rows}
      revealKey={view.revealKey}
      viewportRef={viewportRef}
      handlers={NO_LOCAL_HANDLERS}
    />
  );
}

// The desktop footer's app-level actions, in the web's vocabulary: the
// shared nav cluster plus (signed in) sign out. Signed in implies
// enrolled implies configured, so the Clerk hook inside the sign-out
// button only mounts under a mounted provider.
function WebSidebarFooter({ signedIn }: { signedIn: boolean }) {
  return (
    <div className={SIDEBAR_FOOTER_BAR}>
      {signedIn && <SignOutIconButton />}
      <div className="flex-1" />
      <SidebarNavActions devicesEnabled={signedIn} />
    </div>
  );
}

function SignOutIconButton() {
  const signOut = useClerkSignOut();
  return (
    <SimpleTooltip tip="Sign out">
      <button
        type="button"
        aria-label="Sign out"
        disabled={signOut.isPending}
        onClick={() =>
          signOut.mutate(undefined, {
            // replace, not push: the status invalidation may already have
            // bounced the page to /login, and a pushed second /login
            // entry would trap the Back button.
            onSuccess: () => redirectTo(webPaths.login),
          })
        }
        className={cn(SIDEBAR_ICON_BUTTON, "disabled:opacity-50")}
      >
        <LogOut className="size-3.5" />
      </button>
    </SimpleTooltip>
  );
}
