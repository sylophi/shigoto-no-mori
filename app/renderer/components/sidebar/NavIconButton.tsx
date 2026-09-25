import type React from "react";
import {
  useLocation,
  useNavigate,
  type NavigateOptions,
} from "@tanstack/react-router";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SIDEBAR_ICON_BUTTON } from "./sidebarChrome";

// One shape for the sidebar's route buttons (tidy, devices, settings):
// tooltip, icon, active highlight derived from the current location.
// The match is exact: /devices/$deviceId/... is a peer's WORKTREE, which
// is meant to read as ordinary work rather than as a device page, so it
// must not light this button any more than its local twin does.
export function NavIconButton({
  to,
  tip,
  label,
  children,
}: {
  to: NavigateOptions["to"];
  tip: string;
  label: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const active = location.pathname === to;
  return (
    <SimpleTooltip tip={tip}>
      <button
        type="button"
        onClick={() => void navigate({ to })}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={cn(
          SIDEBAR_ICON_BUTTON,
          "relative",
          active && "bg-accent text-foreground",
        )}
      >
        {children}
      </button>
    </SimpleTooltip>
  );
}
