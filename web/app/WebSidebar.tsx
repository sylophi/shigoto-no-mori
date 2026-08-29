// The web client's sidebar: the browser twin of the desktop's
// sidebar/Sidebar.tsx, carrying the same chrome contract (data-sidebar
// token overrides, the doubutsu "sidebar" zone, the brand header with
// both themes' markup side by side, a scrollable list over a footer of
// nav icon buttons). The list IS the desktop's: buildSidebarRows +
// SidebarList with no local projects, so the merged tree renders
// exactly as it does in the app -- here every worktree is remote, so
// every row carries its device marker.
import { useRef, type RefObject } from "react";
import {
  LogOut,
  MonitorSmartphone,
  Settings as SettingsIcon,
} from "lucide-react";
import { buildSidebarRows } from "@/components/sidebar/buildSidebarRows";
import { NavIconButton } from "@/components/sidebar/NavIconButton";
import { SidebarList } from "@/components/sidebar/SidebarList";
import { SIDEBAR_ICON_BUTTON } from "@/components/sidebar/sidebarChrome";
import type { RowHandlers } from "@/components/sidebar/VirtualRow";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useAccountStatus } from "@/hooks/account/useAccount";
import { useClerkSignOut } from "@/hooks/account/useClerkAccount";
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
      <WebSidebarHeader />
      <div className="min-h-0 flex-1">
        <ScrollArea className="size-full" viewportRef={viewportRef}>
          {signedIn ? (
            <WebForest viewportRef={viewportRef} />
          ) : (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              Sign in to reach this account&apos;s devices.
            </p>
          )}
        </ScrollArea>
      </div>
      <WebSidebarFooter signedIn={signedIn} />
    </aside>
  );
}

// The tree has no local half here, so none of the local-row handlers
// can ever be called; stable no-ops keep SidebarList's props inert.
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
  const remote = useRemoteForests();
  const view = buildSidebarRows({
    projects: [],
    worktreeQueries: [],
    collapsed: NO_COLLAPSED,
    shelvedExpanded: NO_COLLAPSED,
    arrangeMode: false,
    remote,
  });
  if (view.rows.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs text-muted-foreground">
        No reachable devices with projects yet. Open the Devices page to see
        this account&apos;s machines.
      </p>
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

// The desktop SidebarHeader's two-theme brand, minus its window chrome
// (drag regions, the traffic-light inset): a browser tab has neither.
// The dev sticker slot instead marks this build as the web client. Both
// headers always render; `doubutsu-only` / `v1-only` pick which shows,
// exactly like the desktop component (a JS theme branch would fork the
// markup per theme and be invisible to `pnpm theme:check`).
function WebSidebarHeader() {
  return (
    <>
      <div className="doubutsu-only relative mx-3 mt-3 mb-2 overflow-hidden rounded-2xl bg-card px-5 pt-4 pb-5">
        <h1 className="relative z-[1] text-[28px] leading-none font-black tracking-tight text-foreground">
          仕事の森
        </h1>
        <span className="relative z-[1] mt-1.5 block text-[12px] font-bold text-muted-foreground">
          Shigoto no Mori
        </span>
        <span className="absolute top-3 right-3 z-[2] -rotate-6 rounded-full bg-secondary px-2 py-[3px] text-[10px] leading-none font-black tracking-widest text-secondary-foreground uppercase">
          web
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute -right-4 -bottom-10 text-[140px] leading-none font-black text-[var(--doubutsu-watermark)] opacity-15 select-none"
        >
          森
        </span>
      </div>
      <div className="v1-only flex h-[52px] items-center gap-2 px-4">
        <div className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">
          Shigoto no Mori
        </div>
        <span className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[9px] leading-none font-medium tracking-widest text-muted-foreground uppercase">
          web
        </span>
      </div>
    </>
  );
}

// The desktop footer's app-level actions, in the web's vocabulary: the
// devices page, this browser's settings, and (signed in) sign out.
// Signed in implies enrolled implies configured, so the Clerk hook
// inside the sign-out button only mounts under a mounted provider.
function WebSidebarFooter({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
      {signedIn && <SignOutIconButton />}
      <div className="flex-1" />
      {signedIn && (
        // Prefix match: a device's forest belongs to the same "your
        // machines" surface this button opens, as on the desktop.
        <NavIconButton
          to="/devices"
          tip="Devices"
          label="Devices"
          exact={false}
        >
          <MonitorSmartphone className="size-3.5" />
        </NavIconButton>
      )}
      <NavIconButton to="/settings" tip="Settings" label="Settings">
        <SettingsIcon className="size-3.5" />
      </NavIconButton>
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
