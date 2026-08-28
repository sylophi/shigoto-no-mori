// The web client's root layout: a slim top bar with the app identity,
// the signed-in navigation, and the routed page in a doubutsu "main"
// zone so the reused renderer pages (RemoteForest and friends) get the
// same overlay chrome they get inside the desktop's detail pane. Built
// in v1 vocabulary (theme tokens only), per the theming contract.
import { Outlet, useLocation } from "@tanstack/react-router";
import { MonitorSmartphone, Palette, TreePine } from "lucide-react";
import { ClerkSignOutButton } from "@/components/account/ClerkSignOutButton";
import { Button } from "@/components/ui/button";
import {
  useAccountStatus,
  useWatchAccountChanges,
} from "@/hooks/account/useAccount";
import { cn } from "@/lib/utils";
import { navigateTo, redirectTo, webPaths } from "./nav";

function NavButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="sm"
      onClick={onClick}
      className={cn(!active && "text-muted-foreground")}
    >
      {children}
    </Button>
  );
}

export function WebShell() {
  useWatchAccountChanges();
  const { data: status } = useAccountStatus();
  const { pathname } = useLocation();
  const signedIn = status?.signedIn === true;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-4 py-2">
        <TreePine className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium tracking-tight">
          Shigoto no Mori
        </span>
        <span className="text-xs text-muted-foreground">web</span>
        <nav className="ml-4 flex items-center gap-1">
          {signedIn && (
            <NavButton
              active={pathname === webPaths.devices}
              onClick={() => navigateTo(webPaths.devices)}
            >
              <MonitorSmartphone />
              Devices
            </NavButton>
          )}
          <NavButton
            active={pathname === webPaths.appearance}
            onClick={() => navigateTo(webPaths.appearance)}
          >
            <Palette />
            Appearance
          </NavButton>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {/* Enrolled implies configured, so the provider is mounted
              and the Clerk hook inside the button is safe. */}
          {signedIn && (
            <ClerkSignOutButton
              className="text-muted-foreground"
              // replace, not push: the status invalidation may already
              // have bounced this page to /login, and a pushed second
              // /login entry would trap the Back button.
              onSignedOut={() => redirectTo(webPaths.login)}
            />
          )}
        </div>
      </header>
      <main
        data-doubutsu-zone="main"
        className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background"
      >
        <Outlet />
      </main>
    </div>
  );
}
