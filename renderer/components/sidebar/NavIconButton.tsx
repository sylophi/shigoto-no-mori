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
// `exact` off matches a path prefix, for a button whose page owns
// sub-routes (Devices also claims a device's forest).
export function NavIconButton({
  to,
  tip,
  label,
  exact = true,
  children,
}: {
  to: NavigateOptions["to"];
  tip: string;
  label: string;
  exact?: boolean;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const active = exact
    ? location.pathname === to
    : location.pathname.startsWith(to ?? "");
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
